import Database from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  atomicQuestions,
  type ComparisonSnapshot,
  type DuplicateInput,
  type EmbeddingBackend,
} from "@/server/duplicates/types";
import {
  copyFingerprint,
  DIMENSION,
  noSpaceLength,
  splitBlocks,
  localEmbeddings,
  MODEL_REVISION,
} from "@/server/duplicates/embedding";
import {
  judgeRequest,
  jevJudge,
  timedJudge,
  validateJudgment,
} from "@/server/duplicates/judge";
import { JevBudget } from "@/server/jev-budget";

const external = vi.hoisted(() => ({
  pipeline: vi.fn(),
  extract: vi.fn(),
  tokenize: vi.fn(),
  llm: vi.fn(),
}));
vi.mock("@huggingface/transformers", () => ({ pipeline: external.pipeline }));
vi.mock("@/server/duplicates/llm", () => ({ judgeWithLlm: external.llm }));

let module: typeof import("@/server/duplicates");
beforeAll(async () => {
  process.env.DATABASE_PATH = ":memory:";
  module = await import("@/server/duplicates");
});
const stores: Database.Database[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("isolated HTTP fixtures", () => {
  it.each([
    { mode: "production", path: "C:/repo/data/e2e-abcd-pass.sqlite" },
    { mode: "development", path: "C:/repo/data/forum.sqlite" },
    { mode: "development", path: "C:/repo/data/production/forum.sqlite" },
  ])(
    "cannot bypass assessment outside an isolated fixture: %o",
    async ({ mode, path }) => {
      vi.stubEnv("NODE_ENV", mode);
      vi.stubEnv("DATABASE_PATH", path);
      vi.stubEnv("DUPLICATE_MOCK", "distinct");
      const result = await module.assessDuplicate({
        title: "",
        body: "",
        tags: [],
      });
      expect(result.verdict).toBe("uncertain");
      expect(result.evidence).not.toContain("isolated-http-fixture");
    },
  );
});
const vector = (index = 0) =>
  Array.from({ length: DIMENSION }, (_, i) => (i === index ? 1 : 0));
const backend = (version = "synthetic-v1"): EmbeddingBackend => ({
  version,
  tokenCount: vi.fn(async (text: string) => Math.ceil(text.length / 1.4)),
  embed: vi.fn(async (texts: string[]) =>
    texts.map((t) =>
      vector(t.includes("ALPHA") ? 0 : t.includes("BETA") ? 1 : 2),
    ),
  ),
});
const input = (
  body = "NEW describes the code and behavior.",
  title = "Analysis",
): DuplicateInput => ({ title, body, tags: ["reversing"] });
function store() {
  const s = new Database(":memory:");
  stores.push(s);
  s.exec(
    "CREATE TABLE posts(id TEXT PRIMARY KEY,title TEXT,body TEXT,tags TEXT,status TEXT)",
  );
  return s;
}
function post(
  s: Database.Database,
  id: string,
  body: string,
  status = "published",
  title = "Analysis",
) {
  s.prepare("INSERT INTO posts VALUES(?,?,?,?,?)").run(
    id,
    title,
    body,
    '["reversing"]',
    status,
  );
}
function choice(value: string) {
  return {
    type: "choice",
    choice: value,
    confidence: 0.99,
    probabilities: {
      yes: value === "yes" ? 0.98 : 0.01,
      no: value === "no" ? 0.98 : 0.01,
      uncertain: value === "uncertain" ? 0.98 : 0.01,
    },
  };
}
function judgment(
  snapshot: ComparisonSnapshot,
  overrides: Record<string, string> = {},
  covered: (i: number) => string = () => "yes",
) {
  const defaults: Record<string, string> = {
    sameconditions: "yes",
    new_evidence: "no",
    correction: "no",
    answer_fulfills: "no",
    novel_synthesis: "no",
    no_meaningful_novelty: "yes",
    related_topic: "yes",
  };
  return {
    answers: Object.fromEntries([
      ...atomicQuestions.map((name) => [
        name,
        choice(overrides[name] ?? defaults[name]),
      ]),
      ...snapshot.blocks.map((_, i) => [`coverage_${i}`, choice(covered(i))]),
      ...snapshot.candidates.map((_, i) => [
        `related_${i}`,
        choice(overrides.related_topic === "no" ? "no" : "yes"),
      ]),
    ]),
  };
}
function detector(
  s: Database.Database,
  judge = async (snapshot: ComparisonSnapshot) => judgment(snapshot),
  embeddings = backend(),
) {
  return module.createDuplicateDetector({
    store: s,
    testOnly: { embeddings, judge },
  });
}

describe("bounded duplicate assessment", () => {
  it("uses an independent full-text judge for an appeal even when the first atomic judge would block", async () => {
    const s = store();
    post(s, "old", "ALPHA old observations");
    const judge = vi.fn(async (snapshot: ComparisonSnapshot) =>
      judgment(snapshot),
    );
    const d = module.createDuplicateDetector({
      store: s,
      testOnly: { embeddings: backend(), judge },
    });
    external.llm.mockResolvedValue({
      verdict: "overlap",
      relatedPostIds: ["old"],
      evidence: "Synthetic correction adds a useful new conclusion.",
    });
    const result = await d.assessDuplicate(
      input("ALPHA corrected observations with new evidence"),
      { independentReview: true },
    );
    expect(result.verdict).toBe("overlap");
    expect(judge).not.toHaveBeenCalled();
    expect(external.llm.mock.calls.at(-1)?.[1]).toEqual({
      independentReview: true,
    });
    expect(external.llm.mock.calls.at(-1)?.[0].candidates).toEqual([
      expect.objectContaining({ id: "old", body: "ALPHA old observations" }),
    ]);
  });
  it("lazily loads one pinned local-only fp32 CPU pipeline and prevents pipeline truncation", async () => {
    external.tokenize.mockImplementation((text: string) => ({
      input_ids: { size: text.length },
    }));
    external.extract.mockImplementation(async (texts: string[]) => ({
      tolist: () => texts.map(() => vector()),
    }));
    external.pipeline.mockResolvedValue(
      Object.assign(external.extract, { tokenizer: external.tokenize }),
    );
    const [one, two] = await Promise.all([
      localEmbeddings(),
      localEmbeddings(),
    ]);
    expect(one).toBe(two);
    expect(external.pipeline).toHaveBeenCalledOnce();
    expect(external.pipeline).toHaveBeenCalledWith(
      "feature-extraction",
      "Xenova/multilingual-e5-small",
      expect.objectContaining({
        revision: MODEL_REVISION,
        dtype: "fp32",
        device: "cpu",
        local_files_only: true,
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
      }),
    );
    expect(
      external.pipeline.mock.calls[0][2].cache_dir.replaceAll("\\", "/"),
    ).toMatch(/data\/duplicates\/models$/);
    await one.embed(["passage: cmp EAX, 0x10"]);
    expect(external.extract).toHaveBeenCalledWith(["passage: cmp EAX, 0x10"], {
      pooling: "mean",
      normalize: true,
    });
    const calls = external.extract.mock.calls.length;
    await expect(one.embed(["x".repeat(513)])).rejects.toThrow(
      "embedding-token-limit",
    );
    expect(external.extract.mock.calls.length).toBe(calls);
  });

  it("adapts the parent-owned full-text CLI fallback contract without unpaid real calls", async () => {
    const s = store();
    post(s, "old", "ALPHA old analysis");
    external.llm.mockResolvedValue({
      verdict: "duplicate",
      relatedPostIds: ["old"],
      evidence: "Private full-comparison proof from the synthetic adapter.",
    });
    // Guaranteed Jev unavailability takes the real production fallback branch, but imported tools are test mocks.
    vi.stubEnv("JEV_BUDGET_USD", "");
    const d = module.createDuplicateDetector({ store: s });
    const result = await d.assessDuplicate(input("ALPHA new wording"));
    expect(result.verdict).toBe("duplicate");
    expect(result.corpusHash).toBe(d.publicCorpusHash());
    expect(external.llm.mock.calls.at(-1)![0]).toMatchObject({
      newPost: input("ALPHA new wording"),
      candidates: [{ id: "old", ...input("ALPHA old analysis") }],
      matches: { corpusHash: d.publicCorpusHash() },
    });
    external.llm.mockResolvedValue({
      verdict: "distinct",
      relatedPostIds: ["private-not-a-candidate"],
      evidence: "Invalid adapter result",
    });
    const invalid = await d.assessDuplicate(input("ALPHA more new wording"));
    expect(invalid.verdict).toBe("uncertain");
    expect(invalid.relatedPostIds).toEqual([]);
    external.llm.mockRejectedValue(new Error("adapter unavailable"));
    expect((await d.assessDuplicate(input("ALPHA failure case"))).verdict).toBe(
      "uncertain",
    );
  });
  it("exports the standard interface and exact public snapshot hash without model calls", async () => {
    const s = store();
    post(s, "old", "cmp EAX, 0x10\n jne Target");
    post(s, "private", "private", "held");
    const model = backend(),
      judge = vi.fn();
    const d = module.createDuplicateDetector({
      store: s,
      testOnly: { embeddings: model, judge },
    });
    const result = await d.assessDuplicate(input("cmp EAX, 0x10\n jne Target"));
    expect(result).toEqual({
      verdict: "duplicate",
      relatedPostIds: ["old"],
      evidence: "exact-copy",
      corpusHash: d.publicCorpusHash(),
    });
    expect(model.embed).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
    const hash = d.publicCorpusHash();
    s.prepare(
      "UPDATE posts SET body='changed private' WHERE id='private'",
    ).run();
    expect(d.publicCorpusHash()).toBe(hash);
    s.prepare("UPDATE posts SET title='public edit' WHERE id='old'").run();
    expect(d.publicCorpusHash()).not.toBe(hash);
    expect(module.publicCorpusHash()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("preserves constants, case, operators and internal code whitespace in fingerprints", () => {
    const code = "if (EAX == 0x10) {\n  return X;\n}";
    for (const changed of [
      code.replace("==", "!="),
      code.replace("0x10", "0x20"),
      code.replace("EAX", "eax"),
      code.replace("  return", " return"),
    ])
      expect(copyFingerprint(changed)).not.toBe(copyFingerprint(code));
    expect(copyFingerprint(code.replace(/\n/g, "\r\n"))).toBe(
      copyFingerprint(code),
    );
    expect(copyFingerprint(" " + code)).not.toBe(copyFingerprint(code));
  });

  it("token-verifies uneven blocks, code, no-space text and surrogate offsets without losing coverage", async () => {
    const model = backend();
    const value = input(
      "# Heading\n" + "A😀!=0x10".repeat(420) + "\n" + "tail".repeat(63),
    );
    const blocks = await splitBlocks(value, model);
    expect(blocks.length).toBeGreaterThan(5);
    expect(blocks.map((b) => b.text).join("")).toBe(value.body);
    expect(blocks[0].start).toBe(0);
    expect(blocks.at(-1)!.end).toBe(value.body.length);
    for (let i = 0; i < blocks.length; i++) {
      expect(
        await model.tokenCount(
          `passage: ${blocks[i].context}\n${blocks[i].text}`,
        ),
      ).toBeLessThanOrEqual(512);
      if (i) expect(blocks[i].start).toBe(blocks[i - 1].end);
    }
    expect(blocks.reduce((sum, b) => sum + b.weight, 0)).toBe(
      noSpaceLength(value.body),
    );
    expect(blocks.some((b) => b.context.includes("Heading"))).toBe(true);
  });

  it.each(["paraphrase", "reorder", "padding", "mosaic"])(
    "blocks a new-information-free %s only after full atomic judgment",
    async (variant) => {
      const s = store();
      post(s, "a", "ALPHA disassembly explains branch.");
      post(s, "b", "BETA debugger explains trace.");
      const bodies: Record<string, string> = {
        paraphrase: "The branch is explained through disassembly.",
        reorder: "Trace first, branch second.",
        padding:
          "A useful introduction. ".repeat(30) + "Same branch and trace.",
        mosaic: "Branch explanation from ALPHA, trace explanation from BETA.",
      };
      const judge = vi.fn(async (snapshot) => {
        expect(snapshot.input.body).toBe(bodies[variant]);
        expect(
          snapshot.candidates.map((c: { id: string }) => c.id).sort(),
        ).toEqual(["a", "b"]);
        expect(
          snapshot.candidates.map((c: { body: string }) => c.body).join("\n"),
        ).toContain("BETA debugger");
        return judgment(snapshot);
      });
      const result = await detector(s, judge).assessDuplicate(
        input(bodies[variant]),
      );
      expect(result.verdict).toBe("duplicate");
      expect(result.relatedPostIds.sort()).toEqual(["a", "b"]);
      expect(judge).toHaveBeenCalledOnce();
      const evidence = JSON.parse(result.evidence);
      expect(evidence.coverage.covered).toBe(evidence.coverage.total);
      expect(
        s.prepare("SELECT evidence FROM duplicate_evidence").get(),
      ).toBeTruthy();
    },
  );

  it("retrieves the union from every block rather than the longest/highest/average block", () => {
    const documents = Array.from({ length: 6 }, (_, i) => ({
      document: { id: `post-${i}`, ...input(`topic${i}`) },
      blocks: [{ start: 0, end: 6, text: `topic${i}`, context: "", weight: 6 }],
      vectors: [vector(i)],
    }));
    const ids = module.retrieveCandidateUnion(
      input("topic0 " + "z".repeat(9000) + " topic5"),
      [],
      [vector(0), vector(5)],
      documents,
    );
    expect(ids).toContain("post-0");
    expect(ids).toContain("post-5");
  });

  it("does not treat high cosine as block proof or auto-approve an uncovered short tail", async () => {
    const s = store();
    post(s, "old", "ALPHA old material");
    const value = input("ALPHA ".repeat(800) + "New: x != 0x20");
    const result = await detector(s, async (snapshot) =>
      judgment(snapshot, {}, (i) =>
        i === snapshot.blocks.length - 1 ? "no" : "yes",
      ),
    ).assessDuplicate(value);
    expect(result.verdict).toBe("uncertain");
    expect(JSON.parse(result.evidence).coverage.covered).toBeLessThan(
      JSON.parse(result.evidence).coverage.total,
    );
  });

  it.each(["new_evidence", "correction", "answer_fulfills", "novel_synthesis"])(
    "allows an actual %s alongside overlap",
    async (name) => {
      const s = store();
      post(s, "old", "ALPHA old branch analysis");
      const value = input(
        "ALPHA existing explanation ".repeat(32) +
          "New observation: EAX != 0x20.",
      );
      const result = await detector(s, async (snapshot) =>
        judgment(
          snapshot,
          { [name]: "yes", no_meaningful_novelty: "no" },
          (i) => (i ? "no" : "yes"),
        ),
      ).assessDuplicate(value);
      expect(result.verdict).toBe("overlap");
    },
  );

  it("allows materially changed conditions/constants without calling them a duplicate", async () => {
    const s = store();
    post(s, "old", "On x86, EAX == 0x10 branches to Target.");
    const judge = vi.fn(async (snapshot) => {
      expect(snapshot.input.body).toContain("x64");
      expect(snapshot.input.body).toContain("!= 0x20");
      expect(snapshot.candidates[0].body).toContain("== 0x10");
      return judgment(
        snapshot,
        { sameconditions: "no", no_meaningful_novelty: "no" },
        () => "no",
      );
    });
    expect(
      (
        await detector(s, judge).assessDuplicate(
          input("On x64, EAX != 0x20 branches to Other."),
        )
      ).verdict,
    ).toBe("related");
  });

  it("distinguishes an unrelated complete comparison", async () => {
    const s = store();
    post(s, "old", "PE branch inspection.");
    expect(
      (
        await detector(s, async (snapshot) =>
          judgment(
            snapshot,
            {
              sameconditions: "no",
              no_meaningful_novelty: "no",
              related_topic: "no",
            },
            () => "no",
          ),
        ).assessDuplicate(input("Bird migration observations."))
      ).verdict,
    ).toBe("distinct");
  });

  it("edit excludes self, ignores private rows and missing/private related sources look identical", async () => {
    const s = store();
    post(s, "self", "ALPHA same");
    post(s, "held", "ALPHA same", "held");
    post(s, "pending", "ALPHA same", "pending");
    const d = detector(s);
    expect(
      (
        await d.assessDuplicate({
          ...input("ALPHA same"),
          excludePostId: "self",
        })
      ).verdict,
    ).toBe("distinct");
    expect(await d.relatedPublicPosts("held")).toEqual(
      await d.relatedPublicPosts("missing"),
    );
    expect(d.publicCorpusHash("self")).not.toBe(d.publicCorpusHash());
  });

  it.each([
    "throw",
    "missing",
    "nan",
    "bad_probability",
    "ambiguous",
    "contradictory",
  ])("fails closed for %s judgments", async (failure) => {
    const s = store();
    post(s, "old", "old material");
    const d = detector(s, async (snapshot) => {
      if (failure === "throw") throw new Error("failure");
      if (failure === "missing") return { answers: {} };
      const raw = judgment(
        snapshot,
        failure === "ambiguous"
          ? { correction: "uncertain" }
          : failure === "contradictory"
            ? { correction: "yes" }
            : {},
      );
      if (failure === "nan") raw.answers.sameconditions.confidence = NaN;
      if (failure === "bad_probability")
        raw.answers.sameconditions.probabilities.no = 1;
      return raw;
    });
    expect((await d.assessDuplicate(input())).verdict).toBe("uncertain");
  });

  it("uses an injected actual-LLM boundary on ambiguity/tool failure, validating its response", async () => {
    const s = store();
    post(s, "old", "ALPHA existing analysis");
    const fallback = vi.fn(async (snapshot) => judgment(snapshot));
    const d = module.createDuplicateDetector({
      store: s,
      testOnly: {
        embeddings: {
          ...backend(),
          embed: async () => {
            throw new Error("tool failure");
          },
        },
      },
      fallback,
    });
    expect((await d.assessDuplicate(input("ALPHA paraphrase"))).verdict).toBe(
      "duplicate",
    );
    expect(fallback).toHaveBeenCalledOnce();
    const bad = module.createDuplicateDetector({
      store: s,
      testOnly: { embeddings: backend(), judge: async () => ({}) },
      fallback: async () => ({ verdict: "distinct" }),
    });
    expect((await bad.assessDuplicate(input())).verdict).toBe("uncertain");
  });

  it("invalidates vectors on model/text/tag/title changes and removes withdrawn cache entries", async () => {
    const s = store();
    post(s, "old", "ALPHA existing analysis");
    const model = backend();
    const d = detector(s, undefined, model);
    await d.assessDuplicate(input());
    expect(s.prepare("SELECT COUNT(*) n FROM duplicate_vectors").get()).toEqual(
      { n: 1 },
    );
    const calls = vi.mocked(model.embed).mock.calls.length;
    await d.assessDuplicate(input());
    expect(vi.mocked(model.embed).mock.calls.length).toBe(calls + 1); // NEW embeds; OLD cached.
    for (const [field, value] of [
      ["body", "BETA updated"],
      ["title", "updated title"],
      ["tags", '["debugger"]'],
    ]) {
      const hash = d.publicCorpusHash();
      s.prepare(`UPDATE posts SET ${field}=? WHERE id='old'`).run(value);
      expect(d.publicCorpusHash()).not.toBe(hash);
      const prior = vi.mocked(model.embed).mock.calls.length;
      await d.assessDuplicate(input());
      expect(vi.mocked(model.embed).mock.calls.length).toBeGreaterThan(
        prior + 1,
      );
    }
    model.version = "synthetic-v2";
    await d.assessDuplicate(input());
    expect(
      s.prepare("SELECT model_version FROM duplicate_vectors").get(),
    ).toEqual({ model_version: "synthetic-v2" });
    s.prepare("UPDATE posts SET status='held' WHERE id='old'").run();
    post(s, "new", "new public material");
    await d.assessDuplicate(input());
    expect(
      s.prepare("SELECT post_id FROM duplicate_vectors ORDER BY post_id").all(),
    ).toEqual([{ post_id: "new" }]);
  });

  it.each(["withdraw", "edit", "publish"])(
    "detects a concurrent %s and exposes no stale IDs",
    async (change) => {
      const s = store();
      post(s, "old", "old public material");
      const d = detector(s, async (snapshot) => {
        if (change === "withdraw")
          s.prepare("UPDATE posts SET status='held' WHERE id='old'").run();
        if (change === "edit")
          s.prepare("UPDATE posts SET body='changed' WHERE id='old'").run();
        if (change === "publish") post(s, "new-batch", "new publication");
        return judgment(snapshot);
      });
      const result = await d.assessDuplicate(input());
      expect(result.verdict).toBe("uncertain");
      expect(result.relatedPostIds).toEqual([]);
      expect(result.evidence).toBe("public-corpus-changed");
      expect(result.corpusHash).not.toBe(d.publicCorpusHash());
    },
  );

  it("sees a newly published batch on the next assessment, without an in-memory corpus snapshot", async () => {
    const s = store();
    const judge = vi.fn(async (snapshot) => judgment(snapshot));
    const d = detector(s, judge);
    expect((await d.assessDuplicate(input())).verdict).toBe("distinct");
    post(s, "batch-1", "old first batch");
    await d.assessDuplicate(input());
    post(s, "batch-2", "old second batch");
    await d.assessDuplicate(input());
    expect(
      judge.mock.calls.at(-1)![0].candidates.map((c: { id: string }) => c.id),
    ).toEqual(["batch-1", "batch-2"]);
  });

  it("never silently passes request/candidate-union/comparison overflow", async () => {
    const s = store();
    const judge = vi.fn(async (snapshot) => judgment(snapshot));
    const d = detector(s, judge);
    expect(
      (await d.assessDuplicate(input("x".repeat(module.LIMITS.requestBytes))))
        .verdict,
    ).toBe("uncertain");
    // Conservative copy hits must union every old source, rather than slicing to fit a prompt.
    const copied = "ALPHA ".repeat(110);
    for (let i = 0; i <= module.LIMITS.candidatePosts; i++)
      post(s, String(i), copied, "published", "different title");
    expect((await d.assessDuplicate(input(copied))).verdict).toBe("uncertain");
    expect(judge).not.toHaveBeenCalled();
    s.exec("DELETE FROM posts");
    post(s, "huge", "x".repeat(50_000));
    expect((await d.assessDuplicate(input())).verdict).toBe("uncertain");
    expect(judge).not.toHaveBeenCalled();
  });

  it("retrieves a multi-old-post mosaic far beyond 128 posts and judges only the candidate union", async () => {
    const s = store();
    for (let i = 0; i < 350; i++)
      post(s, `post-${String(i).padStart(4, "0")}`, `Neutral old subject ${i}`);
    post(s, "post-0000-alpha", "ALPHA branch analysis at the first index");
    post(s, "post-9999-beta", "BETA trace analysis in a later archive batch");
    const model = backend();
    const judge = vi.fn(async (snapshot) => {
      expect(snapshot.candidates.length).toBeLessThanOrEqual(12);
      expect(snapshot.candidates.map((c: { id: string }) => c.id)).toEqual(
        expect.arrayContaining(["post-0000-alpha", "post-9999-beta"]),
      );
      expect(
        snapshot.candidates.some((c: { body: string }) =>
          c.body.includes("later archive batch"),
        ),
      ).toBe(true);
      return judgment(snapshot);
    });
    const d = detector(s, judge, model);
    const result = await d.assessDuplicate(
      input("ALPHA ".repeat(160) + "BETA ".repeat(170)),
    );
    expect(result.verdict).toBe("duplicate");
    expect(result.relatedPostIds).toContain("post-9999-beta");
    expect(result.corpusHash).toBe(d.publicCorpusHash());
    expect(s.prepare("SELECT COUNT(*) n FROM duplicate_vectors").get()).toEqual(
      { n: 352 },
    );
    const calls = vi.mocked(model.embed).mock.calls.length;
    const tokenizerCalls = vi.mocked(model.tokenCount).mock.calls.length;
    await d.assessDuplicate(input("ALPHA ".repeat(160) + "BETA ".repeat(170)));
    expect(
      vi.mocked(model.embed).mock.calls.length - calls,
    ).toBeLessThanOrEqual(2);
    expect(
      vi.mocked(model.tokenCount).mock.calls.length - tokenizerCalls,
    ).toBeLessThan(20);
  });

  it("allows a genuinely distinct post against a 5000-post archive after resumable local indexing", async () => {
    const s = store();
    s.transaction(() => {
      for (let i = 0; i < 5000; i++)
        post(
          s,
          `archive-${String(i).padStart(5, "0")}`,
          `Old independent topic ${i}`,
        );
    })();
    const model = backend();
    const judge = vi.fn(async (snapshot) => {
      expect(snapshot.candidates.length).toBeLessThanOrEqual(8);
      return judgment(
        snapshot,
        {
          sameconditions: "no",
          no_meaningful_novelty: "no",
          related_topic: "no",
        },
        () => "no",
      );
    });
    const d = detector(s, judge, model);
    expect((await d.refreshDuplicateIndex()).complete).toBe(false);
    expect((await d.refreshDuplicateIndex()).complete).toBe(false);
    expect((await d.refreshDuplicateIndex()).complete).toBe(true);
    expect(s.prepare("SELECT COUNT(*) n FROM duplicate_vectors").get()).toEqual(
      { n: 5000 },
    );
    const calls = vi.mocked(model.embed).mock.calls.length;
    const result = await d.assessDuplicate(
      input("A newly measured bird migration phenomenon."),
    );
    expect(result.verdict).toBe("distinct");
    expect(result.relatedPostIds).toEqual([]);
    expect(result.corpusHash).toBe(d.publicCorpusHash());
    expect(vi.mocked(model.embed).mock.calls.length).toBe(calls + 1);
  }, 20_000);

  it("serves only committed semantic references, with no read-time model/API/index writes", async () => {
    const s = store();
    post(s, "source", "ALPHA question");
    post(s, "confirmed", "ALPHA confirmed method");
    post(s, "unrelated", "Different topic");
    post(s, "held", "Private target", "held");
    const model = backend();
    const judge = vi.fn();
    const d = detector(s, judge, model);
    expect((await d.relatedPublicPosts("source")).relatedPostIds).toEqual([]);
    d.recordPublishedRelations(
      "source",
      ["confirmed"],
      d.publicCorpusHash("source"),
    );
    expect((await d.relatedPublicPosts("source")).relatedPostIds).toEqual([
      "confirmed",
    ]);
    expect(model.embed).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
    expect(s.prepare("SELECT COUNT(*) n FROM duplicate_vectors").get()).toEqual(
      { n: 0 },
    );
    expect(() => d.recordPublishedRelations("source", ["held"])).toThrow(
      "relation-target-not-public",
    );
    expect(() =>
      d.recordPublishedRelations("source", ["confirmed"], "stale"),
    ).toThrow("relation-corpus-changed");
    expect((await d.relatedPublicPosts("source")).relatedPostIds).toEqual([
      "confirmed",
    ]);
    s.prepare(
      "UPDATE posts SET body='edited target' WHERE id='confirmed'",
    ).run();
    expect((await d.relatedPublicPosts("source")).relatedPostIds).toEqual([]);
    d.recordPublishedRelations("source", ["confirmed"]);
    s.prepare("UPDATE posts SET status='held' WHERE id='confirmed'").run();
    expect((await d.relatedPublicPosts("source")).relatedPostIds).toEqual([]);
    expect(await d.relatedPublicPosts("held")).toEqual(
      await d.relatedPublicPosts("missing"),
    );
  });

  it("reports only per-candidate semantic confirmations rather than incidental nearest neighbours", async () => {
    const s = store();
    post(s, "confirmed", "ALPHA actual branch method");
    post(s, "incidental", "Unrelated data structure");
    const d = detector(s, async (snapshot) => {
      const result = judgment(snapshot);
      snapshot.candidates.forEach((candidate, i) => {
        result.answers[`related_${i}`] = choice(
          candidate.id === "confirmed" ? "yes" : "no",
        );
      });
      return result;
    });
    const result = await d.assessDuplicate(
      input("ALPHA same meaning in new words"),
    );
    expect(result.verdict).toBe("duplicate");
    expect(result.relatedPostIds).toEqual(["confirmed"]);
  });

  it("does not permit production test doubles", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => detector(store())).toThrow(
      "duplicate-test-dependencies-forbidden",
    );
  });

  it("bounds adapters that ignore abort and rejects malformed answers", async () => {
    const run = vi.fn(async () => new Promise<never>(() => {}));
    await expect(timedJudge(run, 10)).rejects.toThrow("judge-timeout");
    expect(validateJudgment({ answers: {} }, 2)).toBeNull();
  });

  it("uses actual Jev custom question payload and charges/settles the real budget on synthetic text", async () => {
    vi.stubEnv("JEV_BUDGET_USD", "0.01");
    vi.stubEnv("JEV_BUDGET_PATH", ":memory:");
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic-key");
    const snapshot: ComparisonSnapshot = {
      version: "synthetic",
      corpusHash: "hash",
      input: input("EAX != 0x20"),
      candidates: [{ id: "old", ...input("EAX == 0x10") }],
      blocks: [
        { start: 0, end: 11, text: "EAX != 0x20", context: "", weight: 9 },
      ],
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, options) => {
        const request = JSON.parse(options!.body as string);
        expect(request.state).toBe(JSON.stringify(snapshot));
        expect(Object.keys(request.questions)).toEqual([
          ...atomicQuestions,
          "coverage_0",
          "related_0",
        ]);
        expect(request.questions.no_meaningful_novelty.instructions).toContain(
          "UNION",
        );
        return new Response(
          JSON.stringify({
            ...judgment(snapshot),
            model: "jev-1.13.0",
            usage: { input_tokens: 100 },
          }),
        );
      });
    const response = await jevJudge(snapshot, new AbortController().signal);
    expect(validateJudgment(response, 1)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    const { configuredJevBudget } = await import("@/server/jev-budget");
    expect(configuredJevBudget()!.summary().unknownRequests).toBe(0);
    expect(configuredJevBudget()!.summary().chargedOrReservedUsd).toBeCloseTo(
      (100 * 0.042) / 1_000_000,
    );
    expect(judgeRequest(snapshot).questions.sameconditions).toBeTruthy();
  });

  it("retains reservation on API failure and requires a budget before any request", async () => {
    vi.stubEnv("JEV_BUDGET_USD", undefined);
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic-key");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const snapshot: ComparisonSnapshot = {
      version: "synthetic",
      corpusHash: "hash",
      input: input(),
      candidates: [],
      blocks: [],
    };
    await expect(
      jevJudge(snapshot, new AbortController().signal),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    // Also exercise the budget's fail-closed unknown model/usage contract directly.
    const budget = new JevBudget(":memory:", 0.01);
    try {
      const reservation = budget.reserve()!;
      expect(budget.settle(reservation, "unverified-model", 100)).toBe(false);
      expect(budget.summary().unknownRequests).toBe(1);
    } finally {
      budget.close();
    }
  });

  it.each(["network", "unknown-model", "oversize-response"])(
    "keeps real budget reservation after %s failure",
    async (failure) => {
      vi.stubEnv("JEV_BUDGET_USD", "0.008");
      vi.stubEnv("JEV_BUDGET_PATH", ":memory:");
      vi.stubEnv("TYPESAFE_API_KEY", "synthetic-key");
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (failure === "network") throw new Error("synthetic network failure");
        if (failure === "oversize-response")
          return new Response("x".repeat(64_001));
        return new Response(
          JSON.stringify({
            model: "unverified-model",
            usage: { input_tokens: 100 },
            answers: {},
          }),
        );
      });
      const snapshot: ComparisonSnapshot = {
        version: "synthetic",
        corpusHash: "hash",
        input: input(),
        candidates: [],
        blocks: [],
      };
      await expect(
        jevJudge(snapshot, new AbortController().signal),
      ).rejects.toThrow();
      const { configuredJevBudget } = await import("@/server/jev-budget");
      expect(configuredJevBudget()!.summary().unknownRequests).toBeGreaterThan(
        0,
      );
    },
  );
});
