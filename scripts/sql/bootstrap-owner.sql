-- Create the first owner of a Ledger deployment, from the Supabase SQL editor.
--
-- No password is set here, and none passes through this file. It leaves a
-- one-time reset link instead, so you choose the password in the browser and
-- the app hashes it with the Argon2id parameters it expects.
--
-- Uses only core Postgres — sha256() and gen_random_uuid() — so it does not
-- depend on pgcrypto being installed.
--
-- EDIT THE FOUR VALUES MARKED <<< BELOW, then run the whole file at once.

BEGIN;

-- Refuses to run on a database that already has users, so this cannot quietly
-- add a second owner to live books. Invite people from Settings → Users.
DO $guard$
BEGIN
  IF (SELECT count(*) FROM "User") > 0 THEN
    RAISE EXCEPTION
      'This database already has % user(s). Invite people from Settings -> Users instead.',
      (SELECT count(*) FROM "User");
  END IF;
END
$guard$;

-- MATERIALIZED is not decoration: without it Postgres may evaluate this CTE
-- once per reference, generating a different random token for the row it
-- stores and the link it prints — a link that could never work.
WITH input AS MATERIALIZED (
  SELECT
    'you@example.com'                    AS email,         -- <<< your email
    'Your Name'                          AS owner_name,    -- <<< your name
    'Bookkeeping Point'                  AS company_name,  -- <<< the business
    'https://gamibook.vercel.app'        AS site_url,      -- <<< no trailing slash
    -- Two UUIDs of strong randomness. Only its SHA-256 is stored.
    replace(gen_random_uuid()::text, '-', '') ||
    replace(gen_random_uuid()::text, '-', '') AS reset_token
),
org AS (
  INSERT INTO "Organization" (id, name, "updatedAt")
  SELECT gen_random_uuid()::text, input.company_name, now() FROM input
  RETURNING id
),
company AS (
  -- setupCompletedAt stays NULL on purpose: your first sign-in lands on the
  -- setup wizard, where the permanent base-currency choice is made.
  INSERT INTO "Company" (id, "organizationId", name, "baseCurrency",
                         "fiscalYearStartMonth", "timeClockTimeZone",
                         "operatingTimeZone", "updatedAt")
  SELECT gen_random_uuid()::text, org.id, input.company_name, 'PHP',
         1, 'Asia/Manila', 'Asia/Manila', now()
  FROM org, input
  RETURNING id
),
new_user AS (
  -- passwordHash NULL until the reset link is used. Sign-in refuses an account
  -- without one, so there is no window in which this is a usable empty account.
  INSERT INTO "User" (id, email, name, "passwordHash", "isActive", "updatedAt")
  SELECT gen_random_uuid()::text, lower(trim(input.email)), input.owner_name,
         NULL, true, now()
  FROM input
  RETURNING id
),
membership AS (
  INSERT INTO "Membership" (id, "userId", "companyId", role, sections, "updatedAt")
  SELECT gen_random_uuid()::text, new_user.id, company.id, 'OWNER',
         ARRAY[]::"Section"[], now()
  FROM new_user, company
  RETURNING id
),
sequences AS (
  INSERT INTO "NumberSequence" (id, "companyId", kind, prefix, "nextValue")
  SELECT gen_random_uuid()::text, company.id, s.kind::"SequenceKind", s.prefix, s.next
  FROM company,
       (VALUES ('WORK_ORDER','WO',1001),
               ('INVOICE','INV',1001),
               ('JOURNAL_ENTRY','JE',1),
               ('SALES_ORDER','SO',1001)) AS s(kind, prefix, next)
  RETURNING id
),
accounts AS (
  INSERT INTO "Account" (id, "companyId", code, name, type, subtype,
                         "systemKey", "isSystem", description, "updatedAt")
  SELECT gen_random_uuid()::text, company.id, a.code, a.name,
         a.type::"AccountType", a.subtype::"AccountSubtype",
         a.system_key, a.is_system, a.description, now()
  FROM company,
    (VALUES
    ('1000', 'Operating Bank Account', 'ASSET', 'CASH', NULL, false, NULL), 
    ('1010', 'Cash on Hand', 'ASSET', 'CASH', NULL, false, NULL), 
    ('1050', 'Undeposited Funds', 'ASSET', 'UNDEPOSITED_FUNDS', 'UNDEPOSITED_FUNDS', true, 'Payments received but not yet deposited.'), 
    ('1100', 'Accounts Receivable', 'ASSET', 'ACCOUNTS_RECEIVABLE', 'ACCOUNTS_RECEIVABLE', true, 'Control account. Every line carries a customer.'), 
    ('1200', 'Advances to Consultants', 'ASSET', 'OTHER_CURRENT_ASSET', NULL, false, 'Cash advanced to a consultant and not yet recovered.'), 
    ('1300', 'Prepaid Expenses', 'ASSET', 'OTHER_CURRENT_ASSET', NULL, false, NULL), 
    ('1500', 'Equipment', 'ASSET', 'FIXED_ASSET', NULL, false, NULL), 
    ('2000', 'Accounts Payable', 'LIABILITY', 'ACCOUNTS_PAYABLE', 'ACCOUNTS_PAYABLE', true, 'Control account. Every line carries a consultant or vendor.'), 
    ('2100', 'Credit Card', 'LIABILITY', 'CREDIT_CARD', NULL, false, NULL), 
    ('2200', 'Sales Tax Payable', 'LIABILITY', 'OTHER_CURRENT_LIABILITY', 'SALES_TAX_PAYABLE', true, NULL), 
    ('2300', 'Accrued Liabilities', 'LIABILITY', 'OTHER_CURRENT_LIABILITY', NULL, false, NULL), 
    ('2500', 'Loans Payable', 'LIABILITY', 'LONG_TERM_LIABILITY', NULL, false, NULL), 
    ('3000', 'Owner Capital', 'EQUITY', 'EQUITY', NULL, false, NULL), 
    ('3010', 'Owner Drawings', 'EQUITY', 'EQUITY', NULL, false, NULL), 
    ('3100', 'Opening Balance Equity', 'EQUITY', 'EQUITY', 'OPENING_BALANCE_EQUITY', true, 'The balancing figure when opening balances are entered.'), 
    ('3900', 'Retained Earnings', 'EQUITY', 'RETAINED_EARNINGS', 'RETAINED_EARNINGS', true, 'Nothing posts here except a migration entry. Prior-year profit is computed at report time.'), 
    ('4000', 'Consulting Income', 'INCOME', 'INCOME', NULL, false, NULL), 
    ('4100', 'Other Income', 'INCOME', 'OTHER_INCOME', NULL, false, NULL), 
    ('5000', 'Consultant Fees', 'EXPENSE', 'COST_OF_SALES', NULL, false, NULL), 
    ('5100', 'Subcontractor Costs', 'EXPENSE', 'COST_OF_SALES', NULL, false, NULL), 
    ('6000', 'Bank Charges', 'EXPENSE', 'EXPENSE', NULL, false, NULL), 
    ('6050', 'Software and Subscriptions', 'EXPENSE', 'EXPENSE', NULL, false, NULL), 
    ('6100', 'Supplies Expense', 'EXPENSE', 'EXPENSE', NULL, false, NULL), 
    ('6150', 'Professional Fees', 'EXPENSE', 'EXPENSE', NULL, false, NULL), 
    ('6200', 'Rent', 'EXPENSE', 'EXPENSE', NULL, false, NULL), 
    ('6250', 'Utilities', 'EXPENSE', 'EXPENSE', NULL, false, NULL), 
    ('6300', 'Travel', 'EXPENSE', 'EXPENSE', NULL, false, NULL), 
    ('6350', 'Meals and Entertainment', 'EXPENSE', 'EXPENSE', NULL, false, NULL), 
    ('6400', 'Telephone and Internet', 'EXPENSE', 'EXPENSE', NULL, false, NULL), 
    ('7000', 'Realized FX Gain/Loss', 'EXPENSE', 'OTHER_EXPENSE', 'REALIZED_FX_GAIN_LOSS', true, 'The difference between a document''s rate and its payment''s rate.'), 
    ('7010', 'FX Rounding Difference', 'EXPENSE', 'OTHER_EXPENSE', 'FX_ROUNDING_DIFFERENCE', true, 'Cent-level residual when converted lines miss the converted total.') 
    ) AS a(code, name, type, subtype, system_key, is_system, description)
  RETURNING id
),
reset AS (
  INSERT INTO "PasswordResetToken" (id, "userId", "tokenHash", "expiresAt")
  SELECT gen_random_uuid()::text, new_user.id,
         encode(sha256(convert_to(input.reset_token, 'UTF8')), 'hex'),
         now() + interval '2 hours'
  FROM new_user, input
  RETURNING id
)
SELECT
  input.site_url || '/reset-password/' || input.reset_token AS open_this_within_2_hours,
  (SELECT count(*) FROM accounts)  AS accounts_created,
  (SELECT count(*) FROM sequences) AS sequences_created,
  (SELECT count(*) FROM reset)     AS reset_links_created
FROM input;

COMMIT;
