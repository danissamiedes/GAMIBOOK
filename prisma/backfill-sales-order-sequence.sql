-- Companies created before sales orders existed need the new sequence.
INSERT INTO "NumberSequence" ("id", "companyId", "kind", "prefix", "nextValue")
SELECT gen_random_uuid()::text, c."id", 'SALES_ORDER', 'SO', 1001
FROM "Company" c
WHERE NOT EXISTS (
  SELECT 1 FROM "NumberSequence" s WHERE s."companyId" = c."id" AND s."kind" = 'SALES_ORDER'
);
