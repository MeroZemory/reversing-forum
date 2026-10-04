import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { accountAvailable, type ModelBudgetConfig } from "./model-budget";

export type CliAccountConfig = ModelBudgetConfig & {
  codexHome?: string;
  codexAccountFingerprint?: string;
};

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const homeMode = (config: CliAccountConfig) =>
  config.codexHome !== undefined ||
  config.codexAccountFingerprint !== undefined;

function pinnedHome(config: CliAccountConfig): string | null {
  const home = config.codexHome;
  if (
    typeof home !== "string" ||
    !isAbsolute(home) ||
    typeof config.codexAccountFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(config.codexAccountFingerprint) ||
    config.allowCreditUsage !== true
  )
    return null;
  try {
    // Reject aliases/junctions: the configured home must itself be physical.
    const physical = realpathSync(/* turbopackIgnore: true */ home);
    return relative(physical, resolve(home)) === "" ? physical : null;
  } catch {
    return null;
  }
}

/** Apply only to an already sanitized child environment. Never change process.env. */
export function cliAccountEnvironment(
  config: CliAccountConfig,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!homeMode(config)) return { ...env };
  const home = pinnedHome(config);
  if (!home) throw new Error("cli-account-pin-invalid");
  return { ...env, CODEX_HOME: home };
}

/** Loading home transport config is allowed only after a fresh, explicit pin check. */
export async function cliAccountUsesPinnedHome(
  config: CliAccountConfig,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (!homeMode(config)) return false;
  if (!(await cliAccountAvailable(config, env, "")))
    throw new Error("cli-account-pin-invalid");
  const configPath = join(env.CODEX_HOME!, "config.toml");
  if (existsSync(/* turbopackIgnore: true */ configPath)) {
    const lines = createInterface({
      input: createReadStream(/* turbopackIgnore: true */ configPath),
      crlfDelay: Infinity,
    });
    try {
      // Inspect key metadata only; never copy transport credentials or instruction text.
      for await (const line of lines) {
        const quotedKey = /^\s*"((?:[^"\\]|\\.)*)"\s*=/.exec(line)?.[1];
        // Escaped basic-string keys are ambiguous without TOML decoding.
        if (quotedKey?.includes("\\"))
          throw new Error("cli-account-instructions-file-unsupported");
        if (
          /^\s*(?:model_instructions_file|"model_instructions_file"|'model_instructions_file')\s*=/.test(
            line,
          ) &&
          !/^\s*(?:model_instructions_file|"model_instructions_file"|'model_instructions_file')\s*=\s*(?:""|'')\s*(?:#.*)?$/.test(
            line,
          )
        )
          throw new Error("cli-account-instructions-file-unsupported");
      }
    } finally {
      lines.close();
    }
  }
  return true;
}

/** No quota claim in home mode; explicit credit permission and the ledger still apply. */
export async function cliAccountAvailable(
  config: CliAccountConfig,
  env: NodeJS.ProcessEnv,
  ocx: string,
  options: { cwd?: string; timeout?: number } = {},
): Promise<boolean> {
  if (homeMode(config)) {
    const home = pinnedHome(config);
    if (
      !home ||
      !env.CODEX_HOME ||
      !isAbsolute(env.CODEX_HOME) ||
      relative(home, env.CODEX_HOME) !== ""
    )
      return false;
    try {
      const authPath = join(home, "auth.json");
      if (
        relative(
          authPath,
          realpathSync(/* turbopackIgnore: true */ authPath),
        ) !== ""
      )
        return false;
      // Parse transiently and inspect only auth mode/account metadata. Never persist
      // or hash token/key values: normal credential rotation must remain valid.
      const auth: unknown = JSON.parse(
        readFileSync(/* turbopackIgnore: true */ authPath, "utf8"),
      );
      if (
        !object(auth) ||
        auth.auth_mode !== "chatgpt" ||
        (auth.OPENAI_API_KEY !== undefined &&
          auth.OPENAI_API_KEY !== null &&
          auth.OPENAI_API_KEY !== "") ||
        !object(auth.tokens) ||
        typeof auth.tokens.account_id !== "string" ||
        !auth.tokens.account_id.trim()
      )
        return false;
      return (
        createHash("sha256").update(auth.tokens.account_id).digest("hex") ===
        config.codexAccountFingerprint
      );
    } catch {
      return false;
    }
  }
  if (!existsSync(ocx)) return false;
  const stdout = await new Promise<string>((done, reject) =>
    execFile(
      process.execPath,
      [
        ocx,
        "account",
        "list",
        "openai",
        ...(config.allowCreditUsage === true ? [] : ["--quota"]),
        "--json",
      ],
      {
        windowsHide: true,
        encoding: "utf8",
        timeout: options.timeout ?? 15_000,
        maxBuffer: 1_000_000,
        env,
        cwd: options.cwd,
      },
      (error, stdout) =>
        error ? reject(new Error("account-status-unavailable")) : done(stdout),
    ),
  );
  try {
    const data: unknown = JSON.parse(stdout);
    if (!object(data) || !Array.isArray(data.accounts)) return false;
    const active = data.accounts.filter((a) => object(a) && a.active === true);
    return (
      active.length === 1 &&
      accountAvailable(active[0], config.accountId, config.allowCreditUsage)
    );
  } catch {
    return false;
  }
}
