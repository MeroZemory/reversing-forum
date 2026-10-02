import Database from "better-sqlite3";

const path = process.env.DATABASE_PATH || "data/forum.sqlite";
export const db = new Database(path);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY, author_id TEXT NOT NULL, author_name TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL, tags TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','published','held')),
    created_at TEXT NOT NULL, screening_evidence TEXT
  );
  CREATE INDEX IF NOT EXISTS posts_status_date ON posts(status, created_at);
  CREATE INDEX IF NOT EXISTS posts_author_date ON posts(author_id, created_at);
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id),
    parent_id TEXT REFERENCES comments(id), author_id TEXT NOT NULL,
    author_name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS comments_post_date ON comments(post_id, created_at);
  CREATE INDEX IF NOT EXISTS comments_author_date ON comments(author_id, created_at);
  CREATE TABLE IF NOT EXISTS editorial_basis (
    id INTEGER PRIMARY KEY CHECK(id=1), versions TEXT NOT NULL,
    allowed INTEGER NOT NULL CHECK(allowed IN (0,1)), generation INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS editorial_drafts (
    candidate_key TEXT PRIMARY KEY, author_id TEXT NOT NULL, editor_id TEXT NOT NULL, state TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS editorial_revisions (
    candidate_key TEXT NOT NULL REFERENCES editorial_drafts(candidate_key),
    revision INTEGER NOT NULL, payload_hash TEXT NOT NULL, hash TEXT NOT NULL, versions TEXT NOT NULL,
    PRIMARY KEY(candidate_key, revision)
  );
  CREATE TABLE IF NOT EXISTS editorial_sources (
    candidate_key TEXT NOT NULL REFERENCES editorial_drafts(candidate_key),
    alias TEXT NOT NULL, PRIMARY KEY(candidate_key, alias)
  );
  CREATE INDEX IF NOT EXISTS editorial_sources_alias ON editorial_sources(alias);
  CREATE TABLE IF NOT EXISTS editorial_suppression (
    source_key TEXT PRIMARY KEY, generation INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS editorial_receipts (
    candidate_key TEXT PRIMARY KEY REFERENCES editorial_drafts(candidate_key),
    post_id TEXT NOT NULL UNIQUE REFERENCES posts(id),
    revision INTEGER NOT NULL, hash TEXT NOT NULL, provenance TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS editorial_publications (
    candidate_key TEXT NOT NULL REFERENCES editorial_drafts(candidate_key),
    revision INTEGER NOT NULL, hash TEXT NOT NULL, versions TEXT NOT NULL, post_id TEXT NOT NULL REFERENCES posts(id),
    PRIMARY KEY(candidate_key, revision)
  );
  CREATE TABLE IF NOT EXISTS editorial_audit (
    id INTEGER PRIMARY KEY, candidate_key TEXT, actor_id TEXT NOT NULL,
    action TEXT NOT NULL, revision INTEGER, hash TEXT, created_at TEXT NOT NULL
  );
`);
