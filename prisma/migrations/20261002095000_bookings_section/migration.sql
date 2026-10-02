-- A section of its own, so a front desk that takes bookings does not also see
-- the profit and loss.
--
-- Alone in its own migration deliberately: Postgres will not let a new enum
-- value be USED in the transaction that adds it, and Prisma runs one migration
-- per transaction. Splitting guarantees it is committed before the tables that
-- reference it are created.
ALTER TYPE "Section" ADD VALUE IF NOT EXISTS 'BOOKINGS';
