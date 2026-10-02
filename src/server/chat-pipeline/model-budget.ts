import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const PROXY_BASIS = {
  kind: "relative-usage-proxy-not-api-spend",
  source: "https://learn.chatgpt.com/docs/pricing",
  checkedAt: "2026-10-02",
  creditsPerProxyUsd: 25,
  method:
    "Standard credit weights / 25; weekly quota requires separate measured calibration",
} as const;
export const MODEL_WEIGHTS = {
  "gpt-6.1-sol": { input: 50, cached: 2.5, output: 250 },
  "gpt-6-luna": { input: 2.5, cached: 0.25, output: 12.5 },
} as const;
export type BudgetModel = keyof typeof MODEL_WEIGHTS;
export type BatchMode = "candidate" | "draft" | "review";
export function cliDiagnosticCodes(stderr: string): string[] {
  const patterns: Record<string, RegExp> = {
    invalid_mcp_transport: /invalid transport/i,
    invalid_json_schema:
      /invalid_json_schema|invalid (?:response|json|output).*schema/i,
    invalid_config:
      /error (?:loading|parsing).*config|invalid.*config|failed to (?:load|parse).*config/i,
    unsupported_feature:
      /unknown feature|unrecognized feature|unsupported feature/i,
    unsupported_reasoning_effort:
      /reasoning.*(?:unsupported|not supported|invalid)/i,
    code_mode_configuration:
      /code.?mode.*(?:requires|disabled|error|invalid|must)/i,
    sandbox_failure:
      /sandbox.*(?:failed|error|denied|unavailable)|failed.*sandbox/i,
    authentication_failure:
      /unauthorized|authentication.*(?:failed|error)|invalid_api_key|401\b/i,
    rate_limit: /rate_limit|quota exceeded|429\b/i,
    model_unavailable:
      /model_not_found|model.*(?:not supported|does not exist|unavailable)/i,
    network_failure:
      /connection (?:refused|reset)|failed to send request|error sending request|stream disconnected/i,
    argument_error:
      /unexpected argument|invalid value.*(?:--|argument)|unrecognized (?:option|argument)/i,
    output_file_failure:
      /(?:failed|unable|cannot|error).*?(?:output file|last.message|write.*file)/i,
  };
  const codes = Object.entries(patterns)
    .filter(([, pattern]) => pattern.test(stderr))
    .map(([code]) => code);
  return codes.length
    ? codes
    : stderr.trim()
      ? ["unclassified_cli_diagnostic"]
      : [];
}
export function privateCliDiagnostic(stderr: string, prompt: string): string {
  return stderr
    .slice(0, 64_000)
    .split(/\r?\n/)
    .filter(
      (line) =>
        /error|invalid|unsupported|failed|unexpected|caused by|panic|schema|config|permission/i.test(
          line,
        ) &&
        !prompt.includes(line.trim()) &&
        !line.includes(prompt) &&
        !line.includes("권한이 제한된 일괄 데이터 처리"),
    )
    .map((line) =>
      line
        .replace(/https?:\/\/\S+/gi, "[URL]")
        .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
        .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
        .replace(
          /((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*).*/gi,
          "$1[REDACTED]",
        )
        .replace(/\b[A-Za-z0-9_+\/-]{40,}={0,2}\b/g, "[REDACTED-LONG-VALUE]"),
    )
    .join("\n")
    .slice(0, 16_000);
}
// A section-header-only TOML reader: values (including credentials) are never
// parsed or returned. Root [mcp_servers] is a valid container with no server name.
export function mcpServerName(line: string): string | null {
  const header = line.trimStart();
  if (!header.startsWith("[") || header.startsWith("[[")) return null;
  const keys: string[] = [];
  let index = 1;
  const skipSpace = () => {
    while (/\s/.test(header[index] ?? "") && index < header.length) index++;
  };
  try {
    while (index < header.length) {
      skipSpace();
      const quote = header[index];
      if (quote === '"' || quote === "'") {
        const start = index++;
        while (index < header.length) {
          if (quote === '"' && header[index] === "\\") {
            index += 2;
            continue;
          }
          if (header[index++] === quote) break;
        }
        const raw = header.slice(start, index);
        if (!raw.endsWith(quote) || raw.length < 2) throw new Error();
        keys.push(
          quote === "'"
            ? raw.slice(1, -1)
            : JSON.parse(
                raw.replace(/\\U([0-9a-fA-F]{8})/g, (_, hex: string) =>
                  String.fromCodePoint(parseInt(hex, 16)),
                ),
              ),
        );
      } else {
        const key = header.slice(index).match(/^[A-Za-z0-9_-]+/);
        if (!key) throw new Error();
        keys.push(key[0]);
        index += key[0].length;
      }
      skipSpace();
      if (header[index] === ".") {
        index++;
        continue;
      }
      if (header[index++] !== "]" || !/^\s*(?:#.*)?$/.test(header.slice(index)))
        throw new Error();
      return keys[0] === "mcp_servers" && keys.length > 1 ? keys[1] : null;
    }
    throw new Error();
  } catch {
    // Unsupported MCP section syntax fails closed without exposing its content.
    if (keys[0] === "mcp_servers" || /^\[\s*mcp_servers/.test(header))
      throw new Error("unsupported-mcp-config-shape");
    return null;
  }
}
export interface ModelUsage {
  inputTokens: number; // Includes cached input.
  cachedInputTokens: number;
  outputTokens: number; // Includes reasoning; never add reasoning again.
}
// External private configuration. Dates are the account's measured weekly window,
// not a calendar-week guess. No official subscription denominator is assumed.
export interface ModelBudgetConfig {
  accountId: string;
  parentThreadId?: string;
  weekStart?: string;
  weekEnd?: string;
  batchStartedAt?: string;
  weeklyProxyUsd: { low: number; central: number; high: number };
  maxPercent: number;
  source?: string;
  sources?: string[];
  basis?: string;
  creditsPerProxyUsd?: number;
  method: string;
  reservation?: {
    safetyFactor?: number;
    promptBytesPerToken?: number;
    extraInputTokens?: number;
    outputTokens?: Partial<Record<BatchMode, number>>;
  };
}
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
const tokens = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
export function validateModelBudget(
  config: ModelBudgetConfig,
): ModelBudgetConfig {
  const range = config.weeklyProxyUsd;
  const { start, end } = budgetWindow(config);
  const r = config.reservation;
  if (
    !config.accountId ||
    !(config.source?.trim() || config.sources?.length) ||
    !config.method?.trim() ||
    (config.creditsPerProxyUsd !== undefined &&
      config.creditsPerProxyUsd !== 25) ||
    !range ||
    ![range.low, range.central, range.high].every(positive) ||
    range.low > range.central ||
    range.central > range.high ||
    !positive(config.maxPercent) ||
    config.maxPercent > 10 ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 7 * 86_400_000 ||
    (r?.safetyFactor !== undefined &&
      (!positive(r.safetyFactor) || r.safetyFactor < 1)) ||
    (r?.promptBytesPerToken !== undefined &&
      !positive(r.promptBytesPerToken)) ||
    (r?.extraInputTokens !== undefined && !tokens(r.extraInputTokens)) ||
    (r?.outputTokens &&
      !Object.values(r.outputTokens).every((v) => tokens(v) && v > 0))
  )
    throw new Error("invalid-model-budget");
  return config;
}
function budgetWindow(config: ModelBudgetConfig) {
  const start = Date.parse(config.weekStart ?? config.batchStartedAt ?? "");
  // Without an explicit account window, use a fixed seven-day batch envelope.
  // This is an operational window, not a claim about the account's reset time.
  // It expires closed; never automatically rolls forward or clears charges.
  const end = config.weekEnd
    ? Date.parse(config.weekEnd)
    : start + 7 * 86_400_000;
  return { start, end };
}
export function normalizeUsage(raw: unknown): ModelUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const input = u.input_tokens,
    cached = u.cached_input_tokens,
    output = u.output_tokens;
  if (!tokens(input) || !tokens(cached) || !tokens(output) || cached > input)
    return null;
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
  };
}
export function usageProxyUsd(model: BudgetModel, usage: ModelUsage): number {
  if (
    !Object.hasOwn(MODEL_WEIGHTS, model) ||
    !normalizeUsage({
      input_tokens: usage.inputTokens,
      cached_input_tokens: usage.cachedInputTokens,
      output_tokens: usage.outputTokens,
    })
  )
    throw new Error("invalid-model-usage");
  const weight = MODEL_WEIGHTS[model];
  return (
    ((usage.inputTokens - usage.cachedInputTokens) * weight.input +
      usage.cachedInputTokens * weight.cached +
      usage.outputTokens * weight.output) /
    1_000_000 /
    PROXY_BASIS.creditsPerProxyUsd
  );
}
export function reservationProxyUsd(
  config: ModelBudgetConfig,
  mode: BatchMode,
  prompt: string,
): number {
  validateModelBudget(config);
  const r = config.reservation;
  const input =
    Math.ceil(Buffer.byteLength(prompt) / (r?.promptBytesPerToken ?? 1)) +
    (r?.extraInputTokens ?? 4096);
  const output =
    r?.outputTokens?.[mode] ??
    { candidate: 20_000, draft: 24_000, review: 20_000 }[mode];
  return (
    usageProxyUsd(mode === "review" ? "gpt-6.1-sol" : "gpt-6-luna", {
      inputTokens: input,
      cachedInputTokens: 0,
      outputTokens: output,
    }) * (r?.safetyFactor ?? 1.5)
  );
}
export function accountAvailable(
  active: { id?: string; quota?: { weeklyPercent?: unknown } } | undefined,
  accountId: string,
): boolean {
  const used = active?.quota?.weeklyPercent;
  // Global quota is availability only. Its delta never enters this ledger.
  return (
    active?.id === accountId &&
    typeof used === "number" &&
    Number.isFinite(used) &&
    used >= 0 &&
    used < 100
  );
}

export class ModelBudget {
  private store: Database.Database;
  readonly config: ModelBudgetConfig;
  constructor(path: string, config: ModelBudgetConfig) {
    this.config = structuredClone(validateModelBudget(config));
    if (path !== ":memory:")
      mkdirSync(dirname(resolve(path)), { recursive: true });
    this.store = new Database(path);
    this.store.pragma("busy_timeout = 5000");
    this.store.exec(`CREATE TABLE IF NOT EXISTS model_requests (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      session_id TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL,
      reserved_usd REAL NOT NULL, actual_usd REAL,
      input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER,
      state TEXT NOT NULL CHECK(state IN ('reserved','settled'))
    ); CREATE INDEX IF NOT EXISTS model_requests_window ON model_requests(account_id, created_at);`);
  }
  reserve(
    model: BudgetModel,
    mode: BatchMode,
    reservedUsd: number,
    sessionId: string,
    now = Date.now(),
  ): string | null {
    if (
      !Object.hasOwn(MODEL_WEIGHTS, model) ||
      !["candidate", "draft", "review"].includes(mode) ||
      !positive(reservedUsd) ||
      !sessionId
    )
      throw new Error("invalid-model-reservation");
    return this.store
      .transaction(() => {
        const { start, end } = budgetWindow(this.config);
        if (now < start || now >= end) return null;
        if (
          this.summary().chargedOrReservedProxyUsd + reservedUsd >
          this.summary().limitProxyUsd
        )
          return null;
        const id = randomUUID();
        this.store
          .prepare(
            `INSERT INTO model_requests
        (id,account_id,created_at,session_id,model,mode,reserved_usd,state) VALUES(?,?,?,?,?,?,?,'reserved')`,
          )
          .run(
            id,
            this.config.accountId,
            now,
            sessionId,
            model,
            mode,
            reservedUsd,
          );
        return id;
      })
      .immediate();
  }
  settle(
    id: string,
    model: BudgetModel,
    rawUsage: unknown,
    exitCode: number | null = 0,
  ): boolean {
    const usage = normalizeUsage(rawUsage);
    if (exitCode !== 0 || !usage || !Object.hasOwn(MODEL_WEIGHTS, model))
      return false;
    const actual = usageProxyUsd(model, usage);
    return (
      this.store
        .prepare(
          `UPDATE model_requests SET actual_usd=?, input_tokens=?, cached_input_tokens=?,
      output_tokens=?,state='settled' WHERE id=? AND account_id=? AND model=? AND state='reserved'`,
        )
        .run(
          actual,
          usage.inputTokens,
          usage.cachedInputTokens,
          usage.outputTokens,
          id,
          this.config.accountId,
          model,
        ).changes === 1
    );
  }
  seedUsage(
    sessionId: string,
    model: BudgetModel,
    mode: BatchMode,
    rawUsage: unknown,
  ): boolean {
    const usage = normalizeUsage(rawUsage);
    if (
      !sessionId ||
      !usage ||
      !Object.hasOwn(MODEL_WEIGHTS, model) ||
      !["candidate", "draft", "review"].includes(mode)
    )
      throw new Error("invalid-seed-usage");
    // A seed is historical evidence, so record it even if it exhausts the cap.
    // Deterministic primary key makes retries / concurrent imports idempotent.
    const amount = usageProxyUsd(model, usage);
    return (
      this.store
        .prepare(
          `INSERT OR IGNORE INTO model_requests
      (id,account_id,created_at,session_id,model,mode,reserved_usd,actual_usd,
       input_tokens,cached_input_tokens,output_tokens,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,'settled')`,
        )
        .run(
          `seed:${this.config.accountId}:${sessionId}`,
          this.config.accountId,
          budgetWindow(this.config).start,
          sessionId,
          model,
          mode,
          amount,
          amount,
          usage.inputTokens,
          usage.cachedInputTokens,
          usage.outputTokens,
        ).changes === 1
    );
  }
  summary() {
    const row = this.store
      .prepare(
        `SELECT COUNT(*) requests,
      COALESCE(SUM(COALESCE(actual_usd,reserved_usd)),0) chargedOrReservedProxyUsd,
      COALESCE(SUM(CASE WHEN state='reserved' THEN 1 ELSE 0 END),0) unknownRequests,
      COALESCE(SUM(input_tokens),0) inputTokens, COALESCE(SUM(cached_input_tokens),0) cachedInputTokens,
      COALESCE(SUM(output_tokens),0) outputTokens FROM model_requests
      WHERE account_id=? AND created_at>=? AND created_at<?`,
      )
      .get(
        this.config.accountId,
        budgetWindow(this.config).start,
        budgetWindow(this.config).end,
      ) as {
      requests: number;
      chargedOrReservedProxyUsd: number;
      unknownRequests: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
    };
    return {
      ...row,
      limitProxyUsd:
        (this.config.weeklyProxyUsd.low * this.config.maxPercent) / 100,
      estimatedPercent: {
        low:
          (row.chargedOrReservedProxyUsd / this.config.weeklyProxyUsd.high) *
          100,
        central:
          (row.chargedOrReservedProxyUsd / this.config.weeklyProxyUsd.central) *
          100,
        high:
          (row.chargedOrReservedProxyUsd / this.config.weeklyProxyUsd.low) *
          100,
      },
      basis: PROXY_BASIS,
      calibration: {
        source: this.config.source,
        sources: this.config.sources,
        method: this.config.method,
        basis: this.config.basis,
      },
      window: budgetWindow(this.config),
    };
  }
  close() {
    this.store.close();
  }
}

// codex exec is a fresh single-turn invocation. Accept exactly one distinct final
// completion; identical retransmissions are harmless. Ambiguous/malformed JSON,
// failed turns, and missing cache telemetry retain the reservation.
export class CodexUsageCollector {
  threadId: string | null = null;
  private completed: string | null = null;
  private raw: unknown = null;
  private invalid = false;
  accept(line: string) {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (
        event.type === "thread.started" &&
        typeof event.thread_id === "string"
      )
        this.threadId = event.thread_id;
      if (event.type === "turn.failed" || event.type === "error")
        this.invalid = true;
      if (event.type === "turn.completed") {
        const usage = normalizeUsage(event.usage);
        const snapshot = JSON.stringify(usage);
        if (!usage || (this.completed !== null && this.completed !== snapshot))
          this.invalid = true;
        this.completed = snapshot;
        this.raw = event.usage;
      }
    } catch {
      this.invalid = true;
    }
  }
  finalUsage(): ModelUsage | null {
    return this.invalid ? null : normalizeUsage(this.raw);
  }
  rawUsage(): unknown {
    return this.invalid ? null : this.raw;
  }
}

export interface RolloutMetadata {
  threadId: string;
  parentThreadId?: string;
  totals: Partial<Record<BudgetModel, ModelUsage>>;
  unknownSnapshots: number;
}
export function collectRolloutMetadata(
  lines: Iterable<string>,
): RolloutMetadata | null {
  let result: RolloutMetadata | null = null;
  let model: BudgetModel | undefined;
  let previous: ModelUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let first = true;
  for (const line of lines) {
    if (!line.trim()) continue;
    // Parse only the metadata allowlist; never inspect response_item / messages.
    if (!/"type"\s*:\s*"(?:session_meta|turn_context|event_msg)"/.test(line)) {
      if (first) return null;
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (first) {
      first = false;
      if (
        event.type !== "session_meta" ||
        typeof event.payload?.id !== "string"
      )
        return null;
      const p = event.payload;
      result = {
        threadId: p.id,
        parentThreadId:
          p.parent_thread_id ??
          p.source?.subagent?.thread_spawn?.parent_thread_id,
        totals: {},
        unknownSnapshots: 0,
      };
      continue;
    }
    if (!result) continue;
    if (event.type === "turn_context")
      model = Object.hasOwn(MODEL_WEIGHTS, event.payload?.model)
        ? event.payload.model
        : undefined;
    if (event.type !== "event_msg" || event.payload?.type !== "token_count")
      continue;
    const current = normalizeUsage(event.payload.info?.total_token_usage);
    if (!current) {
      result.unknownSnapshots++;
      continue;
    }
    const delta: ModelUsage = {
      inputTokens: current.inputTokens - previous.inputTokens,
      cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
      outputTokens: current.outputTokens - previous.outputTokens,
    };
    if (
      delta.inputTokens < 0 ||
      delta.cachedInputTokens < 0 ||
      delta.outputTokens < 0 ||
      delta.cachedInputTokens > delta.inputTokens
    ) {
      result.unknownSnapshots++;
      continue;
    }
    previous = current;
    if (!delta.inputTokens && !delta.cachedInputTokens && !delta.outputTokens)
      continue;
    if (!model) {
      result.unknownSnapshots++;
      continue;
    }
    const sum = result.totals[model] ?? {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    result.totals[model] = {
      inputTokens: sum.inputTokens + delta.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + delta.cachedInputTokens,
      outputTokens: sum.outputTokens + delta.outputTokens,
    };
  }
  return result;
}
