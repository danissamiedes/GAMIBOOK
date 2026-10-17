-- Who each email was about, kept on the log itself (SPEC §10).
--
-- Written at send time from the document's party, so the log keeps saying
-- what happened even after a consultant is renamed or removed. The rows
-- already on file are filled in from their documents below; one that has no
-- document — a test message, a booking receipt — simply has no name.
ALTER TABLE "EmailLog" ADD COLUMN "recipientName" TEXT;

UPDATE "EmailLog" l
   SET "recipientName" = v."name"
  FROM "WorkOrder" w
  JOIN "Vendor" v ON v."id" = w."vendorId"
 WHERE l."relatedType" = 'WorkOrder'
   AND l."relatedId" = w."id";

UPDATE "EmailLog" l
   SET "recipientName" = v."name"
  FROM "PurchaseOrder" p
  JOIN "Vendor" v ON v."id" = p."vendorId"
 WHERE l."relatedType" = 'PurchaseOrder'
   AND l."relatedId" = p."id";

UPDATE "EmailLog" l
   SET "recipientName" = c."name"
  FROM "Invoice" i
  JOIN "Customer" c ON c."id" = i."customerId"
 WHERE l."relatedType" = 'Invoice'
   AND l."relatedId" = i."id";

UPDATE "EmailLog" l
   SET "recipientName" = c."name"
  FROM "Payment" pay
  JOIN "Customer" c ON c."id" = pay."customerId"
 WHERE l."relatedType" = 'Payment'
   AND l."relatedId" = pay."id";

-- Every address on the message as one searchable string. The To box matches
-- part of an address without regard to case, which Postgres cannot do inside
-- a text[]; this is the column it searches instead.
ALTER TABLE "EmailLog" ADD COLUMN "recipientsText" TEXT;

UPDATE "EmailLog"
   SET "recipientsText" =
         array_to_string("toAddresses", ' ') ||
         CASE WHEN array_length("cc", 1) IS NULL THEN '' ELSE ' ' || array_to_string("cc", ' ') END;

-- A booking's emails go to whoever booked, and the group carries their name.
UPDATE "EmailLog" l
   SET "recipientName" = g."customerName"
  FROM "BookingGroup" g
 WHERE l."relatedType" = 'Booking'
   AND l."relatedId" = g."id";
