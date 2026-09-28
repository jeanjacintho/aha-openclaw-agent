ALTER TABLE ledger ADD COLUMN claimed_at TEXT;

-- The key carries a UTC date but not a time. Use the end of that day as the
-- latest possible reservation time; fall back to migration time for malformed
-- or legacy keys without a parseable date.
UPDATE ledger
SET claimed_at = COALESCE(
  strftime('%Y-%m-%dT23:59:59.999Z', substr(key, 6, 10)),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
WHERE key LIKE 'post:%'
  AND state IN ('ready', 'posting', 'posted', 'verified', 'uncertain')
  AND claimed_at IS NULL;

CREATE INDEX ledger_claimed_at_idx ON ledger (claimed_at);
