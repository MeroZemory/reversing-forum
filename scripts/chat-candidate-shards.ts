import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scopedOutputSchema } from "../src/server/chat-pipeline/relative-context";

type Json = Record<string, any>;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (path: string) => readFileSync(path, "utf8");
const privateWrite = (path: string, text: string) =>
  writeFileSync(path, text, { flag: "wx", mode: 0o600 });
const shardInstructions = [
  "Return complete=true and the unchanged packetId, with exactly one result for each supplied batchId and no other blocks. Keep each result mapped to its own supplied block.",
  "Use the native numeric message IDs in message[0]; never renumber them by position or use IDs from another block. questionIds and responseIds must name supplied non-held messages in that same block; messages whose flags include held are not candidate evidence.",
  "contextIds must belong to that block's targetIds when supplied, otherwise to its supplied non-held message IDs. noncandidateRanges are inclusive [start,end] pairs with start <= end; every integer in a range must belong to that block's targetIds when supplied, otherwise to its supplied message IDs. Both endpoints must also satisfy the output schema's non-held ID scope. Split ranges at missing indexes; never span gaps or invent an empty/reversed range. Use [] when there are no noncandidate ranges.",
  "Before returning, check block mapping, native IDs, held flags and every range against the supplied input and schema. Preserve the evidence and classify it yourself; do not infer missing classifications or fabricate context to satisfy the schema.",
];

