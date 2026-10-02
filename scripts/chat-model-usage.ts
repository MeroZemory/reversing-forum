import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  collectRolloutMetadata,
  ModelBudget,
  MODEL_WEIGHTS,
  normalizeUsage,
  PROXY_BASIS,
  usageProxyUsd,
  type BudgetModel,
  type BatchMode,
  type ModelBudgetConfig,
  type ModelUsage,
  type RolloutMetadata,
} from "../src/server/chat-pipeline/model-budget";

type Receipt = {
  reservationId: string;
  sessionId?: string;
  parentThreadId?: string;
  model: BudgetModel;
  usage?: ModelUsage | null;
  settled: boolean;
  reservedProxyUsd: number;
};
export function summarizeReceipts(receipts: Receipt[], threads?: Set<string>) {
  const seen = new Set<string>();
  const sessions = new Map<
    string,
    {
      requests: number;
      unknownRequests: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      observedProxyUsd: number;
      chargedOrReservedProxyUsd: number;
    }
  >();
  for (const receipt of receipts) {
    if (
      threads &&
      !threads.has(receipt.sessionId ?? "") &&
      !threads.has(receipt.parentThreadId ?? "")
    )
      continue;
    if (!receipt.reservationId || seen.has(receipt.reservationId)) continue;
    seen.add(receipt.reservationId);
    const key = receipt.sessionId || `unknown:${receipt.reservationId}`;
    const row = sessions.get(key) ?? {
      requests: 0,
      unknownRequests: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      observedProxyUsd: 0,
      chargedOrReservedProxyUsd: 0,
    };
    const usage = normalizeUsage({
      input_tokens: receipt.usage?.inputTokens,
      cached_input_tokens: receipt.usage?.cachedInputTokens,
      output_tokens: receipt.usage?.outputTokens,
    });
    const known = usage && Object.hasOwn(MODEL_WEIGHTS, receipt.model);
    const observed = known ? usageProxyUsd(receipt.model, usage) : 0;
    row.requests++;
    if (!receipt.settled || !known) row.unknownRequests++;
    if (known) {
      row.inputTokens += usage.inputTokens;
      row.cachedInputTokens += usage.cachedInputTokens;
      row.outputTokens += usage.outputTokens;
    }
    row.observedProxyUsd += observed;
    row.chargedOrReservedProxyUsd +=
      receipt.settled && known ? observed : receipt.reservedProxyUsd;
    sessions.set(key, row);
  }
  return [...sessions].map(([sessionId, totals]) => ({ sessionId, ...totals }));
}
export function selectRollouts(
  records: RolloutMetadata[],
  threads: Set<string>,
  ancestry: boolean,
) {
  const selected = new Set(threads);
  if (ancestry) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of records)
        if (
          r.parentThreadId &&
          selected.has(r.parentThreadId) &&
          !selected.has(r.threadId)
        ) {
          selected.add(r.threadId);
          changed = true;
        }
    }
  }
  const unique = new Map<string, RolloutMetadata>();
  const size = (r: RolloutMetadata) =>
    Object.values(r.totals).reduce(
      (sum, u) => sum + u.inputTokens + u.outputTokens,
      0,
    );
  for (const r of records)
    if (selected.has(r.threadId)) {
      // Duplicate copies of a rollout are not independent runs. Prefer the largest
      // snapshot, rather than adding copied history again.
      const previous = unique.get(r.threadId);
      if (!previous || size(r) > size(previous)) unique.set(r.threadId, r);
    }
  return [...unique.values()];
}
function files(path: string, suffix: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(path, entry.name), suffix)
      : entry.name.endsWith(suffix)
        ? [join(path, entry.name)]
        : [],
  );
}
async function readMetadata(path: string) {
  // Caller only enumerates rollout JSONL, never auth, .env, or credential files.
  const reader = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  const metadata: string[] = [];
  let first = true;
  for await (const line of reader) {
    if (!line.trim()) continue;
    if (first && !/"type"\s*:\s*"session_meta"/.test(line)) return null;
    if (
      /"type"\s*:\s*"(?:session_meta|turn_context)"/.test(line) ||
      (/"type"\s*:\s*"event_msg"/.test(line) &&
        /"type"\s*:\s*"token_count"/.test(line))
    ) {
      try {
        const event = JSON.parse(line);
        // Retain only selected metadata fields, never prompt/context text.
        const payload =
          event.type === "session_meta"
            ? {
                id: event.payload?.id,
                parent_thread_id:
                  event.payload?.parent_thread_id ??
                  event.payload?.source?.subagent?.thread_spawn
                    ?.parent_thread_id,
              }
            : event.type === "turn_context"
              ? { model: event.payload?.model }
              : {
                  type: "token_count",
                  info: {
                    total_token_usage: event.payload?.info?.total_token_usage,
                  },
                };
        metadata.push(JSON.stringify({ type: event.type, payload }));
      } catch {
        if (first) return null;
      }
    }
    first = false;
  }
  return collectRolloutMetadata(metadata);
}
async function main() {
  const args = process.argv.slice(2);
  const values = (flag: string) =>
    args.flatMap((arg, index) =>
      arg === flag && args[index + 1] ? [args[index + 1]] : [],
    );
  const directory = resolve("data/chat-pipeline");
  if (args.includes("--seed")) {
    const threadId = values("--thread-id")[0];
    if (!threadId || values("--thread-id").length !== 1)
      throw new Error("seed-exact-thread-id-required");
    const model = values("--model")[0] as BudgetModel;
    const mode = values("--mode")[0] as BatchMode;
    const usage = {
      input_tokens: Number(values("--input")[0]),
      cached_input_tokens: Number(values("--cached-input")[0]),
      output_tokens: Number(values("--output")[0]),
    };
    const config = JSON.parse(
      readFileSync(
        resolve(
          process.env.CHAT_MODEL_BUDGET_CONFIG ||
            join(directory, "model-budget.json"),
        ),
        "utf8",
      ),
    ) as ModelBudgetConfig;
    const ledger = new ModelBudget(
      resolve(
        process.env.CHAT_MODEL_BUDGET_PATH ||
          join(directory, "model-budget.sqlite"),
      ),
      config,
    );
    try {
      const seeded = ledger.seedUsage(threadId, model, mode, usage);
      const normalized = normalizeUsage(usage)!;
      const receiptPath = join(
        directory,
        "codex-logs",
        `seed-${Buffer.from(threadId).toString("hex")}.receipt.json`,
      );
      mkdirSync(join(directory, "codex-logs"), { recursive: true });
      // Recover a missing receipt after a crash; never overwrite prior evidence.
      if (seeded || !existsSync(receiptPath))
        writeFileSync(
          receiptPath,
          JSON.stringify(
            {
              reservationId: `seed:${config.accountId}:${threadId}`,
              sessionId: threadId,
              parentThreadId:
                process.env.MAIN_THREAD_ID ||
                config.parentThreadId ||
                "chat-editorial-batch",
              model,
              mode,
              usage: normalized,
              settled: true,
              reservedProxyUsd: usageProxyUsd(model, normalized),
              source: "locally-measured-final-thread-usage",
              basis: PROXY_BASIS,
            },
            null,
            2,
          ),
        );
      console.log(JSON.stringify({ seeded, budget: ledger.summary() }));
    } finally {
      ledger.close();
    }
    return;
  }
  const threadArgs = values("--thread-id");
  const threads = new Set(threadArgs);
  const receiptPaths = values("--receipts");
  const receipts = (
    receiptPaths.length ? receiptPaths : [join(directory, "codex-logs")]
  )
    .flatMap((path) =>
      existsSync(path) ? files(resolve(path), ".receipt.json") : [],
    )
    .map((path) => JSON.parse(readFileSync(path, "utf8")) as Receipt);
  const rolloutFiles = values("--rollouts")
    .flatMap((path) => files(resolve(path), ".jsonl"))
    .filter((path) => /(?:^|[\\/])rollout-[^\\/]+\.jsonl$/.test(path))
    .filter(
      (path) =>
        args.includes("--ancestry") ||
        [...threads].some((id) => path.endsWith(`-${id}.jsonl`)),
    );
  const records: RolloutMetadata[] = [];
  for (const path of rolloutFiles) {
    const result = await readMetadata(path);
    if (result) records.push(result);
  }
  console.log(
    JSON.stringify(
      {
        basis: PROXY_BASIS,
        receiptSessions: summarizeReceipts(
          receipts,
          threads.size ? threads : undefined,
        ),
        // Rollout telemetry is a separate read-only comparison, never charged or
        // added to receipt totals automatically (the same run may exist in both).
        rolloutSessions: selectRollouts(
          records,
          threads,
          args.includes("--ancestry"),
        ).map((r) => ({
          ...r,
          observedProxyUsd: Object.entries(r.totals).reduce(
            (sum, [model, usage]) =>
              sum + usageProxyUsd(model as BudgetModel, usage),
            0,
          ),
        })),
      },
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
