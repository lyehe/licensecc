-- Server-bound catalog import preview/apply protocol.
--
-- This capability deliberately reuses the conservative `catalog` generation
-- maintained by migration 0028's catalog/policy triggers. Any catalog change
-- between Preview and Apply invalidates the preview; the Apply transaction may
-- then safely use only the immutable stored effects instead of re-reading a
-- manifest or live catalog rows.

CREATE TABLE IF NOT EXISTS catalog_import_previews (
  id                       TEXT PRIMARY KEY,
  actor_subject            TEXT NOT NULL,
  source_generation        INTEGER NOT NULL,
  normalized_manifest_json TEXT NOT NULL,
  manifest_digest          TEXT NOT NULL,
  preview_json             TEXT NOT NULL,
  actions_json             TEXT NOT NULL,
  effective_at             INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  claim_token              TEXT NULL,
  claimed_at               INTEGER NULL,
  consumed_at              INTEGER NULL,
  applied_response_json    TEXT NULL,
  created_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalog_import_previews_expiry
  ON catalog_import_previews(expires_at);

CREATE INDEX IF NOT EXISTS idx_catalog_import_previews_consumed
  ON catalog_import_previews(consumed_at)
  WHERE consumed_at IS NOT NULL;
