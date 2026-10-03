import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  atomicQuestions,
  type EmbeddingBackend,
  type PublicDocument,
} from "../../src/server/duplicates/types";
import {
  BOUNDS,
  collectReviewed,
  digest,
  prepareBulk,
  resolveBulk,
  validateSnapshot,
  type BatchJudgment,
  type Candidate,
  type Prepared,
} from "../../src/server/chat-pipeline/bulk-duplicates";
import { qualityPolicyVersion } from "../../src/server/chat-pipeline/editorial-policy";
import { splitBlocks } from "../../src/server/duplicates/embedding";
import { main, readPublicSnapshot } from "../../scripts/chat-bulk-preflight";

// Any accidental import of live initialization or paid adapters is a test failure.
vi.mock("../../src/server/db", () => {
  throw new Error("live-db-import-forbidden");
});
vi.mock("../../src/server/duplicates/judge", () => {
  throw new Error("jev-import-forbidden");
});
vi.mock("../../src/server/duplicates/llm", () => {
  throw new Error("llm-import-forbidden");
});
vi.mock("../../src/server/chat-pipeline/model-budget", () => {
  throw new Error("budget-import-forbidden");
});
vi.mock("../../src/server/duplicates/embedding", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../src/server/duplicates/embedding")
    >();
  return { ...original, localEmbeddings: vi.fn(async () => backend()) };
});

const now = Date.parse("2026-10-03T12:00:00Z");
const snapshot = (posts: PublicDocument[] = []) => ({
  capturedAt: new Date(now).toISOString(),
  posts,
});
const post = (id: string, body: string, title = "분석") => ({
  id,
  title,
  body,
  tags: ["debug"],
});
function pair(
  key = "a",
  body = "EAX 값은 호출 전에 저장합니다.",
  title = "분석",
) {
  const publicData = {
    title,
    body,
    tags: ["debug"],
    kind: "share",
    provenance: {
      type: "independent-guide",
      period: "2026",
      verificationSummary: "기술 검토",
    },
  };
  return {
    bundle: {
      qualityPolicyVersion: qualityPolicyVersion,
      entries: [
        {
          candidateKey: key,
          needsContext: false,
          reviewId: "review-1",
          publicData,
        },
      ],
    },
    review: {
      model: "gpt-6.1-sol",
      effort: "xhigh",
      qualityPolicyVersion: qualityPolicyVersion,
      entries: [
        {
          candidateKey: key,
          publicHash: digest(publicData),
          referenceId: "review-1",
          qualityPolicyVersion: qualityPolicyVersion,
          passed: true,
          quality: true,
          meaning: true,
          privacy: true,
          rights: true,
          externalTransfer: true,
        },
      ],
    },
  };
}
const candidate = (key: string, body: string, title = "분석") =>
  collectReviewed([pair(key, body, title)])[0];
function backend() {
  return {
    version: "test-only-fp32",
    tokenCount: vi.fn(async () => 100),
    embed: vi.fn(async (texts: string[]) =>
      texts.map((t) => {
        const vector = Array(384).fill(0) as number[];
        // Different topic blocks get different nearest neighbours, rather than one average.
        vector[t.includes("THREAD") ? 1 : 0] = 1;
        return vector;
      }),
    ),
  } satisfies EmbeddingBackend;
}
async function expectBlocksCalculatedOnce(
  embeddings: ReturnType<typeof backend>,
  candidates: Candidate[],
  posts: PublicDocument[],
) {
  const expected: string[] = [];
  for (const d of [
    ...posts.slice().sort((a, b) => a.id.localeCompare(b.id)),
    ...candidates.map((c) => c.input),
  ]) {
    const blocks = await splitBlocks(d, embeddings);
    expected.push(...blocks.map((b) => `passage: ${b.context}\n${b.text}`));
  }
  const calls = embeddings.embed.mock.calls;
  expect(calls.flatMap(([texts]) => texts)).toEqual(expected);
  expect(calls).toHaveLength(
    Math.ceil(expected.length / BOUNDS.embeddingBatchBlocks),
  );
  for (const [texts] of calls) {
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.length).toBeLessThanOrEqual(BOUNDS.embeddingBatchBlocks);
  }
}
async function prepare(
  candidates: Candidate[],
  posts: PublicDocument[],
  updates = {},
) {
  const embeddings = backend();
  const prepared = await prepareBulk(
    candidates,
    snapshot(posts),
    updates,
    { embeddings },
    now,
  );
  return { prepared, embeddings };
}
function judgment(
  prepared: Prepared,
  kind: "duplicate" | "related" | "distinct" | "uncertain" = "related",
): BatchJudgment[] {
  return prepared.packets.map((p) => ({
    packetHash: p.packetHash,
    questionVersion: p.questionVersion,
    questionHash: p.questionHash,
    corpusHash: p.corpusHash,
    inputHash: p.inputHash,
    entries: p.items.map((item) => ({
      candidateKey: item.candidateKey,
      publicHash: item.publicHash,
      itemHash: item.itemHash,
      answers: Object.fromEntries(
        atomicQuestions.map((k) => [
          k,
          kind === "uncertain"
            ? "uncertain"
            : [
                  "sameconditions",
                  ...(kind === "duplicate" ? ["no_meaningful_novelty"] : []),
                  ...(kind !== "distinct" ? ["related_topic"] : []),
                  ...(kind === "related" ? ["new_evidence"] : []),
                ].includes(k)
              ? "yes"
              : "no",
        ]),
      ) as BatchJudgment["entries"][number]["answers"],
      coverage: item.blocks.map(() =>
        kind === "duplicate"
          ? "yes"
          : kind === "uncertain"
            ? "uncertain"
            : "no",
      ),
      titleCovered: kind === "duplicate" ? "yes" : "no",
      relatedIds: kind === "distinct" ? [] : item.candidates.map((c) => c.id),
      rationale: "독립 판정 fixture: 전체 본문과 조건을 비교한 결론입니다.",
    })),
  }));
}
const resolveAt = (
  p: Prepared,
  j: unknown[],
  c: Candidate[],
  posts: PublicDocument[],
) => resolveBulk(p, j, c, snapshot(posts), now);
function rehashPrepared(p: Prepared) {
  for (const plan of p.plan) {
    if (plan.item)
      plan.item.itemHash = digest(
        Object.fromEntries(
          Object.entries(plan.item).filter(([key]) => key !== "itemHash"),
        ),
      );
  }
  for (const packet of p.packets) {
    packet.items = packet.items.map((item) =>
      structuredClone(
        p.plan.find((plan) => plan.candidateKey === item.candidateKey)?.item ??
          item,
      ),
    );
    packet.packetHash = digest(
      Object.fromEntries(
        Object.entries(packet).filter(([key]) => key !== "packetHash"),
      ),
    );
  }
  p.preparedHash = digest(
    Object.fromEntries(
      Object.entries(p).filter(([key]) => key !== "preparedHash"),
    ),
  );
}

