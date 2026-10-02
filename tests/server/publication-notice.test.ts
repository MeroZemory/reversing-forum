import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));
vi.mock("@/server/db", () => ({
  get db() {
    return fixture.db;
  },
}));
import { payloadHash } from "@/server/publication-control";
import { publicationNotice } from "@/server/publication-notice";
beforeEach(() => {
  fixture.db?.close();
  fixture.db = new Database(":memory:");
  fixture.db.exec(
    "CREATE TABLE posts(id TEXT,author_id TEXT,title TEXT,status TEXT,screening_evidence TEXT,body TEXT DEFAULT 'body',kind TEXT DEFAULT 'analysis',tags TEXT DEFAULT '[]'); CREATE TABLE post_payloads(author_id TEXT,post_id TEXT,payload_hash TEXT); CREATE TABLE publication_attempts(request_key TEXT,attempts INTEGER); CREATE TABLE publication_limits(scope TEXT,window_start INTEGER,attempts INTEGER)",
  );
});
describe("owner publication notice", () => {
  it("hides private existence and evidence from guests and other members", () => {
    fixture.db
      .prepare(
        "INSERT INTO posts(id,author_id,title,status,screening_evidence) VALUES('private','owner','secret','held',?)",
      )
      .run(
        JSON.stringify({
          duplicate: {
            verdict: "duplicate",
            evidence: "private-proof",
            relatedPostIds: ["hidden"],
          },
        }),
      );
    expect(publicationNotice("private")).toBeNull();
    expect(publicationNotice("private", "other")).toBeNull();
  });
  it("rechecks current public state of references and never returns the model proof", () => {
    fixture.db
      .prepare(
        "INSERT INTO posts(id,author_id,title,status,screening_evidence) VALUES('private','owner','secret','held',?)",
      )
      .run(
        JSON.stringify({
          duplicate: {
            verdict: "duplicate",
            evidence: "private-proof",
            corpusHash: "private-corpus",
            relatedPostIds: ["public", "hidden", "gone"],
          },
        }),
      );
    fixture.db.exec(
      "INSERT INTO posts(id,author_id,title,status,screening_evidence) VALUES('public','someone','공개 근거','published',NULL),('hidden','someone','비공개','pending',NULL)",
    );
    expect(publicationNotice("private", "owner")).toEqual({
      reason: "duplicate",
      relatedPosts: [{ id: "public", title: "공개 근거" }],
      canRetry: false,
      canRequestReview: false,
    });
    fixture.db.exec("UPDATE posts SET status='held' WHERE id='public'");
    expect(publicationNotice("private", "owner")?.relatedPosts).toEqual([]);
  });
  it("offers retry only for an owned ordinary pending snapshot", () => {
    fixture.db.exec(
      "INSERT INTO posts(id,author_id,title,status,screening_evidence) VALUES('post','owner','제목','pending','{}'); INSERT INTO post_payloads VALUES('owner','post','placeholder')",
    );
    fixture.db
      .prepare("UPDATE post_payloads SET payload_hash=?")
      .run(
        payloadHash({
          title: "제목",
          body: "body",
          kind: "analysis",
          tags: [],
        }),
      );
    expect(publicationNotice("post", "owner")?.canRetry).toBe(true);
    fixture.db
      .prepare("UPDATE posts SET screening_evidence=? WHERE id='post'")
      .run(JSON.stringify({ reason: "attempt_limit" }));
    const hash = payloadHash({
      title: "제목",
      body: "body",
      kind: "analysis",
      tags: [],
    });
    fixture.db
      .prepare("INSERT INTO publication_attempts VALUES(?,3)")
      .run(`post:post:${hash}`);
    expect(publicationNotice("post", "owner")?.canRetry).toBe(false);
  });
});
