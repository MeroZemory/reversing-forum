import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { prepareChats, validateBatchOutput, hash } from "./prepare";
import type {
  PrepareOptions,
  PreparedBatch,
  BatchCandidate,
  BatchOutput,
} from "./prepare";
import type { ChatSourceInput } from "./types";

/** Private offline store, unrelated to the site DB or publication permissions.
 * On Windows, deployment must restrict directory ACLs; POSIX mode is best effort.
 */
export class ChatJobStore {
  private db: Database.Database;
  readonly directory: string;
  constructor(directory = "data/chat-pipeline") {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.db = new Database(join(this.directory, "jobs.sqlite"));
    chmodSync(join(this.directory, "jobs.sqlite"), 0o600);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = DELETE");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, config TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sources (run_id TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL, manifest TEXT NOT NULL, PRIMARY KEY(run_id,id));
      CREATE TABLE IF NOT EXISTS occurrences (id TEXT PRIMARY KEY, canonical_id TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger (run_id TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL, position INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(run_id,id));
      CREATE TABLE IF NOT EXISTS dispositions (run_id TEXT NOT NULL REFERENCES runs(id), source_id TEXT NOT NULL, position INTEGER NOT NULL, kind TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(run_id,source_id,position));
      CREATE TABLE IF NOT EXISTS dedupe (run_id TEXT PRIMARY KEY REFERENCES runs(id), record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), input_hash TEXT NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL, output_hash TEXT);
      CREATE TABLE IF NOT EXISTS coverage (batch_id TEXT NOT NULL REFERENCES jobs(id), message_id TEXT NOT NULL, held INTEGER NOT NULL, PRIMARY KEY(batch_id,message_id));
      CREATE TABLE IF NOT EXISTS outputs (batch_id TEXT PRIMARY KEY REFERENCES jobs(id), hash TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS output_attempts (id INTEGER PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES jobs(id), hash TEXT NOT NULL, error TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates (candidate_key TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidate_questions (candidate_key TEXT NOT NULL REFERENCES candidates(candidate_key), message_id TEXT NOT NULL, PRIMARY KEY(candidate_key,message_id));
      CREATE TABLE IF NOT EXISTS candidate_links (batch_id TEXT NOT NULL REFERENCES jobs(id), local_id TEXT NOT NULL, candidate_key TEXT NOT NULL REFERENCES candidates(candidate_key), record TEXT NOT NULL, PRIMARY KEY(batch_id,local_id));
      CREATE INDEX IF NOT EXISTS coverage_message ON coverage(message_id,batch_id);
      CREATE INDEX IF NOT EXISTS jobs_run ON jobs(run_id);
      CREATE INDEX IF NOT EXISTS candidate_question_message ON candidate_questions(message_id,candidate_key);
    `);
  }
  close() {
    this.db.close();
  }
  private writePrivate(relative: string, value: unknown): string {
    const path = join(this.directory, relative);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temp, path);
    return path;
  }
  prepare(inputs: readonly ChatSourceInput[], options: PrepareOptions = {}) {
    const mapping = new Map(
      (
        this.db
          .prepare("SELECT id,canonical_id FROM occurrences")
          .all() as Array<{ id: string; canonical_id: string }>
      ).map((r) => [r.id, r.canonical_id]),
    );
    const run = prepareChats(inputs, options, mapping);
    const insertSource = this.db.prepare(
      "INSERT OR IGNORE INTO sources VALUES(?,?,?)",
    );
    const insertDisposition = this.db.prepare(
      "INSERT OR IGNORE INTO dispositions VALUES(?,?,?,?,?)",
    );
    const insertLedger = this.db.prepare(
      "INSERT OR IGNORE INTO ledger VALUES(?,?,?,?)",
    );
    const insertOccurrence = this.db.prepare(
      "INSERT OR IGNORE INTO occurrences VALUES(?,?,?)",
    );
    const insertJob = this.db.prepare(
      "INSERT OR IGNORE INTO jobs(id,run_id,input_hash,state,record) VALUES(?,?,?,?,?)",
    );
    const insertCoverage = this.db.prepare(
      "INSERT OR IGNORE INTO coverage VALUES(?,?,?)",
    );
    this.db.transaction(() => {
      this.db.prepare("UPDATE runs SET active=0").run();
      this.db
        .prepare(
          "INSERT INTO runs(id,config,active) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET active=1",
        )
        .run(run.runId, JSON.stringify(run.options));
      for (const chat of run.chats) {
        insertSource.run(
          run.runId,
          chat.source.id,
          JSON.stringify(chat.manifest),
        );
        chat.classifiedRanges.forEach((range, i) =>
          insertDisposition.run(
            run.runId,
            chat.source.id,
            i,
            range.kind,
            JSON.stringify(range),
          ),
        );
      }
      this.db
        .prepare("INSERT OR IGNORE INTO dedupe VALUES(?,?)")
        .run(run.runId, JSON.stringify(run.dedupe));
      const original = new Map(
        run.chats.flatMap((c) =>
          c.messages.map((m) => [m.occurrenceId, m] as const),
        ),
      );
      run.canonical.forEach((entry, i) => {
        insertLedger.run(run.runId, entry.id, i, JSON.stringify(entry));
        for (const id of entry.occurrenceIds)
          insertOccurrence.run(id, entry.id, JSON.stringify(original.get(id)));
      });
      for (const batch of run.batches) {
        insertJob.run(
          batch.batchId,
          run.runId,
          batch.inputHash,
          batch.state,
          JSON.stringify(batch),
        );
        for (const message of batch.input.messages)
          insertCoverage.run(batch.batchId, message.id, Number(message.held));
      }
    })();
    // Durable DB is authoritative. Interrupted file writes can be repaired by prepare.
    const files = run.batches.map((batch) =>
      this.writePrivate(`runs/${run.runId}/${batch.batchId}.input.json`, {
        batchId: batch.batchId,
        inputHash: batch.inputHash,
        state: batch.state,
        localPrivateReviewOnly: batch.state !== "ready",
        anonymityGuaranteed: false,
        ...batch.input,
      }),
    );
    const manifest = this.writePrivate(`runs/${run.runId}/manifest.json`, {
      runId: run.runId,
      options: run.options,
      counts: {
        sources: run.chats.length,
        occurrences: originalCount(run.chats),
        canonical: run.canonical.length,
        batches: run.batches.length,
      },
      batches: run.batches.map((b, i) => ({
        batchId: b.batchId,
        inputHash: b.inputHash,
        state: b.state,
        file: files[i],
      })),
    });
    return {
      runId: run.runId,
      manifest,
      directory: dirname(manifest),
      ...this.summary(),
    };
  }
  listBatches(ids?: readonly string[]) {
    if (ids?.length === 0) return [];
    if (ids && (ids.length > 100 || new Set(ids).size !== ids.length))
      throw new Error("invalid-batch-selection");
    return (
      this.db
        .prepare(
          "SELECT j.record,j.state,j.output_hash FROM jobs j JOIN runs r ON r.id=j.run_id WHERE r.active=1" +
            (ids ? ` AND j.id IN (${ids.map(() => "?").join(",")})` : "") +
            " ORDER BY j.rowid",
        )
        .all(...(ids ?? [])) as Array<{
        record: string;
        state: string;
        output_hash: string | null;
      }>
    ).map((r) => ({
      ...(JSON.parse(r.record) as PreparedBatch),
      status: r.output_hash ? "completed" : r.state,
    }));
  }
  listCandidates() {
    const grouped = new Map<string, BatchCandidate>();
    for (const row of this.db
      .prepare(
        `SELECT l.candidate_key,l.record FROM candidate_links l JOIN jobs j ON j.id=l.batch_id JOIN runs r ON r.id=j.run_id WHERE r.active=1 ORDER BY l.rowid`,
      )
      .all() as Array<{ candidate_key: string; record: string }>) {
      const next = JSON.parse(row.record) as BatchCandidate;
      const previous = grouped.get(row.candidate_key);
      grouped.set(
        row.candidate_key,
        previous
          ? {
              ...previous,
              questionIds: [
                ...new Set([...previous.questionIds, ...next.questionIds]),
              ].sort(),
              responseIds: [
                ...new Set([...previous.responseIds, ...next.responseIds]),
              ].sort(),
              uncertainties: [
                ...new Set([...previous.uncertainties, ...next.uncertainties]),
              ],
              needsContext: previous.needsContext || next.needsContext,
            }
          : next,
      );
    }
    return [...grouped].map(([candidateKey, record]) => ({
      candidateKey,
      ...record,
    }));
  }
  importResult(
    batchId: string,
    raw: string,
    options: { summary?: boolean } = {},
  ) {
    const row = this.db
      .prepare(
        "SELECT j.*,r.active FROM jobs j JOIN runs r ON r.id=j.run_id WHERE j.id=?",
      )
      .get(batchId) as
      | {
          record: string;
          state: string;
          output_hash: string | null;
          active: number;
        }
      | undefined;
    if (!row) throw new Error("unknown-batch");
    const outputHash = hash(raw);
    try {
      const result = this.db.transaction(() => {
        // Always check current run before honoring an idempotent replay.
        const current = this.db
          .prepare(
            "SELECT j.output_hash,r.active FROM jobs j JOIN runs r ON r.id=j.run_id WHERE j.id=?",
          )
          .get(batchId) as { output_hash: string | null; active: number };
        if (!current.active) throw new Error("stale-batch-version");
        const batch = JSON.parse(row.record) as PreparedBatch;
        const output = validateBatchOutput(raw, batch);
        if (current.output_hash) {
          if (current.output_hash !== outputHash)
            throw new Error("conflicting-batch-output");
          return { imported: 0, replay: true };
        }
        const linked: Array<{
          localId: string;
          candidateKey: string;
          record: BatchCandidate;
          ambiguous: boolean;
        }> = [];
        for (const candidate of output.candidates) {
          const questions = [...candidate.questionIds].sort();
          const existing = new Set<string>();
          for (const id of questions) {
            const matches = this.db
              .prepare(
                "SELECT candidate_key FROM candidate_questions WHERE message_id=?",
              )
              .all(id) as Array<{ candidate_key: string }>;
            for (const match of matches) existing.add(match.candidate_key);
          }
          // Only unambiguous overlapping question evidence connects automatically.
          // Semantic similarity never merges unrelated discussions.
          const candidateKey =
            existing.size === 1
              ? [...existing][0]
              : hash(["candidate-v1", questions]);
          const ambiguous = existing.size > 1;
          this.db
            .prepare("INSERT OR IGNORE INTO candidates VALUES(?,?)")
            .run(candidateKey, JSON.stringify(candidate));
          for (const id of questions)
            this.db
              .prepare("INSERT OR IGNORE INTO candidate_questions VALUES(?,?)")
              .run(candidateKey, id);
          this.db.prepare("INSERT INTO candidate_links VALUES(?,?,?,?)").run(
            batchId,
            candidate.localId,
            candidateKey,
            JSON.stringify({
              ...candidate,
              needsContext: candidate.needsContext || ambiguous,
            }),
          );
          linked.push({
            localId: candidate.localId,
            candidateKey,
            record: candidate,
            ambiguous,
          });
        }
        this.db
          .prepare("INSERT INTO outputs VALUES(?,?,?)")
          .run(
            batchId,
            outputHash,
            JSON.stringify({ output, linked, mode: "private-candidates-only" }),
          );
        this.db
          .prepare("UPDATE jobs SET output_hash=? WHERE id=?")
          .run(outputHash, batchId);
        return { imported: linked.length, replay: false };
      })();
      return options.summary === false
        ? result
        : { ...result, ...this.summary() };
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid-output";
      this.db
        .prepare(
          "INSERT INTO output_attempts(batch_id,hash,error) VALUES(?,?,?)",
        )
        .run(batchId, outputHash, code);
      throw error;
    }
  }
  summary() {
    const count = (sql: string) =>
      (this.db.prepare(sql).get() as { n: number }).n;
    const base = " FROM jobs j JOIN runs r ON r.id=j.run_id WHERE r.active=1";
    const total = count(
      "SELECT COUNT(*) AS n FROM ledger l JOIN runs r ON r.id=l.run_id WHERE r.active=1",
    );
    const held = count(
      "SELECT COUNT(DISTINCT c.message_id) AS n FROM coverage c JOIN jobs j ON j.id=c.batch_id JOIN runs r ON r.id=j.run_id WHERE r.active=1 AND c.held=1",
    );
    const withCandidate = count(
      `SELECT COUNT(DISTINCT q.message_id) AS n FROM candidate_questions q JOIN candidate_links cl ON cl.candidate_key=q.candidate_key JOIN jobs j ON j.id=cl.batch_id JOIN runs r ON r.id=j.run_id WHERE r.active=1`,
    );
    const completed = count(
      "SELECT COUNT(*) AS n" + base + " AND j.output_hash IS NOT NULL",
    );
    const dispositions = this.messageDispositionCounts();
    return {
      sources: count(
        "SELECT COUNT(*) AS n FROM sources s JOIN runs r ON r.id=s.run_id WHERE r.active=1",
      ),
      canonicalMessages: total,
      coveredMessages: count(
        "SELECT COUNT(DISTINCT c.message_id) AS n FROM coverage c JOIN jobs j ON j.id=c.batch_id JOIN runs r ON r.id=j.run_id WHERE r.active=1",
      ),
      inputDispositions: count(
        "SELECT COUNT(*) AS n FROM dispositions d JOIN runs r ON r.id=d.run_id WHERE r.active=1",
      ),
      unparsedRanges: count(
        "SELECT COUNT(*) AS n FROM dispositions d JOIN runs r ON r.id=d.run_id WHERE r.active=1 AND d.kind='unparsed'",
      ),
      batches: count("SELECT COUNT(*) AS n" + base),
      completedBatches: completed,
      remainingBatches: count(
        "SELECT COUNT(*) AS n" + base + " AND j.output_hash IS NULL",
      ),
      heldMessages: held,
      pendingMessages: dispositions.pending,
      candidateQuestionMessages: withCandidate,
      candidates: this.listCandidates().length,
      messageDispositions: dispositions,
      privateOnly: true,
    };
  }
  private messageDispositionCounts() {
    const evidence = new Set<string>(),
      noncandidate = new Set<string>(),
      context = new Set<string>();
    const held = new Set<string>(),
      pending = new Set<string>(),
      all = new Set<string>();
    const rows = this.db
      .prepare(
        `SELECT j.record,o.record AS output FROM jobs j JOIN runs r ON r.id=j.run_id LEFT JOIN outputs o ON o.batch_id=j.id WHERE r.active=1`,
      )
      .all() as Array<{ record: string; output: string | null }>;
    for (const row of rows) {
      const batch = JSON.parse(row.record) as PreparedBatch;
      for (const message of batch.input.messages) {
        all.add(message.id);
        if (message.held) held.add(message.id);
        else if (!row.output) pending.add(message.id);
      }
      if (!row.output) continue;
      const { output } = JSON.parse(row.output) as { output: BatchOutput };
      for (const candidate of output.candidates)
        for (const id of [...candidate.questionIds, ...candidate.responseIds])
          evidence.add(id);
      for (const d of output.dispositions ?? [])
        (d.kind === "noncandidate" ? noncandidate : context).add(d.messageId);
    }
    const counts = {
      held: 0,
      candidate: 0,
      pending: 0,
      needsContext: 0,
      noncandidate: 0,
      reviewedUnclassified: 0,
    };
    for (const id of all) {
      const kind = held.has(id)
        ? "held"
        : evidence.has(id)
          ? "candidate"
          : pending.has(id)
            ? "pending"
            : context.has(id)
              ? "needsContext"
              : noncandidate.has(id)
                ? "noncandidate"
                : "reviewedUnclassified";
      counts[kind]++;
    }
    return counts;
  }
}
function originalCount(chats: ReturnType<typeof prepareChats>["chats"]) {
  return chats.reduce((count, chat) => count + chat.messages.length, 0);
}
