import Database from "better-sqlite3";
import { ChatJobStore } from "./job-store";
import { sanitizeText } from "./prepare";

type Reference = { messageId: string; url: string };
type Entry = {
  candidateKey: string;
  questionIds: string[];
  responseIds: string[];
  references: Reference[];
  excludedReferences: number;
  excludedReason: "unsafe-or-private-url";
};
export type ReferenceInspection = { runId: string; entries: Entry[] };
export type ReferenceDecision = Reference & {
  candidateKey: string;
  decision: "allow" | "exclude";
  // Means actually checked as a public technical document, with independently
  // written title/notes and no identity, original prose or secrets.
  checked?: true;
  title?: string;
  notes?: string;
};

function fail(): never {
  throw new Error("editorial-reference-validation-failed");
}

export function inspectReferences(
  database: string,
  keys: unknown,
): ReferenceInspection {
  if (
    !Array.isArray(keys) ||
    !keys.length ||
    keys.some((k) => typeof k !== "string" || !/^[a-f0-9]{64}$/.test(k)) ||
    new Set(keys).size !== keys.length
  )
    fail();
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const runs = db.prepare("SELECT id FROM runs WHERE active=1").all() as {
        id: string;
      }[];
      if (runs.length !== 1) fail();
      // Reuse the existing active/context-recovery projection without invoking
      // its schema-writing constructor. These methods only read this connection.
      const store = Object.assign(Object.create(ChatJobStore.prototype), {
        db,
      }) as ChatJobStore;
      const candidates = store.listCandidates();
      const minimized = new Map(
        store
          .listBatches()
          .flatMap((b) => b.input.messages.map((m) => [m.id, m] as const)),
      );
      const held = new Set(
        (
          db
            .prepare(
              "SELECT c.message_id FROM coverage c JOIN jobs j ON j.id=c.batch_id JOIN runs r ON r.id=j.run_id WHERE r.active=1 AND c.held=1",
            )
            .all() as { message_id: string }[]
        ).map((r) => r.message_id),
      );
      const entries = keys.map((key) => {
        const c = candidates.find((c) => c.candidateKey === key);
        if (!c || c.needsContext !== false || !c.questionIds.length) fail();
        const references: Reference[] = [];
        let excludedReferences = 0;
        const selected = [...new Set([...c.questionIds, ...c.responseIds])].map(
          (id) => {
            const m = minimized.get(id);
            const row = db
              .prepare("SELECT record FROM ledger WHERE run_id=? AND id=?")
              .get(runs[0].id, id) as { record: string } | undefined;
            if (!m || m.held || held.has(id) || !row) fail();
            const original = JSON.parse(row.record).message;
            return { id, m, original };
          },
        );
        const authors = selected
          .map(({ original }) => original.author)
          .filter(
            (author): author is string =>
              typeof author === "string" && !!author,
          );
        for (const { id, m, original } of selected) {
          const body = original.body;
          if (typeof body !== "string") fail();
          for (const url of new Set(
            body.match(/https?:\/\/[^\s<>"`]+/gi) ?? [],
          )) {
            let value = url.replace(/[.,;!?]+$/, "");
            // A document path may itself end in balanced parentheses/brackets.
            // Remove only surplus closing delimiters from the surrounding prose.
            while (/[)\]]$/.test(value)) {
              const close = value.at(-1)!;
              const open = close === ")" ? "(" : "[";
              const count = (character: string) =>
                [...value].filter((c) => c === character).length;
              if (count(close) <= count(open)) break;
              value = value.slice(0, -1).replace(/[.,;!?]+$/, "");
            }
            // Legacy minimization can use a different removal marker. Match
            // actual missing URLs instead of relying on the marker spelling.
            if (m.text.includes(value)) continue;
            if (
              safeReferenceUrl(value) &&
              !authors.some((author) =>
                value.toLowerCase().includes(author.toLowerCase()),
              )
            )
              references.push({ messageId: id, url: value });
            else excludedReferences++;
          }
        }
        return {
          candidateKey: key,
          questionIds: c.questionIds,
          responseIds: c.responseIds,
          references,
          excludedReferences,
          excludedReason: "unsafe-or-private-url" as const,
        };
      });
      return { runId: runs[0].id, entries };
    })();
  } finally {
    db.close();
  }
}