describe("independent bulk preflight", () => {
  afterEach(() => vi.restoreAllMocks());
  it("collects only final snapshots tied to exact independent review, never raw evidence", () => {
    const p = pair();
    Object.assign(p.bundle.entries[0], {
      sourceAliases: ["private-alias"],
      evidenceIds: ["private-evidence"],
      original: "RAW CHAT",
    });
    const selected = collectReviewed([p]);
    expect(JSON.stringify(selected)).not.toMatch(
      /private-alias|private-evidence|RAW CHAT/,
    );
    p.bundle.entries[0].publicData.body += "changed";
    expect(() => collectReviewed([p])).toThrow("unapproved-public-snapshot");
    expect(() => collectReviewed([pair(), pair()])).toThrow(
      "duplicate-candidate-key",
    );
    const rejected = pair();
    rejected.review.entries[0].privacy = false;
    expect(() => collectReviewed([rejected])).toThrow();
    const duplicate = pair();
    duplicate.review.entries.push(duplicate.review.entries[0]);
    expect(() => collectReviewed([duplicate])).toThrow("duplicate-review-key");
  });
  it.each([
    { policy: "reusable-technical-knowledge-v3" },
    { policy: undefined },
    { model: "gpt-6-luna" },
    { model: undefined },
    { effort: "max" },
    { effort: undefined },
  ])(
    "rejects outdated/missing policy and non-Sol/xhigh reviews: %j",
    (change) => {
      const p = pair();
      if ("policy" in change) {
        Object.assign(p.bundle, { qualityPolicyVersion: change.policy });
        Object.assign(p.review, { qualityPolicyVersion: change.policy });
        Object.assign(p.review.entries[0], {
          qualityPolicyVersion: change.policy,
        });
      }
      if ("model" in change) Object.assign(p.review, { model: change.model });
      if ("effort" in change)
        Object.assign(p.review, { effort: change.effort });
      expect(() => collectReviewed([p])).toThrow("invalid-reviewed-bundle");
    },
  );
  it("rejects an outdated entry policy even with a current Sol/xhigh review envelope", () => {
    const p = pair();
    p.review.entries[0].qualityPolicyVersion =
      "reusable-technical-knowledge-v3";
    expect(() => collectReviewed([p])).toThrow("unapproved-public-snapshot");
  });
  it("calculates many documents across batch boundaries once and reuses their vectors at resolve", async () => {
    const c = [candidate("new", "THREAD new condition ".repeat(100))];
    const posts = Array.from({ length: 40 }, (_, i) =>
      post(`old-${i}`, `REGISTER ${i} ` + "analysis ".repeat(150)),
    );
    const { prepared, embeddings } = await prepare(c, posts);
    await expectBlocksCalculatedOnce(embeddings, c, posts);
    expect(embeddings.embed.mock.calls.length).toBeGreaterThan(1);
    expect(embeddings.embed.mock.calls.at(-1)![0].length).toBeLessThan(
      BOUNDS.embeddingBatchBlocks,
    );
    const before = embeddings.embed.mock.calls.length;
    resolveAt(prepared, judgment(prepared), c, posts);
    expect(embeddings.embed.mock.calls.length).toBe(before);
  });
  it("fails malformed vectors in a later bounded group instead of emitting a partial packet", async () => {
    const embeddings = backend();
    embeddings.embed
      .mockImplementationOnce(async (texts) =>
        texts.map(() => {
          const vector = Array(384).fill(0);
          vector[0] = 1;
          return vector;
        }),
      )
      .mockImplementationOnce(async () => []);
    const c = [candidate("a", "new")];
    const posts = Array.from({ length: 20 }, (_, i) =>
      post(`old-${i}`, `old ${i}`),
    );
    await expect(
      prepareBulk(c, snapshot(posts), {}, { embeddings }, now),
    ).rejects.toThrow("invalid-batch-embeddings");
    expect(embeddings.embed.mock.calls.map(([texts]) => texts.length)).toEqual([
      16, 5,
    ]);
  });
  it("calculates each public/batch block once in bounded groups, reuses vectors and emits full OLD union and all NEW blocks", async () => {
    const body =
      "REGISTER analysis ".repeat(42) + "THREAD analysis ".repeat(45);
    const c = [
      candidate("a", body),
      candidate("b", "THREAD: 새 조건 correction", "추가 조건"),
    ];
    const posts = [
      post("register", "REGISTER analysis ".repeat(45)),
      post("thread", "THREAD analysis ".repeat(45)),
    ];
    const { prepared, embeddings } = await prepare(c, posts);
    await expectBlocksCalculatedOnce(embeddings, c, posts);
    expect(prepared.packets).toHaveLength(1);
    expect(prepared.packets[0].items).toHaveLength(2);
    const item = prepared.packets[0].items[0];
    expect(item.candidates.map((p) => p.id).sort()).toEqual([
      "register",
      "thread",
    ]);
    expect(item.candidates.map((p) => p.body)).toEqual(
      expect.arrayContaining(posts.map((p) => p.body)),
    );
    expect(item.blocks.map((b) => b.text).join("")).toBe(body);
    expect(item.blocks.at(-1)!.end).toBe(body.length);
    const result = resolveAt(prepared, judgment(prepared), c, posts);
    expect(result.entries.map((e) => e.action)).toEqual(["accept", "accept"]);
    await expectBlocksCalculatedOnce(embeddings, c, posts);
    expect(result.siteGateProof).toBe(false);
  });
  it.each([
    [
      "B 단계를 수행합니다.\nA 단계를 수행합니다.",
      "A 단계를 수행합니다.\nB 단계를 수행합니다.",
    ],
    [
      "레지스터 값을 보관한 후 복구합니다.",
      "호출 전 EAX 저장, 호출 후 EAX 복원.",
    ],
  ])(
    "sends reordering/paraphrase to judgment rather than a similarity verdict",
    async (body, oldBody) => {
      const c = [candidate("a", body)],
        posts = [post("old", oldBody)];
      const { prepared } = await prepare(c, posts);
      expect(prepared.plan[0].mode).toBe("review");
      expect(
        resolveAt(prepared, judgment(prepared, "duplicate"), c, posts)
          .entries[0].action,
      ).toBe("exclude");
      expect(
        resolveAt(prepared, judgment(prepared, "distinct"), c, posts).entries[0]
          .action,
      ).toBe("accept");
    },
  );
  it("judges a multi-article mosaic against the full union, including title contribution", async () => {
    const posts = [
      post("a", "REGISTER 저장 ".repeat(70)),
      post("b", "THREAD 대기 ".repeat(70)),
    ];
    const c = [candidate("mosaic", posts.map((p) => p.body).join("\n"))];
    const { prepared } = await prepare(c, posts),
      j = judgment(prepared, "duplicate");
    expect(prepared.packets[0].items[0].candidates).toHaveLength(2);
    expect(resolveAt(prepared, j, c, posts).entries[0].verdict).toBe(
      "duplicate",
    );
    j[0].entries[0].titleCovered = "no";
    expect(resolveAt(prepared, j, c, posts).entries[0].action).toBe("hold");
  });
  it.each([
    "if (x != 0x10)",
    "if (x == 0x20)",
    "if (x ==  0x10)",
    "v2: if (x == 0x10)",
  ])(
    "preserves changed operators/constants/whitespace/versions: %s",
    async (body) => {
      const c = [candidate("a", body)],
        posts = [post("old", "if (x == 0x10)")];
      const { prepared } = await prepare(c, posts);
      expect(prepared.plan[0].mode).toBe("review");
      expect(prepared.packets[0].items[0].input.body).toBe(body);
      const j = judgment(prepared);
      j[0].entries[0].answers.sameconditions = "no";
      expect(resolveAt(prepared, j, c, posts).entries[0].verdict).toBe(
        "related",
      );
    },
  );
  it("only normalizes CRLF for exact title/body; a changed title requires review", async () => {
    const posts = [post("old", "code\n  x == 0x10")];
    const c = [candidate("a", "code\r\n  x == 0x10")];
    const { prepared } = await prepare(c, posts);
    expect(resolveAt(prepared, [], c, posts).entries[0].action).toBe("exclude");
    expect(
      (await prepare([candidate("b", posts[0].body, "새 정정")], posts))
        .prepared.plan[0].mode,
    ).toBe("review");
  });
  it("excludes only an explicit update's own published post, retains the other duplicate", async () => {
    const c = [candidate("edit", "new condition")],
      posts = [post("self", "new condition"), post("other", "old condition")];
    const { prepared } = await prepare(c, posts, { edit: "self" });
    expect(prepared.packets[0].items[0].candidates.map((p) => p.id)).toEqual([
      "other",
    ]);
    const same = [
      post("self", "new condition"),
      post("other", "new condition"),
    ];
    const p = (await prepare(c, same, { edit: "self" })).prepared;
    expect(resolveAt(p, [], c, same).entries[0].relatedIds).toEqual(["other"]);
    await expect(prepare(c, posts, { edit: "missing" })).rejects.toThrow(
      "invalid-update-mapping",
    );
  });
  it("compares earlier accepted candidates; holds judgments citing rejected predecessors", async () => {
    const c = [
      candidate("first", "register save"),
      candidate("copy", "register save"),
      candidate("next", "register restore"),
    ];
    const { prepared } = await prepare(c, []);
    expect(prepared.packets[0].items[0].candidates.map((p) => p.id)).toContain(
      "batch:first",
    );
    const result = resolveAt(prepared, judgment(prepared), c, []);
    expect(result.entries.map((e) => e.action)).toEqual([
      "accept",
      "exclude",
      "hold",
    ]);
    const withOld = [
        candidate("a", "register save"),
        candidate("b", "register restore"),
      ],
      posts = [post("old", "register load")];
    const p = (await prepare(withOld, posts)).prepared,
      j = judgment(p);
    j[0].entries[0] = judgment(p, "duplicate")[0].entries[0];
    expect(
      resolveAt(p, j, withOld, posts).entries.map((e) => e.action),
    ).toEqual(["exclude", "hold"]);
  });
  it.each(["앞", "뒤"])(
    "갱신 후보가 %s에 있어도 사라질 공개본문의 정확한 중복 판정은 보류하고 별개 글은 유지합니다",
    async (order) => {
      const update = candidate("update", "새 내용 B"),
        fresh = candidate("new", "기존 내용 A"),
        distinct = candidate("distinct", "독립적인 기술 내용 C");
      const c = [
        ...(order === "앞" ? [update, fresh] : [fresh, update]),
        distinct,
      ];
      const posts = [post("P", "기존 내용 A")];
      const { prepared } = await prepare(c, posts, { update: "P" });
      expect(prepared.plan.find((p) => p.candidateKey === "new")?.mode).toBe(
        "exact",
      );
      expect(
        prepared.packets
          .flatMap((p) => p.items)
          .find((i) => i.candidateKey === "distinct")
          ?.candidates.map((p) => p.id),
      ).toContain("P");
      const result = resolveAt(
        prepared,
        judgment(prepared, "distinct"),
        c,
        posts,
      );
      expect(
        result.entries.find((e) => e.candidateKey === "update")?.action,
      ).toBe("accept");
      expect(
        result.entries.find((e) => e.candidateKey === "new"),
      ).toMatchObject({
        verdict: "uncertain",
        action: "hold",
        reason: "accepted-update-replaces-evidence",
      });
      expect(
        result.entries.find((e) => e.candidateKey === "distinct"),
      ).toMatchObject({ verdict: "distinct", action: "accept" });
      const updatedPosts = [post("P", update.input.body)];
      expect(() =>
        resolveAt(prepared, judgment(prepared, "distinct"), c, updatedPosts),
      ).toThrow("preflight-snapshot-mismatch");
      const rechecked = (await prepare([fresh], updatedPosts)).prepared;
      expect(
        resolveAt(
          rechecked,
          judgment(rechecked, "distinct"),
          [fresh],
          updatedPosts,
        ).entries[0].action,
      ).toBe("accept");
    },
  );
  it.each([
    { order: "앞", verdict: "related" },
    { order: "뒤", verdict: "related" },
    { order: "앞", verdict: "duplicate" },
    { order: "뒤", verdict: "duplicate" },
  ] as const)(
    "갱신이 $order에 있을 때 옛 공개본문을 근거로 한 $verdict 판정을 보류합니다",
    async ({ order, verdict }) => {
      const update = candidate("update", "새 내용 B"),
        next = candidate("next", "기존 설명을 변형한 내용");
      const c = order === "앞" ? [update, next] : [next, update];
      const posts = [post("P", "기존 내용 A")];
      const { prepared } = await prepare(c, posts, { update: "P" });
      const j = judgment(prepared, "distinct"),
        comparison = judgment(prepared, verdict)
          .flatMap((p) => p.entries)
          .find((e) => e.candidateKey === "next")!;
      comparison.relatedIds = ["P"];
      comparison.rationale = "옛 공개본문을 비교 근거로 사용했습니다.";
      for (const packet of j)
        packet.entries = packet.entries.map((e) =>
          e.candidateKey === "next" ? comparison : e,
        );
      const result = resolveAt(prepared, j, c, posts);
      expect(
        result.entries.find((e) => e.candidateKey === "update")?.action,
      ).toBe("accept");
      expect(
        result.entries.find((e) => e.candidateKey === "next"),
      ).toMatchObject({
        action: "hold",
        reason: "accepted-update-replaces-evidence",
      });
    },
  );
  it("보류된 갱신이나 비교 본문이 같은 갱신은 기존 공개본문의 근거를 무효화하지 않습니다", async () => {
    const posts = [post("P", "기존 내용 A")];
    const c = [
      candidate("new", "기존 내용 A"),
      candidate("update", "새 내용 B"),
    ];
    const p = (await prepare(c, posts, { update: "P" })).prepared;
    expect(
      resolveAt(p, judgment(p, "uncertain"), c, posts).entries.map(
        (e) => e.action,
      ),
    ).toEqual(["exclude", "hold"]);
    const unchanged = [
      candidate("update", "기존 내용 A"),
      candidate("new", "기존 내용 A"),
    ];
    const same = (await prepare(unchanged, posts, { update: "P" })).prepared;
    expect(
      resolveAt(same, [], unchanged, posts).entries.map((e) => e.action),
    ).toEqual(["accept", "exclude"]);
  });
  it("갱신 때문에 보류된 관계 후보에 의존하는 후속 후보도 보류하되 무관한 글은 유지합니다", async () => {
    const c = [
      candidate("update", "새 내용 B"),
      candidate("related", "관계된 새 내용 C"),
      candidate("copy", "관계된 새 내용 C"),
      candidate("distinct", "별개의 내용 D"),
    ];
    const posts = [post("P", "기존 내용 A")];
    const { prepared } = await prepare(c, posts, { update: "P" });
    const j = judgment(prepared, "distinct"),
      related = judgment(prepared, "related")
        .flatMap((p) => p.entries)
        .find((e) => e.candidateKey === "related")!;
    related.relatedIds = ["P"];
    related.rationale = "갱신될 옛 공개본문이 관계 판정의 근거입니다.";
    for (const p of j)
      p.entries = p.entries.map((e) =>
        e.candidateKey === "related" ? related : e,
      );
    expect(
      resolveAt(prepared, j, c, posts).entries.map((e) => e.action),
    ).toEqual(["accept", "hold", "hold", "accept"]);
  });
  it("검사 없는 계획으로 바꾸면 준비 파일의 무결성 및 비교대상 구조 검사에서 거부합니다", async () => {
    const c = [candidate("a", "새 내용"), candidate("b", "다음 내용")],
      posts = [post("P", "기존 내용")];
    const { prepared } = await prepare(c, posts);
    const changed = JSON.parse(JSON.stringify(prepared)) as Prepared;
    changed.plan = c.map((c) => ({
      candidateKey: c.candidateKey,
      mode: "empty",
    }));
    changed.packets = [];
    expect(() => resolveBulk(changed, [], c, snapshot(posts), now)).toThrow(
      "preflight-snapshot-mismatch",
    );
    rehashPrepared(changed);
    expect(() => resolveBulk(changed, [], c, snapshot(posts), now)).toThrow(
      "invalid-prepared-plan",
    );
  });
  it("재해시하더라도 계획 순서와 NEW 전체 본문 및 OLD 실제 문서의 구조 불일치를 거부합니다", async () => {
    const c = [
        candidate("a", "새 기술 설명 ".repeat(170)),
        candidate("b", "다음 기술 설명"),
      ],
      posts = [post("P", "기존 기술 설명")];
    const { prepared, embeddings } = await prepare(c, posts),
      calls = embeddings.embed.mock.calls.length;
    const mutations: { name: string; mutate: (p: Prepared) => void }[] = [
      {
        name: "누락된 계획",
        mutate: (p) => {
          p.plan.pop();
        },
      },
      {
        name: "중복된 계획",
        mutate: (p) => {
          p.plan[1] = p.plan[0];
        },
      },
      {
        name: "역순 계획",
        mutate: (p) => {
          p.plan.reverse();
        },
      },
      {
        name: "누락된 판정 묶음",
        mutate: (p) => {
          p.packets = [];
        },
      },
      {
        name: "다른 NEW 제목",
        mutate: (p) => {
          p.plan[0].item!.input.title = "변경된 제목";
        },
      },
      {
        name: "다른 NEW 본문",
        mutate: (p) => {
          p.plan[0].item!.input.body += "변경";
        },
      },
      {
        name: "다른 NEW 태그",
        mutate: (p) => {
          p.plan[0].item!.input.tags = ["다른 태그"];
        },
      },
      {
        name: "다른 블록 텍스트",
        mutate: (p) => {
          p.plan[0].item!.blocks[0].text = "변조한 텍스트";
        },
      },
      {
        name: "누락된 본문 시작",
        mutate: (p) => {
          p.plan[0].item!.blocks[0].start = 1;
        },
      },
      {
        name: "블록 범위 겹침",
        mutate: (p) => {
          p.plan[0].item!.blocks[1].start--;
        },
      },
      {
        name: "누락된 마지막 블록",
        mutate: (p) => {
          p.plan[0].item!.blocks.pop();
        },
      },
      {
        name: "다른 공개 OLD 본문",
        mutate: (p) => {
          p.plan[0].item!.candidates[0].body += "변경";
        },
      },
      {
        name: "미래 후보인 OLD",
        mutate: (p) => {
          p.plan[0].item!.candidates.push({ id: "batch:b", ...c[1].input });
        },
      },
      {
        name: "다른 앞선 후보 OLD",
        mutate: (p) => {
          p.plan[1].item!.candidates.find(
            (old) => old.id === "batch:a",
          )!.body += "변경";
        },
      },
    ];
    for (const { name, mutate } of mutations) {
      const changed = JSON.parse(JSON.stringify(prepared)) as Prepared;
      mutate(changed);
      rehashPrepared(changed);
      expect(
        () => resolveBulk(changed, judgment(changed), c, snapshot(posts), now),
        name,
      ).toThrow("invalid-prepared-plan");
    }
    expect(embeddings.embed.mock.calls.length).toBe(calls);
  });
  it.each(["duplicate", "uncertain"] as const)(
    "accepts distinct after a %s predecessor and makes it available to later candidates",
    async (predecessorVerdict) => {
      const c = [
        candidate("first", "register save"),
        candidate("next", "register restore"),
        candidate("copy", "register restore"),
      ];
      const posts = [post("old", "register load")];
      const { prepared } = await prepare(c, posts),
        j = judgment(prepared, "distinct");
      expect(
        prepared.packets[0].items[1].candidates.map((p) => p.id),
      ).toContain("batch:first");
      j[0].entries[0] = judgment(prepared, predecessorVerdict)[0].entries[0];
      const result = resolveAt(prepared, j, c, posts);
      expect(result.entries.map((e) => e.action)).toEqual([
        predecessorVerdict === "duplicate" ? "exclude" : "hold",
        "accept",
        "exclude",
      ]);
      expect(result.entries[1].verdict).toBe("distinct");
      expect(result.entries[1].relatedIds).toEqual([]);
      expect(result.entries[2].relatedIds).toContain("batch:next");
    },
  );
  it.each(["related", "duplicate"] as const)(
    "keeps %s relying only on a published post despite an uncited excluded predecessor",
    async (verdict) => {
      const c = [
        candidate("first", "register save"),
        candidate("next", "register restore"),
      ];
      const posts = [post("old", "register load")];
      const { prepared } = await prepare(c, posts),
        j = judgment(prepared, verdict);
      j[0].entries[0] = judgment(prepared, "duplicate")[0].entries[0];
      expect(
        prepared.packets[0].items[1].candidates.map((p) => p.id),
      ).toContain("batch:first");
      j[0].entries[1].relatedIds = ["old"];
      const result = resolveAt(prepared, j, c, posts);
      expect(result.entries[0].action).toBe("exclude");
      expect(result.entries[1].verdict).toBe(verdict);
      expect(result.entries[1].action).toBe(
        verdict === "duplicate" ? "exclude" : "accept",
      );
      expect(result.entries[1].relatedIds).toEqual(["old"]);
      j[0].entries[1].relatedIds = ["batch:first"];
      expect(resolveAt(prepared, j, c, posts).entries[1]).toMatchObject({
        action: "hold",
        reason: "unaccepted-predecessor-reprepare",
      });
    },
  );
  it.each(["new_evidence", "correction", "novel_synthesis", "answer_fulfills"])(
    "retains meaningful %s as related",
    async (field) => {
      const c = [candidate("a", "new useful contribution")],
        posts = [post("old", "old contribution")];
      const { prepared } = await prepare(c, posts),
        j = judgment(prepared);
      j[0].entries[0].answers.new_evidence = "no";
      j[0].entries[0].answers[field as "correction"] = "yes";
      expect(resolveAt(prepared, j, c, posts).entries[0].verdict).toBe(
        "related",
      );
    },
  );
  it("holds uncertainty and contradictory duplicate claims", async () => {
    const c = [candidate("a", "new")],
      posts = [post("old", "old")];
    const { prepared } = await prepare(c, posts);
    expect(
      resolveAt(prepared, judgment(prepared, "uncertain"), c, posts).entries[0]
        .action,
    ).toBe("hold");
    const j = judgment(prepared, "duplicate");
    j[0].entries[0].answers.correction = "yes";
    expect(resolveAt(prepared, j, c, posts).entries[0].action).toBe("hold");
  });
  it("rejects an OLD id borrowed from another entry in the same packet", async () => {
    const c = [candidate("a", "new A"), candidate("b", "new B")];
    const posts = [post("P", "old A"), post("Q", "old B")];
    const { prepared } = await prepare(c, posts, { a: "P", b: "Q" });
    const [first, second] = prepared.packets[0].items;
    expect(first.candidates.some((old) => old.id === "P")).toBe(false);
    expect(second.candidates.some((old) => old.id === "P")).toBe(true);
    const j = judgment(prepared, "distinct");
    j[0].entries[0].answers.related_topic = "yes";
    j[0].entries[0].relatedIds = ["P"];
    expect(() => resolveAt(prepared, j, c, posts)).toThrow(
      "invalid-batched-judgment",
    );
  });
  it("fails missing, duplicate, empty and tampered batched results before returning output", async () => {
    const c = [candidate("a", "new"), candidate("b", "newer")],
      posts = [post("old", "old")];
    const { prepared } = await prepare(c, posts);
    const mutations: ((j: BatchJudgment[]) => unknown[])[] = [
      () => [],
      (j) => [...j, j[0]],
      (j) => {
        j[0].entries = [];
        return j;
      },
      (j) => {
        j[0].entries[1] = j[0].entries[0];
        return j;
      },
      (j) => {
        j[0].questionVersion = "old";
        return j;
      },
      (j) => {
        j[0].questionHash = "changed";
        return j;
      },
      (j) => {
        j[0].corpusHash = "changed";
        return j;
      },
      (j) => {
        j[0].entries[0].publicHash = "changed";
        return j;
      },
      (j) => {
        j[0].entries[0].itemHash = "changed";
        return j;
      },
      (j) => {
        j[0].entries[0].coverage = [];
        return j;
      },
      (j) => {
        j[0].entries[0].rationale = "";
        return j;
      },
      (j) => {
        j[0].entries[0].relatedIds = ["unknown"];
        return j;
      },
      (j) => {
        delete (
          j[0].entries[0].answers as Partial<
            (typeof j)[0]["entries"][number]["answers"]
          >
        ).correction;
        return j;
      },
    ];
    for (const mutate of mutations)
      expect(() =>
        resolveAt(prepared, mutate(judgment(prepared)), c, posts),
      ).toThrow();
    const changed = structuredClone(prepared);
    changed.packets[0].items[0].input.body = "tampered";
    expect(() => resolveAt(changed, judgment(changed), c, posts)).toThrow();
    expect(() =>
      resolveAt(
        prepared,
        judgment(prepared),
        [candidate("a", "changed"), c[1]],
        posts,
      ),
    ).toThrow();
  });
  it("hashes unretrieved corpus members and refuses stale/nonpublic snapshots", async () => {
    const c = [candidate("a", "new")],
      posts = Array.from({ length: 10 }, (_, i) =>
        post(`old-${i}`, `value ${i}`),
      );
    const { prepared } = await prepare(c, posts),
      retrieved = new Set(
        prepared.packets[0].items[0].candidates.map((p) => p.id),
      );
    const changed = structuredClone(posts),
      omitted = changed.find((p) => !retrieved.has(p.id))!;
    expect(omitted).toBeDefined();
    omitted.body += " changed";
    expect(() => resolveAt(prepared, judgment(prepared), c, changed)).toThrow(
      "preflight-snapshot-mismatch",
    );
    expect(() =>
      validateSnapshot(snapshot(), now + BOUNDS.snapshotAgeMs + 1),
    ).toThrow("stale-public-snapshot");
    expect(() =>
      validateSnapshot(
        { ...snapshot(), posts: [{ ...posts[0], status: "held" }] },
        now,
      ),
    ).toThrow("nonpublic-snapshot-row");
    expect(() =>
      resolveBulk(
        prepared,
        judgment(prepared),
        c,
        snapshot(posts),
        now + BOUNDS.snapshotAgeMs + 1,
      ),
    ).toThrow("stale-public-snapshot");
  });
  it("allows an older prepared batch with a freshly checked identical corpus, but refuses changed current corpus or stale explicit snapshots", async () => {
    const c = [candidate("a", "new condition")],
      posts = [post("old", "old condition")];
    const { prepared } = await prepare(c, posts);
    const later = now + BOUNDS.snapshotAgeMs * 4;
    const current = { capturedAt: new Date(later).toISOString(), posts };
    expect(
      resolveBulk(prepared, judgment(prepared), c, current, later).entries[0]
        .action,
    ).toBe("accept");
    expect(() =>
      resolveBulk(
        prepared,
        judgment(prepared),
        c,
        { ...current, posts: [post("old", "changed condition")] },
        later,
      ),
    ).toThrow("preflight-snapshot-mismatch");
    expect(() =>
      resolveBulk(prepared, judgment(prepared), c, snapshot(posts), later),
    ).toThrow("stale-public-snapshot");
  });
  it("binds the reviewed result itself even when the approved public body is unchanged", async () => {
    const p = pair(),
      c = collectReviewed([p]),
      posts = [post("old", "old")];
    const { prepared } = await prepare(c, posts);
    Object.assign(p.review, { auditNote: "changed after prepare" });
    expect(() =>
      resolveAt(prepared, judgment(prepared), collectReviewed([p]), posts),
    ).toThrow("preflight-snapshot-mismatch");
  });
  it("splits multiple fullbody items into bounded batched packets without dropping any review item", async () => {
    const c = Array.from({ length: 14 }, (_, i) =>
      candidate(`new-${i}`, `REGISTER ${i} ` + "analysis ".repeat(190)),
    );
    const posts = [post("old", "REGISTER old " + "analysis ".repeat(190))];
    const { prepared, embeddings } = await prepare(c, posts);
    expect(prepared.packets.length).toBeGreaterThan(1);
    expect(
      prepared.packets.flatMap((p) => p.items).map((i) => i.candidateKey),
    ).toEqual(
      prepared.plan
        .filter((p) => p.mode === "review")
        .map((p) => p.candidateKey),
    );
    for (const p of prepared.packets)
      expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(
        BOUNDS.packetBytes,
      );
    await expectBlocksCalculatedOnce(embeddings, c, posts);
  });
  it("holds candidate and size overflow without truncating the comparison", async () => {
    const sharedBlock = "common duplicated block ".repeat(40).slice(0, 640);
    const c = [candidate("a", sharedBlock + "new addition")];
    const posts = Array.from({ length: 40 }, (_, i) =>
      post(`old-${i}`, sharedBlock + i),
    );
    const { prepared } = await prepare(c, posts);
    expect(prepared.plan[0].mode).toBe("hold");
    expect(prepared.packets).toEqual([]);
    const large = (
      await prepare([candidate("b", "x".repeat(BOUNDS.itemBytes + 1))], [])
    ).prepared;
    expect(large.plan[0].mode).toBe("hold");
    expect(resolveAt(large, [], large.candidates, []).entries[0].action).toBe(
      "hold",
    );
  });
  it("performs no network/paid requests or implicit live DB initialization", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network forbidden");
    });
    const c = [candidate("a", "new")],
      posts = [post("old", "old")];
    const { prepared } = await prepare(c, posts);
    resolveAt(prepared, judgment(prepared), c, posts);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("readonly CLI boundary", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const d of directories.splice(0))
      rmSync(d, { recursive: true, force: true });
  });
  const temporary = () => {
    const d = mkdtempSync(join(tmpdir(), "bulk-preflight-"));
    directories.push(d);
    return d;
  };
  it("별도 해시 입력 없이 묶음 판정을 적용하고 비교를 생략한 준비 파일은 거부합니다", async () => {
    const original = process.cwd(),
      d = temporary();
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.chdir(d);
      const p = pair("a", "새 기술 내용");
      const fresh = {
        capturedAt: new Date().toISOString(),
        posts: [post("P", "기존 기술 내용")],
      };
      for (const [name, value] of Object.entries({
        "bundle.json": p.bundle,
        "approved.json": p.review,
        "manifest.json": {
          bundles: [{ bundle: "bundle.json", review: "approved.json" }],
        },
        "snapshot.json": fresh,
      }))
        writeFileSync(name, JSON.stringify(value));
      const inputs = [
        "--manifest",
        "manifest.json",
        "--snapshot",
        "snapshot.json",
      ];
      await main(["prepare", ...inputs, "--out", "data/prepared.json"]);
      const prepared = JSON.parse(
        readFileSync("data/prepared.json", "utf8"),
      ) as Prepared;
      writeFileSync(
        "judgments.json",
        JSON.stringify(judgment(prepared, "distinct")),
      );
      const args = [
        "resolve",
        ...inputs,
        "--prepared",
        "data/prepared.json",
        "--judgments",
        "judgments.json",
      ];
      await main([...args, "--out", "data/resolved.json"]);
      expect(
        JSON.parse(readFileSync("data/resolved.json", "utf8")).entries[0]
          .action,
      ).toBe("accept");
      prepared.plan = [{ candidateKey: "a", mode: "empty" }];
      prepared.packets = [];
      rehashPrepared(prepared);
      writeFileSync("data/prepared.json", JSON.stringify(prepared));
      writeFileSync("judgments.json", "[]");
      await expect(
        main([...args, "--out", "data/tampered.json"]),
      ).rejects.toThrow("invalid-prepared-plan");
      expect(existsSync(join("data", "tampered.json"))).toBe(false);
    } finally {
      stdout.mockRestore();
      process.chdir(original);
    }
  });
  it("reads only published posts without changing any DB bytes/tables or creating a missing DB", () => {
    const d = temporary(),
      path = join(d, "snapshot.sqlite"),
      db = new Database(path);
    db.exec(
      "CREATE TABLE posts (id TEXT,title TEXT,body TEXT,tags TEXT,status TEXT)",
    );
    const insert = db.prepare("INSERT INTO posts VALUES (?,?,?,?,?)");
    for (const status of ["published", "pending", "held"])
      insert.run(status, "title", "body", "[]", status);
    db.close();
    const before = readFileSync(path);
    expect(readPublicSnapshot(path).posts.map((p) => p.id)).toEqual([
      "published",
    ]);
    expect(readFileSync(path)).toEqual(before);
    const inspect = new Database(path, { readonly: true });
    expect(
      inspect
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all(),
    ).toEqual([{ name: "posts" }]);
    inspect.close();
    expect(() => readPublicSnapshot(join(d, "missing.sqlite"))).toThrow();
    expect(existsSync(join(d, "missing.sqlite"))).toBe(false);
  });
  it("resolve rejects output outside private data and creates no output on altered inputs", async () => {
    const original = process.cwd(),
      d = temporary();
    try {
      process.chdir(d);
      mkdirSync(join(d, "data"));
      const p = pair(),
        c = collectReviewed([p]);
      const fresh = { capturedAt: new Date().toISOString(), posts: [] };
      const prepared = await prepareBulk(
        c,
        fresh,
        {},
        { embeddings: backend() },
      );
      const write = (name: string, value: unknown) =>
        writeFileSync(join(d, name), JSON.stringify(value));
      write("bundle.json", p.bundle);
      write("approved.json", p.review);
      write("manifest.json", {
        bundles: [{ bundle: "bundle.json", review: "approved.json" }],
      });
      write("snapshot.json", fresh);
      write("prepared.json", prepared);
      write("judgments.json", []);
      const args = [
        "resolve",
        "--manifest",
        "manifest.json",
        "--snapshot",
        "snapshot.json",
        "--prepared",
        "prepared.json",
        "--judgments",
        "judgments.json",
        "--out",
      ];
      await expect(main([...args, "outside.json"])).rejects.toThrow(
        "output-must-be-private-data",
      );
      await expect(main([...args, "data/../escaped.json"])).rejects.toThrow();
      await main([...args, "data/resolved.json"]);
      expect(
        JSON.parse(readFileSync(join(d, "data/resolved.json"), "utf8"))
          .siteGateProof,
      ).toBe(false);
      await expect(main([...args, "data/resolved.json"])).rejects.toThrow(
        "output-already-exists",
      );
      p.bundle.entries[0].publicData.body += "changed";
      write("bundle.json", p.bundle);
      await expect(main([...args, "data/invalid.json"])).rejects.toThrow();
      expect(existsSync(join(d, "data/invalid.json"))).toBe(false);
    } finally {
      process.chdir(original);
    }
  });
  it("rejects a private output junction escaping data", async () => {
    const original = process.cwd(),
      d = temporary(),
      outside = temporary();
    try {
      process.chdir(d);
      mkdirSync(join(d, "data"));
      symlinkSync(outside, join(d, "data/link"), "junction");
      const p = pair(),
        c = collectReviewed([p]),
        fresh = { capturedAt: new Date().toISOString(), posts: [] };
      const prepared = await prepareBulk(
        c,
        fresh,
        {},
        { embeddings: backend() },
      );
      for (const [name, value] of Object.entries({
        "bundle.json": p.bundle,
        "approved.json": p.review,
        "manifest.json": {
          bundles: [{ bundle: "bundle.json", review: "approved.json" }],
        },
        "snapshot.json": fresh,
        "prepared.json": prepared,
        "judgments.json": [],
      }))
        writeFileSync(name, JSON.stringify(value));
      await expect(
        main([
          "resolve",
          "--manifest",
          "manifest.json",
          "--snapshot",
          "snapshot.json",
          "--prepared",
          "prepared.json",
          "--judgments",
          "judgments.json",
          "--out",
          "data/link/output.json",
        ]),
      ).rejects.toThrow("output-escapes-private-data");
      expect(existsSync(join(outside, "output.json"))).toBe(false);
    } finally {
      process.chdir(original);
    }
  });
});
