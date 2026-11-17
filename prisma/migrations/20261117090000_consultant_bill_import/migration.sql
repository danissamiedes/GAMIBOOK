-- A month of consultant bills from a spreadsheet (SPEC §8.3).
--
-- Its own batch kind rather than reusing EXPENSE: the two sheets are
-- different documents with different columns, they are reviewed on different
-- screens under different sections, and a batch has to be able to say which
-- it is. Nothing is backfilled — every batch already on file is what its
-- kind already says it is.
ALTER TYPE "ImportBatchKind" ADD VALUE 'CONSULTANT_BILL';
