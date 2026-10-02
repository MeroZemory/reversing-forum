import Database from "better-sqlite3";
import type { PreparedBatch } from "../src/server/chat-pipeline/prepare";
const db = new Database("data/chat-pipeline/jobs.sqlite", { readonly: true });
const rows = db
  .prepare(
    "SELECT j.record FROM jobs j JOIN runs r ON r.id=j.run_id WHERE r.active=1 ORDER BY j.rowid",
  )
  .all() as { record: string }[];
const sampled = [];
for (let part = 0; part < 12; part++) {
  const batch = JSON.parse(
    rows[Math.floor(((rows.length - 1) * part) / 11)].record,
  ) as PreparedBatch;
  const eligible = batch.input.messages.filter((m) => !m.held);
  sampled.push({
    part,
    batchId: batch.batchId,
    technical:
      eligible
        .find((m) =>
          /리버|디버|어셈|IDA|asm|파이썬|메모리|분석|안드로이드|함수|바이너리/i.test(
            m.text,
          ),
        )
        ?.text.slice(0, 250) ?? null,
    ordinary:
      eligible[Math.floor(eligible.length / 2)]?.text.slice(0, 150) ?? null,
  });
}
console.log(JSON.stringify({ sampled }));
db.close();
