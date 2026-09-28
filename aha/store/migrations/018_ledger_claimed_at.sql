ALTER TABLE ledger ADD COLUMN claimed_at TEXT;

-- Existing counted reservations have no exact timestamp. Treat them as newly
-- claimed at migration time so they remain inside the rolling window safely.
UPDATE ledger
SET claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key LIKE 'post:%'
  AND state IN ('ready', 'posting', 'posted', 'verified', 'uncertain')
  AND claimed_at IS NULL;

CREATE INDEX ledger_claimed_at_idx ON ledger (claimed_at);
