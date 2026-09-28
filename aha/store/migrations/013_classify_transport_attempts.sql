ALTER TABLE items ADD COLUMN classify_transport_attempts INTEGER NOT NULL DEFAULT 0 CHECK (classify_transport_attempts >= 0);
