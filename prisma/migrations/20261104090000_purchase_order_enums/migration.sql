-- SPEC §8.1a: purchase orders.
--
-- The three enum values they need, in their own migration: a new value cannot
-- be used in the transaction that adds it, and the tables below use all three.
ALTER TYPE "SequenceKind" ADD VALUE 'PURCHASE_ORDER';
ALTER TYPE "EmailTemplateKind" ADD VALUE 'PURCHASE_ORDER';
ALTER TYPE "ImportBatchKind" ADD VALUE 'PURCHASE_ORDER';
