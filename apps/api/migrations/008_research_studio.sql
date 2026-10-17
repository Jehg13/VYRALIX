CREATE TABLE IF NOT EXISTS research_sessions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  result_json TEXT,
  error_code TEXT,
  provider TEXT NOT NULL DEFAULT 'gemini',
  model TEXT,
  proposal_json TEXT,
  proposal_status TEXT NOT NULL DEFAULT 'none' CHECK (proposal_status IN ('none', 'draft', 'approved', 'sent_to_media')),
  proposal_provider TEXT,
  proposal_model TEXT,
  proposal_request_key TEXT,
  media_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS research_sessions_created_idx ON research_sessions(created_at DESC);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (8);
