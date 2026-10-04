import { randomUUID } from "node:crypto";
import {
  openSync,
  closeSync,
  writeFileSync,
  linkSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

function publishReceipt(path: string, text: string, exclusive: boolean) {
  const temporary = join(dirname(path), `.receipt-${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    if (exclusive) linkSync(temporary, path);
    else renameSync(temporary, path);
  } finally {
    // File-only cleanup; rename has already removed the temporary on success.
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Publish the existing final receipt shape atomically for concurrent readers. */
export function finishCodexReceipt(
  path: string,
  receipt: Record<string, unknown>,
) {
  publishReceipt(path, JSON.stringify(receipt, null, 2), false);
}

/** Reserve a durable negative call record before invocation; never replace history. */
export function startCodexReceipt(
  path: string,
  metadata: Record<string, unknown>,
) {
  publishReceipt(
    path,
    JSON.stringify(
      {
        ...metadata,
        sessionId: null,
        usage: null,
        settled: false,
        finalAccountConfirmed: false,
        outputAccepted: false,
        stopped: true,
        stopReason: "incomplete",
        exitCode: null,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    true,
  );
}
