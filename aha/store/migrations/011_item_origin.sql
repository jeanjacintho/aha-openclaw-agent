ALTER TABLE items ADD COLUMN origin TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'backfill'));
