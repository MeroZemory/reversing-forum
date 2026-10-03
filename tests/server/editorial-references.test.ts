import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  renameSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ChatJobStore } from "../../src/server/chat-pipeline/job-store";
import { SANITIZER_VERSION } from "../../src/server/chat-pipeline/prepare";
import {
  emitReferences,
  inspectReferences,
} from "../../src/server/chat-pipeline/editorial-references";

const url = "https://docs.example.org/technical/manual";
const raw = "개인 원문 질문은 충분히 긴 문장으로 유지합니다";
function fixture(legacy = false) {
  const root = mkdtempSync(join(tmpdir(), "editorial-references-synthetic-"));
  const directory = join(root, "data/chat-pipeline");
  mkdirSync(directory, { recursive: true });
  const store = new ChatJobStore(directory);
  store.prepare(
    [
      {
        id: "synthetic",
        bytes: new TextEncoder().encode(
          `연습방 카카오톡 대화\n--------------- 2026년 10월 2일 금요일 ---------------\n[비공개별명] [오전 9:00] ${raw} ${legacy ? "https:[개인 경로 제거]" : url}\n[비공개별명] [오전 9:01] 개인 원문 응답입니다 ${legacy ? "https:[개인 경로 제거]" : "https://docs.example.org/response"}\n`,
        ),
      },
    ],
    {
      targetPrepared: true,
      scopeApproved: true,
      externalApproved: true,
      sampleReviewed: true,
      scopeVersion: "synthetic",
      reviewScopeVersion: "synthetic",
      reviewRuleVersion: SANITIZER_VERSION,
      externalVersion: "synthetic",
      maxMessages: 100,
      overlap: 1,
      promptVersion: "synthetic",
    },
  );
  const batch = store.listBatches()[0];
  const ids = batch.input.messages.map((m) => m.id);
  store.importResult(
    batch.batchId,
    JSON.stringify({
      batchId: batch.batchId,
      inputHash: batch.inputHash,
      complete: true,
      candidates: [
        {
          localId: "synthetic",
          title: "기술 질문",
          topic: "기술",
          questionIds: [ids[0]],
          responseIds: [ids[1]],
          uncertainties: [],
          needsContext: false,
        },
      ],
      dispositions: [],
    }),
  );
  const key = store.listCandidates()[0].candidateKey;
  store.close();
  const database = join(directory, "jobs.sqlite");
  if (legacy) {
    // Seed a historical private-ledger snapshot separately. Prepared messages
    // remain exactly as returned by prepare; no sanitizer or job input rewrite.
    const db = new Database(database);
    for (const [i, id] of ids.entries()) {
      const row = db
        .prepare("SELECT record FROM ledger WHERE id=?")
        .get(id) as { record: string };
      const record = JSON.parse(row.record);
      record.message.body =
        i === 0
          ? `${raw} ${url}`
          : "개인 원문 응답입니다 https://docs.example.org/response";
      db.prepare("UPDATE ledger SET record=? WHERE id=?").run(
        JSON.stringify(record),
        id,
      );
    }
    db.close();
  }
  const write = (name: string, value: unknown) =>
    writeFileSync(join(directory, name), JSON.stringify(value));
  write("keys.json", [key]);
  write("processing-record.json", { synthetic: true });
  const run = (script: string, ...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL(`../../scripts/${script}.ts`, import.meta.url)),
        ...args,
      ],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
  const decision = {
    candidateKey: key,
    messageId: ids[0],
    url,
    decision: "allow",
    checked: true,
    title: "공개 기술 문서",
    notes: "문서의 적용 조건을 확인하여 독립적으로 설명합니다.",
  };
  return {
    root,
    directory,
    database,
    key,
    ids,
    messages: batch.input.messages,
    write,
    run,
    decision,
    close() {
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it.each([false, true])(
  "runs inspect → emit → prepare without sanitizer/input rewrites (legacy=%s), without raw ledger/identity transfer",
  (legacy) => {
    const f = fixture(legacy);
    try {
      const before = readFileSync(f.database);
      // The current historical sanitizer can produce a personal-path marker
      // instead of a link marker. Accept either result as the sanitizer evolves;
      // the fixture never rewrites its prepared input or injects a sentinel.
      for (const m of f.messages) {
        expect(m.text).toMatch(/\[(?:개인 경로|링크) 제거\]/);
        expect(m.text).not.toContain("https://docs.example.org/");
        if (legacy) expect(m.text).not.toContain("[링크 제거]");
      }
      const inspected = f.run(
        "chat-editorial-references",
        "inspect",
        "data/chat-pipeline/keys.json",
        "data/chat-pipeline/inspect.json",
      );
      expect(inspected.status).toBe(0);
      expect(inspected.stdout).not.toContain(url);
      const privateText = readFileSync(
        join(f.directory, "inspect.json"),
        "utf8",
      );
      expect(privateText).not.toContain(raw);
      expect(privateText).not.toContain("비공개별명");
      const inspection = JSON.parse(privateText);
      expect(inspection.entries[0].references).toEqual([
        { messageId: f.ids[0], url },
        { messageId: f.ids[1], url: "https://docs.example.org/response" },
      ]);
      f.write("decisions.json", [f.decision]);
      const emitted = f.run(
        "chat-editorial-references",
        "emit",
        "data/chat-pipeline/inspect.json",
        "data/chat-pipeline/decisions.json",
        "data/chat-pipeline/supplements.json",
      );
      expect(emitted.status).toBe(0);
      expect(emitted.stdout).not.toContain(url);
      const supplementsBefore = readFileSync(
        join(f.directory, "supplements.json"),
      );
      const overwrite = f.run(
        "chat-editorial-references",
        "emit",
        "data/chat-pipeline/inspect.json",
        "data/chat-pipeline/decisions.json",
        "data/chat-pipeline/supplements.json",
      );
      expect(overwrite.status).toBe(1);
      expect(overwrite.stderr.trim()).toBe("editorial-references-failed");
      expect(readFileSync(join(f.directory, "supplements.json"))).toEqual(
        supplementsBefore,
      );
      expect(readFileSync(f.database)).toEqual(before);
      const prepared = f.run(
        "chat-editorial-batches",
        "prepare",
        "--candidate-keys",
        "data/chat-pipeline/keys.json",
        "--supplements",
        "data/chat-pipeline/supplements.json",
      );
      expect(prepared.status, prepared.stderr).toBe(0);
      const manifest = JSON.parse(
        readFileSync(
          join(f.directory, "editorial-batches/manifest.json"),
          "utf8",
        ),
      );
      const inputText = readFileSync(manifest.packets[0].input, "utf8");
      const entry = JSON.parse(inputText).entries[0];
      expect(entry.editorialSources).toEqual([
        { title: f.decision.title, url, notes: f.decision.notes },
      ]);
      expect(
        entry.evidence.map((e: { text: string }) => e.text).join(" "),
      ).not.toContain(url);
      expect(inputText).not.toContain("비공개별명");
      expect(entry.evidence.map((e: { text: string }) => e.text)).toEqual(
        f.messages.map((m) => m.text),
      );
      expect(inputText).not.toContain('"author"');
      // Only the reviewed reference enters editorialSources. The unreviewed
      // response URL remains private and cannot enter the model packet.
      expect(inputText).not.toContain("https://docs.example.org/response");
      expect(JSON.parse(inputText).instructions).toContain("### 편집자 보충");
    } finally {
      f.close();
    }
  },
);

it("blocks missing checks, unauthorized decisions, wrong candidate/evidence, duplicate decisions and secret/original/identity notes", () => {
  const f = fixture();
  try {
    const inspection = inspectReferences(f.database, [f.key]);
    for (const changes of [
      { checked: undefined },
      { checked: false },
      { decision: "pending" },
      { candidateKey: "a".repeat(64) },
      { messageId: f.ids[1] },
      { notes: "token=private-secret" },
      { title: "비공개별명의 설명" },
      { notes: raw },
      { notes: "user@example.org" },
      { notes: "sk-abcdefghijklmnop" },
      { notes: "Authorization: Basic dXNlcjpwYXNz" },
      { notes: "Proxy-Authorization: Basic dXNlcjpwYXNz" },
      { notes: "Authorization: Bearer short" },
      { notes: "Proxy-Authorization: Bearer short" },
      { extra: "unreviewed" },
    ])
      expect(() =>
        emitReferences(f.database, inspection, [{ ...f.decision, ...changes }]),
      ).toThrow();
    expect(() =>
      emitReferences(f.database, inspection, [f.decision, f.decision]),
    ).toThrow();
    expect(() =>
      emitReferences(f.database, inspection, [
        { ...f.decision, decision: "exclude" },
      ]),
    ).toThrow();
    const out = emitReferences(f.database, inspection, [
      f.decision,
      {
        candidateKey: f.key,
        messageId: f.ids[1],
        url: "https://docs.example.org/response",
        decision: "exclude",
      },
    ]);
    expect(Object.keys(out)).toEqual([f.key]);
  } finally {
    f.close();
  }
});

it.each([
  [
    "https://docs.example.org/Function_(topic)",
    "https://docs.example.org/Function_(topic)",
  ],
  [
    "https://docs.example.org/Function_(topic)).",
    "https://docs.example.org/Function_(topic)",
  ],
  [
    "https://docs.example.org/Function_(topic))]!?",
    "https://docs.example.org/Function_(topic)",
  ],
  ["https://docs.example.org/manual)", "https://docs.example.org/manual"],
])(
  "preserves URL parentheses and strips only surplus closing delimiters: %s",
  (token, expected) => {
    const f = fixture();
    try {
      const db = new Database(f.database);
      const row = db
        .prepare("SELECT record FROM ledger WHERE id=?")
        .get(f.ids[0]) as { record: string };
      const record = JSON.parse(row.record);
      record.message.body = `${raw} (${token}`;
      db.prepare("UPDATE ledger SET record=? WHERE id=?").run(
        JSON.stringify(record),
        f.ids[0],
      );
      db.close();
      const inspection = inspectReferences(f.database, [f.key]);
      expect(inspection.entries[0].references[0]).toEqual({
        messageId: f.ids[0],
        url: expected,
      });
      // Exact original attribution still applies: a clipped balanced path must
      // not become a second reference that an operator could accidentally allow.
      if (expected.endsWith(")"))
        expect(() =>
          emitReferences(f.database, inspection, [
            { ...f.decision, url: expected.slice(0, -1) },
          ]),
        ).toThrow();
      const supplements = emitReferences(f.database, inspection, [
        { ...f.decision, url: expected },
      ]);
      expect(supplements[f.key][0].url).toBe(expected);
      f.write("balanced-supplements.json", supplements);
      const prepared = f.run(
        "chat-editorial-batches",
        "prepare",
        "--candidate-keys",
        "data/chat-pipeline/keys.json",
        "--supplements",
        "data/chat-pipeline/balanced-supplements.json",
      );
      expect(prepared.status, prepared.stderr).toBe(0);
    } finally {
      f.close();
    }
  },
);

it("blocks risky URLs even when present in the actual ledger", () => {
  const f = fixture();
  try {
    for (const unsafe of [
      "http://docs.example.org/a",
      "https://127.0.0.1/a",
      "https://docs.internal/a",
      "https://user:pass@docs.example.org/a",
      "https://docs.example.org:8443/a",
      "https://docs.example.org/a?token=secret",
      "https://docs.example.org/a#secret",
      "https://docs.example.org/%73ecret",
      "https://docs.example.org/session/private",
      "https://docs.example.org/user@example.org",
      "https://docs.example.org/ghp_abcdefghijklmnop",
      "https://sk-abcdefghijklmnop.docs.example.org/manual",
      "https://docs.example.org/ghp_abcdefghijklmnop/../manual",
      "https://docs.example.org/abcdefghijklmnopqrstuvwxyz0123456789",
      "https://docs.example.org/비공개별명",
    ]) {
      const db = new Database(f.database);
      const row = db
        .prepare("SELECT record FROM ledger WHERE id=?")
        .get(f.ids[0]) as { record: string };
      const record = JSON.parse(row.record);
      record.message.body = `${raw} ${unsafe}`;
      db.prepare("UPDATE ledger SET record=? WHERE id=?").run(
        JSON.stringify(record),
        f.ids[0],
      );
      db.close();
      const inspection = inspectReferences(f.database, [f.key]);
      expect(inspection.entries[0].references).toEqual([
        { messageId: f.ids[1], url: "https://docs.example.org/response" },
      ]);
      expect(inspection.entries[0].excludedReferences).toBe(1);
      expect(inspection.entries[0].excludedReason).toBe(
        "unsafe-or-private-url",
      );
      expect(JSON.stringify(inspection)).not.toContain(unsafe);
      expect(() =>
        emitReferences(f.database, inspection, [
          { ...f.decision, url: unsafe },
        ]),
      ).toThrow();
    }
    const inspected = f.run(
      "chat-editorial-references",
      "inspect",
      "data/chat-pipeline/keys.json",
      "data/chat-pipeline/safe-only.json",
    );
    expect(inspected.status).toBe(0);
    const file = readFileSync(join(f.directory, "safe-only.json"), "utf8");
    expect(file).not.toContain("비공개별명");
    expect(JSON.parse(file).entries[0].excludedReferences).toBe(1);
  } finally {
    f.close();
  }
});

it.each([
  "https://docs.example.org/SyntheticBob/manual",
  "https://syntheticbob.docs.example.org/manual",
  "https://docs.example.org/sYnThEtIcBoB/manual",
])(
  "excludes another evidence author's name from URLs regardless of case: %s",
  (identifyingUrl) => {
    const f = fixture();
    try {
      const db = new Database(f.database);
      for (const [i, id] of f.ids.entries()) {
        const row = db
          .prepare("SELECT record FROM ledger WHERE id=?")
          .get(id) as { record: string };
        const record = JSON.parse(row.record);
        record.message.author = i === 0 ? "SyntheticAlice" : "SyntheticBob";
        if (i === 0) record.message.body = `${raw} ${identifyingUrl}`;
        db.prepare("UPDATE ledger SET record=? WHERE id=?").run(
          JSON.stringify(record),
          id,
        );
      }
      db.close();
      const inspection = inspectReferences(f.database, [f.key]);
      expect(inspection.entries[0].references).toEqual([
        { messageId: f.ids[1], url: "https://docs.example.org/response" },
      ]);
      expect(inspection.entries[0].excludedReferences).toBe(1);
      expect(JSON.stringify(inspection).toLowerCase()).not.toContain(
        "syntheticbob",
      );
      expect(() =>
        emitReferences(f.database, inspection, [
          { ...f.decision, url: identifyingUrl },
        ]),
      ).toThrow();
      const result = f.run(
        "chat-editorial-references",
        "inspect",
        "data/chat-pipeline/keys.json",
        "data/chat-pipeline/authors-private.json",
      );
      expect(result.status).toBe(0);
      expect(
        readFileSync(
          join(f.directory, "authors-private.json"),
          "utf8",
        ).toLowerCase(),
      ).not.toContain("syntheticbob");
    } finally {
      f.close();
    }
  },
);

it.each([
  ["title", "syntheticalice"],
  ["notes", "sYnThEtIcAlIcE"],
  ["title", "syntheticbob"],
  ["notes", "sYnThEtIcBoB"],
])(
  "rejects actual question/response author case variants in supplement %s: %s",
  (field, name) => {
    const f = fixture();
    try {
      const db = new Database(f.database);
      for (const [i, id] of f.ids.entries()) {
        const row = db
          .prepare("SELECT record FROM ledger WHERE id=?")
          .get(id) as { record: string };
        const record = JSON.parse(row.record);
        record.message.author = i === 0 ? "SyntheticAlice" : "SyntheticBob";
        db.prepare("UPDATE ledger SET record=? WHERE id=?").run(
          JSON.stringify(record),
          id,
        );
      }
      db.close();
      const inspection = inspectReferences(f.database, [f.key]);
      expect(
        emitReferences(f.database, inspection, [f.decision])[f.key][0].url,
      ).toBe(url);
      expect(() =>
        emitReferences(f.database, inspection, [
          { ...f.decision, [field]: `${name}의 기술 설명` },
        ]),
      ).toThrow("editorial-reference-validation-failed");
    } finally {
      f.close();
    }
  },
);

it("blocks stale inspection, held/unresolved evidence, missing selection and inactive runs", () => {
  const f = fixture();
  try {
    const inspection = inspectReferences(f.database, [f.key]);
    expect(() => inspectReferences(f.database, ["a".repeat(64)])).toThrow();
    expect(() => inspectReferences(f.database, [f.key, f.key])).toThrow();
    const db = new Database(f.database);
    db.prepare("UPDATE coverage SET held=1 WHERE message_id=?").run(f.ids[1]);
    expect(() =>
      emitReferences(f.database, inspection, [f.decision]),
    ).toThrow();
    db.exec("UPDATE coverage SET held=0");
    const row = db.prepare("SELECT record FROM candidate_links").get() as {
      record: string;
    };
    const record = JSON.parse(row.record);
    db.prepare("UPDATE candidate_links SET record=?").run(
      JSON.stringify({ ...record, needsContext: true }),
    );
    expect(() => inspectReferences(f.database, [f.key])).toThrow();
    db.prepare("UPDATE candidate_links SET record=?").run(row.record);
    const altered = structuredClone(inspection);
    altered.entries[0].responseIds = [];
    expect(() => emitReferences(f.database, altered, [f.decision])).toThrow();
    const evidence = db
      .prepare("SELECT record FROM ledger WHERE id=?")
      .get(f.ids[0]) as { record: string };
    const changed = JSON.parse(evidence.record);
    changed.message.body += " https://docs.example.org/additional";
    db.prepare("UPDATE ledger SET record=? WHERE id=?").run(
      JSON.stringify(changed),
      f.ids[0],
    );
    expect(() =>
      emitReferences(f.database, inspection, [f.decision]),
    ).toThrow();
    db.prepare("UPDATE ledger SET record=? WHERE id=?").run(
      evidence.record,
      f.ids[0],
    );
    db.exec("UPDATE runs SET active=0");
    expect(() =>
      emitReferences(f.database, inspection, [f.decision]),
    ).toThrow();
    db.exec("UPDATE runs SET active=1");
    db.prepare("DELETE FROM ledger WHERE id=?").run(f.ids[1]);
    expect(() => inspectReferences(f.database, [f.key])).toThrow();
    db.close();
  } finally {
    f.close();
  }
});

it("keeps CLI files private, refuses overwrite and redacts errors", () => {
  const f = fixture();
  try {
    f.write("existing.json", { preserve: true });
    for (const target of ["data/chat-pipeline/existing.json", "outside.json"]) {
      const result = f.run(
        "chat-editorial-references",
        "inspect",
        "data/chat-pipeline/keys.json",
        target,
      );
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("editorial-references-failed");
      expect(result.stdout).toBe("");
    }
    expect(
      JSON.parse(readFileSync(join(f.directory, "existing.json"), "utf8")),
    ).toEqual({ preserve: true });
    mkdirSync(join(f.root, "outside"));
    symlinkSync(
      join(f.root, "outside"),
      join(f.directory, "escape"),
      "junction",
    );
    const escape = f.run(
      "chat-editorial-references",
      "inspect",
      "data/chat-pipeline/keys.json",
      "data/chat-pipeline/escape/inspect.json",
    );
    expect(escape.status).toBe(1);
  } finally {
    f.close();
  }
});

it("rejects the private root itself when a junction redirects outside project/data", () => {
  const f = fixture();
  try {
    const outside = join(f.root, "outside-private-root");
    if (
      !resolve(f.directory).startsWith(resolve(f.root) + sep) ||
      !resolve(outside).startsWith(resolve(f.root) + sep)
    )
      throw Error();
    renameSync(f.directory, outside);
    symlinkSync(outside, f.directory, "junction");
    const before = readFileSync(join(outside, "jobs.sqlite"));
    const result = f.run(
      "chat-editorial-references",
      "inspect",
      "data/chat-pipeline/keys.json",
      "data/chat-pipeline/escaped.json",
    );
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("editorial-references-failed");
    expect(result.stdout).toBe("");
    expect(existsSync(join(outside, "escaped.json"))).toBe(false);
    expect(readFileSync(join(outside, "jobs.sqlite"))).toEqual(before);
  } finally {
    f.close();
  }
});
