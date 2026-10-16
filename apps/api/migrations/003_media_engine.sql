CREATE TABLE IF NOT EXISTS media_projects (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  source_script TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 5 AND 180),
  width INTEGER NOT NULL DEFAULT 720 CHECK (width IN (720, 1080)),
  height INTEGER NOT NULL DEFAULT 1280 CHECK (height IN (1280, 1920)),
  fps INTEGER NOT NULL DEFAULT 30 CHECK (fps IN (24, 25, 30, 60)),
  crf INTEGER NOT NULL DEFAULT 25 CHECK (crf BETWEEN 18 AND 35),
  burn_subtitles INTEGER NOT NULL DEFAULT 1 CHECK (burn_subtitles IN (0, 1)),
  voice_asset_id TEXT REFERENCES media_assets(id) ON DELETE RESTRICT,
  music_asset_id TEXT REFERENCES media_assets(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'rendering', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(post_id)
);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio')),
  original_name TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL,
  duration_seconds REAL,
  width INTEGER,
  height INTEGER,
  provenance TEXT NOT NULL DEFAULT 'Importado localmente',
  license TEXT NOT NULL DEFAULT 'Sin verificar',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS media_assets_kind_created_idx ON media_assets(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS media_assets_sha256_idx ON media_assets(sha256);

CREATE TABLE IF NOT EXISTS media_scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES media_projects(id) ON DELETE CASCADE,
  scene_order INTEGER NOT NULL CHECK (scene_order BETWEEN 0 AND 31),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 1 AND 180),
  voice_text TEXT NOT NULL DEFAULT '',
  subtitle_text TEXT NOT NULL DEFAULT '',
  visual_description TEXT NOT NULL DEFAULT '',
  visual_type TEXT NOT NULL CHECK (visual_type IN ('image', 'video', 'composition')),
  movement TEXT NOT NULL DEFAULT '',
  transition TEXT NOT NULL DEFAULT 'cut' CHECK (transition IN ('cut', 'fade')),
  on_screen_text TEXT NOT NULL DEFAULT '',
  visual_prompt TEXT NOT NULL DEFAULT '',
  asset_id TEXT REFERENCES media_assets(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, scene_order)
);

CREATE INDEX IF NOT EXISTS media_scenes_project_order_idx ON media_scenes(project_id, scene_order);
CREATE INDEX IF NOT EXISTS media_scenes_asset_idx ON media_scenes(asset_id);

CREATE TABLE IF NOT EXISTS media_render_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES media_projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'processing', 'validating', 'completed', 'failed', 'cancelled')),
  stage TEXT NOT NULL,
  progress REAL CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100)),
  config_json TEXT NOT NULL,
  output_relpath TEXT,
  error_message TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS media_render_jobs_status_created_idx ON media_render_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS media_render_jobs_project_created_idx ON media_render_jobs(project_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS media_render_jobs_one_active_project_idx
  ON media_render_jobs(project_id) WHERE status IN ('queued', 'preparing', 'processing', 'validating');

CREATE TABLE IF NOT EXISTS media_exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES media_projects(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES media_render_jobs(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL UNIQUE,
  subtitle_path TEXT,
  duration_seconds REAL NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  video_codec TEXT NOT NULL,
  audio_codec TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (3);
