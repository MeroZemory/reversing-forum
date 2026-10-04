import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const hashFile = (p) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
const digest = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const write = (p, v) =>
  writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 });

export function createEditorialStepRunner({
  root,
  directory,
  work,
  checkpoint,
}) {
  function checkNative(execution, input, output, expectedArgs) {
    const stored = read(execution),
      native = JSON.parse(stored.stdout),
      receipt = read(
        join(directory, "codex-logs", native.reservationId + ".receipt.json"),
      );
    if (
      expectedArgs &&
      (stored.script !== "chat-codex-run.ts" ||
        JSON.stringify(stored.args) !== JSON.stringify(expectedArgs))
    )
      throw Error("native-cache-arguments-changed");
    if (
      stored.exitCode !== 0 ||
      native.outputAccepted !== true ||
      native.settled !== true ||
      native.finalAccountConfirmed !== true ||
      native.inputHash !== hashFile(input) ||
      receipt.outputAccepted !== true ||
      receipt.settled !== true ||
      receipt.finalAccountConfirmed !== true ||
      receipt.inputHash !== native.inputHash ||
      receipt.attemptOutputBytes !== readFileSync(output).length ||
      stored.acceptedOutputHash !== hashFile(output)
    )
      throw Error("untrusted-native-output");
    return native;
  }

  async function run(script, args, label, model = false) {
    const execution = join(work, label + ".execution.private.json");
    if (model && existsSync(args[2])) {
      if (!existsSync(execution))
        throw Error("model-cache-without-execution-proof");
      const native = checkNative(execution, args[1], args[2], args);
      console.log(JSON.stringify({ event: "reuse-native-output", label }));
      return native;
    }
    let actualArgs = args;
    let oldPrepared;
    const preparation = !model && args[0] === "rereview";
    if (preparation) {
      if (existsSync(execution)) {
        const e = read(execution);
        if (e.exitCode === 0) {
          if (
            e.script !== script ||
            JSON.stringify(e.args) !== JSON.stringify(args)
          )
            throw Error("preparation-cache-arguments-changed");
          oldPrepared = JSON.parse(e.stdout.trim());
        }
      }
      // Never overwrite immutable input left by a completed or interrupted helper.
      if (existsSync(args[4]))
        actualArgs = [
          ...args.slice(0, 4),
          join(work, "recovered-preparation-" + label + "-" + randomUUID()),
        ];
    }
    const p = spawn(
      process.execPath,
      ["--import", "tsx", join(root, "scripts", script), ...actualArgs],
      { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    p.stdout.on("data", (s) => (stdout += s));
    p.stderr.on("data", (s) => (stderr += s));
    const exitCode = await new Promise((done, fail) => {
      p.once("error", fail);
      p.once("close", done);
    });
    const evidence = {
      script,
      args,
      actualArgs,
      exitCode,
      stdout,
      stderr,
      finishedAt: new Date().toISOString(),
    };
    const adopt = () => {
      if (existsSync(execution))
        copyFileSync(execution, execution + ".prior-" + randomUUID());
      write(execution, evidence);
    };
    if (!preparation) adopt();
    try {
      if (exitCode !== 0) {
        const boundary = stdout.includes("batch-proxy-budget-boundary");
        checkpoint(boundary ? "budget-boundary" : "execution-failed", {
          failedStep: label,
        });
        console.log(
          JSON.stringify({
            event: "remaining-stopped",
            label,
            budgetBoundary: boundary,
            exitCode,
            published: 0,
          }),
        );
        throw Error("remaining-step-failed");
      }
      const result = JSON.parse(stdout.trim());
      if (preparation) {
        const regenerated = read(result.reviewInput);
        if (
          oldPrepared &&
          digest(read(oldPrepared.reviewInput)) !== digest(regenerated)
        )
          throw Error("preparation-cache-content-changed");
        // Adopt only parsed, readable, equivalent preparation results. Failed
        // attempts must leave the original successful comparison proof current.
        adopt();
      }
      if (model) {
        if (!(
          result.outputAccepted === true &&
          result.settled === true &&
          result.finalAccountConfirmed === true
        ))
          throw Error("native-output-not-accepted");
        write(execution, {
          ...evidence,
          acceptedOutputHash: hashFile(args[2]),
        });
        checkNative(execution, args[1], args[2]);
      }
      return result;
    } catch (error) {
      if (preparation)
        write(execution + ".rejected-" + randomUUID(), {
          ...evidence,
          error: error.message,
        });
      throw error;
    }
  }
  return { checkNative, run };
}
