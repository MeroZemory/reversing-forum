// Synthetic-only subscription CLI evaluation. No raw-chat/file-input mode.
// Run: node --conditions=react-server --import tsx scripts/duplicate-llm-run.ts <paraphrase|changed-condition|correction|mosaic|all>
import { judgeWithLlm } from "../src/server/duplicates/llm";

const original = {
  id: "synthetic-public-1",
  title: "Decode firmware 1.0 values",
  body: "Firmware 1.0 stores unsigned 32-bit values XORed with 0x55. Decode a stored value by XORing it with 0x55 again. XOR is self-inverse, so applying the same mask twice restores the original value.",
  tags: ["synthetic", "firmware"],
};
const second = {
  id: "synthetic-public-2",
  title: "Read little-endian integers",
  body: "Read a four-byte little-endian unsigned integer by combining byte b0, b1, b2 and b3 as b0 + 256*b1 + 65536*b2 + 16777216*b3. Here b0 is the first byte in memory.",
  tags: ["synthetic", "endianness"],
};
const scenarios = {
  paraphrase: {
    newPost: {
      title: "Undo the firmware 1.0 XOR mask",
      body: "In firmware 1.0, unsigned 32-bit stored values use the XOR mask 0x55. Apply XOR 0x55 once more to decode them: repeating an identical XOR mask cancels the transformation and recovers the initial value.",
      tags: ["synthetic", "firmware"],
    },
    candidates: [original],
    acceptable: ["duplicate"],
  },
  "changed-condition": {
    newPost: {
      title: "Firmware 2.0 changed the XOR mask",
      body: "Firmware 2.0 changed the unsigned 32-bit storage mask from 0x55 to 0xAA. Decode version 2.0 values using XOR 0xAA. Using the old version 1.0 mask 0x55 produces the wrong result; select the mask by firmware version.",
      tags: ["synthetic", "firmware"],
    },
    candidates: [original],
    acceptable: ["distinct", "related", "overlap"],
  },
  correction: {
    newPost: {
      title: "Correct the firmware XOR decoder",
      body: "The subtraction decoder is incorrect. Firmware 1.0 encoded x as x XOR 0x55, so decode stored with stored XOR 0x55, not (stored - 0x55) >>> 0. For x = 1 the stored value is 0x54: XOR restores 1, while unsigned subtraction returns 4294967295. Repeating XOR cancels its mask; subtraction does not invert XOR.",
      tags: ["synthetic", "firmware"],
    },
    candidates: [
      {
        ...original,
        title: "Subtract the storage mask",
        body: "Firmware 1.0 encodes unsigned 32-bit x as x XOR 0x55. Decode stored values by subtracting the mask modulo 2^32. The decoder is (stored - 0x55) >>> 0. This subtraction restores the original x.",
      },
    ],
    acceptable: ["distinct", "related", "overlap"],
  },
  mosaic: {
    newPost: {
      title: "Two existing decoding notes",
      body: "For a four-byte unsigned little-endian integer, b0 is the earliest byte in memory. Combine the bytes using b0 + b1*256 + b2*65536 + b3*16777216.\n\nFirmware 1.0 masks unsigned 32-bit stored values using XOR 0x55. XOR the stored value with 0x55 to recover the unmasked value, because using the same XOR mask twice cancels it.",
      tags: ["synthetic", "firmware", "endianness"],
    },
    candidates: [original, second],
    acceptable: ["duplicate"],
  },
};
const selected = process.argv[2];
const independentReview = process.argv[3] === "--independent-review";
if (process.argv.length > 4 || (process.argv[3] && !independentReview)) {
  console.log("Optional argument: --independent-review (Sol/medium).");
  process.exit(2);
}
if (selected === "--help") {
  console.log(
    "Synthetic evaluations: paraphrase | changed-condition | correction | mosaic | all [--independent-review]. Bounded Luna/high, larger comparisons max; independent review Sol/medium. Shared CHAT_MODEL_BUDGET_CONFIG/PATH; one CLI request per scenario.",
  );
} else if (
  selected === "all" ||
  (selected && Object.hasOwn(scenarios, selected))
) {
  const names = selected === "all" ? Object.keys(scenarios) : [selected];
  for (const name of names) {
    const scenario = scenarios[name as keyof typeof scenarios];
    const startedAt = Date.now();
    const result = await judgeWithLlm(
      {
        newPost: scenario.newPost,
        candidates: scenario.candidates,
      },
      { independentReview },
    );
    const passed = scenario.acceptable.includes(result.verdict);
    console.log(
      JSON.stringify({
        scenario: name,
        independentReview,
        elapsedMs: Date.now() - startedAt,
        verdict: result.verdict,
        relatedPostIds: result.relatedPostIds,
        passed,
      }),
    );
    if (!passed) process.exitCode = 1;
  }
} else {
  console.log(
    "Select a synthetic scenario: paraphrase | changed-condition | correction | mosaic | all (or --help).",
  );
  process.exitCode = 2;
}