function safeReferenceUrl(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  // More conservative than prepare's validator: query, fragment and percent
  // escapes cannot carry identifiers or credentials through this bridge.
  // Inspect raw authority labels and the path before URL parsing can discard
  // dot segments. Splitting DNS labels avoids treating every public domain as
  // a personal reference in the existing sanitizer.
  const raw = value.slice("https://".length);
  const authority = raw.split(/[/?#]/, 1)[0];
  const privatePart = [
    ...authority.split("."),
    raw.slice(authority.length).split(/[?#]/, 1)[0],
  ].some((part) => {
    const safe = sanitizeText(part, new Map());
    return safe.held || safe.text !== part;
  });
  if (
    value.length > 2048 ||
    !value.startsWith("https://") ||
    /[\s\\<>"`%\u0000-\u001f\u007f-\uffff]/.test(value) ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(u.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/i.test(
      u.hostname,
    ) ||
    /auth|token|secret|password|credential|signature|session|api[-_]?key/i.test(
      value,
    ) ||
    privatePart ||
    /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(value)
  )
    return false;
  return true;
}

function publicSource(d: ReferenceDecision) {
  if (d.checked !== true || !safeReferenceUrl(d.url)) fail();
  for (const [value, limit] of [
    [d.title, 200],
    [d.notes, 4000],
  ] as const) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value !== value.trim() ||
      value.length > limit ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      fail();
  }
  const prose = `${d.title}\n${d.notes}`;
  const safe = sanitizeText(prose, new Map());
  if (
    safe.held ||
    safe.text !== prose ||
    /\b(?:token|credential)\s*[:=]/i.test(prose)
  )
    fail();
  return { title: d.title!, url: d.url, notes: d.notes! };
}

export function emitReferences(
  database: string,
  inspection: ReferenceInspection,
  decisions: unknown,
) {
  if (
    !inspection ||
    !Array.isArray(inspection.entries) ||
    !Array.isArray(decisions) ||
    !decisions.length
  )
    fail();
  const current = inspectReferences(
    database,
    inspection.entries.map((e) => e.candidateKey),
  );
  if (JSON.stringify(current) !== JSON.stringify(inspection)) fail();
  const db = new Database(database, { readonly: true, fileMustExist: true });
  const output: Record<
    string,
    { title: string; url: string; notes: string }[]
  > = {};
  const seen = new Set<string>();
  try {
    for (const d of decisions as ReferenceDecision[]) {
      if (
        !d ||
        typeof d !== "object" ||
        Object.keys(d).some(
          (k) =>
            ![
              "candidateKey",
              "messageId",
              "url",
              "decision",
              "checked",
              "title",
              "notes",
            ].includes(k),
        )
      )
        fail();
      const entry = current.entries.find(
        (e) => e.candidateKey === d.candidateKey,
      );
      if (
        !entry?.references.some(
          (r) => r.messageId === d.messageId && r.url === d.url,
        )
      )
        fail();
      const identity = JSON.stringify([d.candidateKey, d.messageId, d.url]);
      if (seen.has(identity)) fail();
      seen.add(identity);
      if (d.decision === "exclude") continue;
      if (d.decision !== "allow") fail();
      const source = publicSource(d);
      // The 12-character overlap check only detects literal reuse. Operators
      // remain responsible for distinct original expressions and paraphrases;
      // the new public body still needs the existing independent body review.
      // No raw evidence is sent to a model by this reference tool.
      const prose = `${source.title}\n${source.notes}`;
      for (const id of new Set([...entry.questionIds, ...entry.responseIds])) {
        const row = db
          .prepare("SELECT record FROM ledger WHERE run_id=? AND id=?")
          .get(current.runId, id) as { record: string };
        const m = JSON.parse(row.record).message;
        if (
          typeof m.author === "string" &&
          m.author &&
          prose.toLowerCase().includes(m.author.toLowerCase())
        )
          fail();
        const body = m.body.replace(/https?:\/\/\S+/g, "").trim();
        for (let i = 0; i <= body.length - 12; i++)
          if (prose.includes(body.slice(i, i + 12))) fail();
      }
      const sources = (output[d.candidateKey] ??= []);
      if (sources.some((s) => s.url === source.url) || sources.length >= 8)
        fail();
      sources.push(source);
    }
    if (
      !Object.keys(output).length ||
      Buffer.byteLength(JSON.stringify(output)) > 128_000
    )
      fail();
    return output;
  } finally {
    db.close();
  }
}
