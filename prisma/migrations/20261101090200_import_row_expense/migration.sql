-- Which expense an imported row became.
--
-- The same job workOrderId already does for the work order import: a committed
-- batch has to be able to show what it created.
ALTER TABLE "ImportRow" ADD COLUMN "expenseId" TEXT;
