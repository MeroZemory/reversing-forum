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
`);