/** Whole-block transport only. The existing runner owns all model execution policy. */
export async function runCandidateShards(options: {
  input: string;
  output: string;
  schema: string;
  cacheDirectory: string;
  blocksPerShard: number;
  quarantineInvalidOutput?: boolean;
  quarantineRejectedRetry?: boolean;
  invoke: (args: string[]) => Promise<unknown>;
  validate: (value: Json, schema: Json) => void;
}): Promise<void> {
  const { input, output, schema, blocksPerShard, invoke, validate } = options;
  if (
    options.quarantineRejectedRetry === true &&
    options.quarantineInvalidOutput !== true
  )
    throw new Error("candidate-shard-cache-invalid");
  if (
    !Number.isSafeInteger(blocksPerShard) ||
    blocksPerShard < 1 ||
    blocksPerShard > 6
  )
    throw new Error("invalid-candidate-shard-limit");
  const sourceText = read(input),
    schemaText = read(schema);
  let source: Json, template: Json;
  try {
    source = JSON.parse(sourceText);
    template = JSON.parse(schemaText);
    if (
      typeof source.packetId !== "string" ||
      !Array.isArray(source.blocks) ||
      !source.blocks.length ||
      source.blocks.length > 6 ||
      source.blocks.some(
        (b: Json) =>
          !b || typeof b.batchId !== "string" || !Array.isArray(b.messages),
      ) ||
      new Set(source.blocks.map((b: Json) => b.batchId)).size !==
        source.blocks.length
    )
      throw new Error();
  } catch {
    throw new Error("candidate-shard-input-invalid");
  }
  // Include the entire source, not just the child's blocks, and the exact schema.
  const directory = join(
    options.cacheDirectory,
    hash(
      JSON.stringify([
        "candidate-shards-v1",
        sourceText,
        schemaText,
        blocksPerShard,
      ]),
    ),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const unchanged = () => {
    if (read(input) !== sourceText || read(schema) !== schemaText)
      throw new Error("candidate-shard-source-changed");
  };
  const check = (result: Json, child: Json) => {
    try {
      const scoped = scopedOutputSchema(template, child, "candidate");
      // The parent's validator handles the template dialect. Check the existing
      // runner's enum constraints separately, without changing that validator.
      validate(result, template);
      const enums = (value: any, node: Json): void => {
        if (node.enum && !node.enum.includes(value)) throw new Error();
        if (node.type === "object")
          for (const key of Object.keys(node.properties ?? {}))
            if (key in value) enums(value[key], node.properties[key]);
        if (node.type === "array")
          value.forEach((v: any) => enums(v, node.items));
      };
      enums(result, scoped);
      const ids = child.blocks.map((b: Json) => b.batchId);
      if (
        result.complete !== true ||
        result.packetId !== source.packetId ||
        result.blocks.length !== ids.length ||
        new Set(result.blocks.map((b: Json) => b.batchId)).size !==
          ids.length ||
        result.blocks.some((b: Json) => !ids.includes(b.batchId))
      )
        throw new Error();
      // The transport schema's evidence enum is a union. Also enforce each
      // individual block's supplied evidence boundary before caching.
      for (const block of result.blocks) {
        const supplied = child.blocks.find(
          (b: Json) => b.batchId === block.batchId,
        );
        const allowed = new Set(
          supplied.messages
            .filter((m: any[]) => !m[3]?.includes("held"))
            .map((m: any[]) => m[0]),
        );
        const targets = new Set(supplied.targetIds ?? [...allowed]);
        const rangeScope = new Set(
          supplied.targetIds ?? supplied.messages.map((m: any[]) => m[0]),
        );
        if (
          block.candidates.some((c: Json) =>
            [...c.questionIds, ...c.responseIds].some(
              (id: number) => !allowed.has(id),
            ),
          ) ||
          block.contextIds.some((id: number) => !targets.has(id)) ||
          block.noncandidateRanges.some(([start, end]: number[]) => {
            if (start > end) return true;
            for (let id = start; id <= end; id++)
              if (!rangeScope.has(id)) return true;
            return false;
          })
        )
          throw new Error();
      }
    } catch {
      throw new Error("candidate-shard-output-invalid");
    }
  };
  const blocks: Json[] = [];
  const writeCombined = (complete: boolean) => {
    unchanged();
    const temporary = `${output}.shards.tmp`;
    rmSync(temporary, { force: true });
    privateWrite(
      temporary,
      JSON.stringify({ packetId: source.packetId, complete, blocks }),
    );
    try {
      if (existsSync(output)) throw new Error("candidate-shard-cache-invalid");
      renameSync(temporary, output);
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  for (
    let offset = 0;
    offset < source.blocks.length;
    offset += blocksPerShard
  ) {
    unchanged();
    const child: Json = {
      ...source,
      blocks: source.blocks.slice(offset, offset + blocksPerShard),
    };
    const childText = JSON.stringify(child),
      childHash = hash(childText);
    const childInput = join(directory, `${childHash}.input.json`);
    const childOutput = join(directory, `${childHash}.output.json`);
    const receipt = join(directory, `${childHash}.receipt.json`);
    const attempt = join(directory, `${childHash}.attempt.json`);
    const preserveAttempt = () => {
      if (existsSync(attempt))
        renameSync(
          attempt,
          join(
            directory,
            `${childHash}.${hash(read(attempt))}.${randomUUID()}.rejected.json`,
          ),
        );
    };
    if (!existsSync(childInput)) privateWrite(childInput, childText);
    if (read(childInput) !== childText)
      throw new Error("candidate-shard-cache-invalid");
    let result!: Json;
    if (existsSync(childOutput) || existsSync(receipt)) {
      try {
        const text = read(childOutput);
        if (read(receipt) !== hash(text)) throw new Error();
        result = JSON.parse(text);
        check(result, child);
      } catch {
        throw new Error("candidate-shard-cache-invalid");
      }
    } else {
      // Keep the existing cache key/input and good receipts reusable. Only the
      // actual uncached invocation gets the additional transport instructions.
      const transportText = JSON.stringify({
        ...child,
        instructions:
          typeof child.instructions === "string"
            ? `${child.instructions}\n${shardInstructions.join("\n")}`
            : [...(child.instructions ?? []), ...shardInstructions],
      });
      const transportInput = join(
        directory,
        `${childHash}.transport.input.json`,
      );
      if (!existsSync(transportInput))
        privateWrite(transportInput, transportText);
      const checkInputs = () => {
        unchanged();
        if (
          read(childInput) !== childText ||
          read(transportInput) !== transportText
        )
          throw new Error("candidate-shard-cache-invalid");
      };
      checkInputs();
      // Explicit recovery of an already failed packet never invokes its model
      // again. Hash-check the preserved invalid bytes before context-only import.
      if (options.quarantineRejectedRetry === true) {
        const rejected = readdirSync(directory).filter(
          (name) =>
            name.startsWith(`${childHash}.`) && name.endsWith(".rejected.json"),
        );
        if (!rejected.length) throw new Error("candidate-shard-cache-invalid");
        for (const name of rejected) {
          const text = read(join(directory, name));
          if (!name.startsWith(`${childHash}.${hash(text)}.`))
            throw new Error("candidate-shard-cache-invalid");
          let rejectedResult: Json;
          try {
            rejectedResult = JSON.parse(text);
          } catch {
            throw new Error("candidate-shard-cache-invalid");
          }
          if (
            rejectedResult?.packetId !== source.packetId ||
            !Array.isArray(rejectedResult.blocks) ||
            rejectedResult.blocks.length !== child.blocks.length ||
            new Set(rejectedResult.blocks.map((b: Json) => b?.batchId)).size !==
              child.blocks.length ||
            rejectedResult.blocks.some(
              (b: Json) =>
                !child.blocks.some((s: Json) => s.batchId === b?.batchId),
            )
          )
            throw new Error("candidate-shard-cache-invalid");
          let invalid = false;
          try {
            check(rejectedResult, child);
          } catch {
            invalid = true;
          }
          if (!invalid) throw new Error("candidate-shard-cache-invalid");
        }
        writeCombined(false);
        throw new Error("candidate-shard-output-invalid");
      }
      // An interrupted or failed transport is never a reusable result.
      preserveAttempt();
      for (let call = 0; call < 2; call++) {
        try {
          // Each call uses the original runner, including its budget charging.
          // Invocation/account/transport errors are outside the retry catch.
          checkInputs();
          await invoke(["candidate", transportInput, attempt, schema]);
          checkInputs();
          let text: string;
          try {
            text = read(attempt);
            result = JSON.parse(text);
            check(result, child);
          } catch {
            if (call === 0) continue;
            // Rejected bytes stay separate. This prefix is only a quarantine
            // envelope, never an accepted model result or reusable child receipt.
            if (options.quarantineInvalidOutput === true && existsSync(attempt))
              writeCombined(false);
            throw new Error("candidate-shard-output-invalid");
          }
          privateWrite(childOutput, text);
          privateWrite(receipt, hash(text));
          break;
        } finally {
          if (
            existsSync(childOutput) &&
            existsSync(receipt) &&
            existsSync(attempt) &&
            read(childOutput) === read(attempt)
          )
            rmSync(attempt, { force: true });
          else preserveAttempt();
        }
      }
    }
    for (const supplied of child.blocks)
      blocks.push(
        result.blocks.find((b: Json) => b.batchId === supplied.batchId),
      );
  }
  const combined = { packetId: source.packetId, complete: true, blocks };
  check(combined, source);
  // Parent envelope validation and native import remain the final gates.
  writeCombined(true);
}
