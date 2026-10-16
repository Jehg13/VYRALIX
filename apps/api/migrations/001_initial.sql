CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'TikTok',
  category TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  hashtags TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'Idea propia',
  status TEXT NOT NULL CHECK (status IN (
    'idea', 'draft', 'pending_review', 'approved', 'scheduled',
    'publishing', 'published', 'error', 'archived'
  )),
  scheduled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS posts_scheduled_at_idx ON posts(scheduled_at);
CREATE INDEX IF NOT EXISTS posts_status_idx ON posts(status);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type = 'local_test'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'error')),
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, created_at);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
