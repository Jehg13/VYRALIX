CREATE TABLE IF NOT EXISTS ai_generations (
  id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_generation_variants (
  generation_id TEXT NOT NULL REFERENCES ai_generations(id) ON DELETE CASCADE,
  variant_index INTEGER NOT NULL,
  post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  discarded_at TEXT,
  PRIMARY KEY (generation_id, variant_index)
);

CREATE TABLE IF NOT EXISTS ai_provider_attempts (
  id TEXT PRIMARY KEY,
  generation_id TEXT REFERENCES ai_generations(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT,
  task TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failed')),
  error_code TEXT,
  duration_ms INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  fallback_reason TEXT,
  retry_after_seconds INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_amount REAL,
  cost_kind TEXT NOT NULL DEFAULT 'unknown' CHECK (cost_kind IN ('measured', 'estimated', 'unknown')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_generations_created_idx ON ai_generations(created_at DESC);
CREATE INDEX IF NOT EXISTS ai_provider_attempts_provider_idx ON ai_provider_attempts(provider, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_provider_state (
  provider TEXT PRIMARY KEY,
  availability TEXT NOT NULL CHECK (availability IN ('unknown', 'available', 'unavailable', 'model_invalid', 'error')),
  models_json TEXT NOT NULL DEFAULT '[]',
  checked_at TEXT,
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS ai_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (2);
