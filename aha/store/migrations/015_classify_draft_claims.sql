ALTER TABLE items ADD COLUMN classify_claimed_until TEXT;

DELETE FROM drafts
WHERE state IN ('pending', 'approved', 'ignored')
  AND id NOT IN (
    SELECT MAX(id) FROM drafts
    WHERE state IN ('pending', 'approved', 'ignored')
    GROUP BY item_id
  );

CREATE UNIQUE INDEX drafts_one_active_per_item_idx ON drafts(item_id)
WHERE state IN ('pending', 'approved', 'ignored');
