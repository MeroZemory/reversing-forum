import {
  chmodSync,
  linkSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// The caller supplies the ignored private codex-logs directory. Each CLI turn
// gets its own file, including retries for the same canonical output.
export function createCodexAttemptOutput(privateLogDirectory: string): string {
  const directory = mkdtempSync(join(privateLogDirectory, "output-attempt-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "message.private.json");
  writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  return path;
}

export function acceptCodexAttemptOutput(
  attemptPath: string,
  outputPath: string,
  gates: {
    exitCode: number | null;
    stopped: boolean;
    settled: boolean;
    finalAccountConfirmed: boolean;
  },
) {
  let attemptOutputExists = false;
  let attemptOutputBytes = 0;
  try {
    const stat = statSync(attemptPath);
    attemptOutputExists = stat.isFile();
    if (attemptOutputExists) attemptOutputBytes = stat.size;
  } catch {
    // Missing or unreadable transport evidence must never become reusable.
  }
  let outputFailure: string | null = null;
  if (
    gates.exitCode !== 0 ||
    gates.stopped ||
    !gates.settled ||
    !gates.finalAccountConfirmed
  )
    outputFailure = "output-acceptance-gates-failed";
  else if (!attemptOutputExists || attemptOutputBytes === 0)
    outputFailure = "output-transport-missing-or-empty";
  else {
    try {
      // Unlike rename, link is atomic and fails if the target already exists.
      // Keep the private attempt as evidence, even when promotion succeeds.
      linkSync(attemptPath, outputPath);
    } catch (error) {
      outputFailure =
        (error as NodeJS.ErrnoException).code === "EEXIST"
          ? "output-already-exists"
          : "output-promotion-failed";
    }
  }
  return {
    outputAccepted: outputFailure === null,
    outputFailure,
    attemptOutputExists,
    attemptOutputBytes,
  };
}
