BEGIN;

ALTER TABLE media_exports ADD COLUMN visual_review_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (visual_review_status IN ('pending', 'approved', 'needs_changes'));
ALTER TABLE media_exports ADD COLUMN visual_reviewed_at TEXT;
ALTER TABLE media_exports ADD COLUMN visual_review_note TEXT;

INSERT OR IGNORE INTO schema_migrations (version) VALUES (7);

COMMIT;
