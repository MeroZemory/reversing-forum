import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Official Jev 1.13 input price checked on 2026-10-02; output is free.
export const JEV_INPUT_USD_PER_MILLION = 0.042;
const maximumRequestUsd = (64_000 * JEV_INPUT_USD_PER_MILLION) / 1_000_000;

export class JevBudget {
  private store: Database.Database;
  constructor(
    path: string,
    readonly limitUsd: number,
  ) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > 10)
      throw new Error("invalid-jev-budget");
    if (path !== ":memory:")
      mkdirSync(dirname(resolve(path)), { recursive: true });
    this.store = new Database(path);
    this.store.pragma("busy_timeout = 5000");
    this.store.exec(`CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, reserved_usd REAL NOT NULL,
      actual_usd REAL, input_tokens INTEGER, resolved_model TEXT,
      state TEXT NOT NULL CHECK(state IN ('reserved','settled')),
      created_at TEXT NOT NULL
    )`);
  }
  reserve(): string | null {
    return this.store
      .transaction(() => {
        const used = this.summary().chargedOrReservedUsd;
        if (used + maximumRequestUsd > this.limitUsd) return null;
        const id = randomUUID();
        this.store
          .prepare(
            "INSERT INTO requests VALUES(?,?,NULL,NULL,NULL,'reserved',?)",
          )
          .run(id, maximumRequestUsd, new Date().toISOString());
        return id;
      })
      .immediate();
  }
  settle(id: string, model: unknown, inputTokens: unknown): boolean {
    if (
      model !== "jev-1.13.0" ||
      !Number.isSafeInteger(inputTokens) ||
      (inputTokens as number) < 0 ||
      (inputTokens as number) > 64_000
    )
      return false;
    const actual =
      ((inputTokens as number) * JEV_INPUT_USD_PER_MILLION) / 1_000_000;
    return (
      this.store
        .prepare(
          "UPDATE requests SET actual_usd=?,input_tokens=?,resolved_model=?,state='settled' WHERE id=? AND state='reserved'",
        )
        .run(actual, inputTokens, model, id).changes === 1
    );
  }
  summary() {
    const row = this.store
      .prepare(
        `SELECT COUNT(*) requests,
      COALESCE(SUM(COALESCE(actual_usd,reserved_usd)),0) chargedOrReservedUsd,
      COALESCE(SUM(CASE WHEN state='reserved' THEN 1 ELSE 0 END),0) unknownRequests
      FROM requests`,
      )
      .get() as {
      requests: number;
      chargedOrReservedUsd: number;
      unknownRequests: number;
    };
    return { ...row, limitUsd: this.limitUsd };
  }
  close() {
    this.store.close();
  }
}

let configured: { key: string; ledger: JevBudget } | undefined;
export function configuredJevBudget(): JevBudget | undefined {
  const limit = process.env.JEV_BUDGET_USD;
  if (limit === undefined) return undefined;
  const path = process.env.JEV_BUDGET_PATH || "data/jev-budget.sqlite";
  const key = `${path}:${limit}`;
  if (configured?.key !== key) {
    configured?.ledger.close();
    configured = { key, ledger: new JevBudget(path, Number(limit)) };
  }
  return configured.ledger;
}
