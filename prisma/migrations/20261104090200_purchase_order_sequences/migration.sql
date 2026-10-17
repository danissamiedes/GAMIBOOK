-- Every company needs a purchase-order sequence before it can issue one.
--
-- New companies get theirs from DEFAULT_SEQUENCES; the ones already here get
-- it now, with the same prefix and starting number, so an existing book can
-- raise a purchase order the moment this deploys.
INSERT INTO "NumberSequence" ("id", "companyId", "kind", "prefix", "nextValue")
SELECT
  'poseq_' || substr(md5(random()::text || c."id"), 1, 20),
  c."id",
  'PURCHASE_ORDER',
  'PO',
  1001
FROM "Company" c
WHERE NOT EXISTS (
  SELECT 1 FROM "NumberSequence" s
   WHERE s."companyId" = c."id" AND s."kind" = 'PURCHASE_ORDER'
);
