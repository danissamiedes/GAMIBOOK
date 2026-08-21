import type { AccountSubtype, AccountType } from "@prisma/client";

/**
 * Which side an account is normally on — derived from its type, never stored
 * (SPEC §4.1). ASSET and EXPENSE are debit-normal; the rest are credit-normal.
 */
export function normalBalance(type: AccountType): "DEBIT" | "CREDIT" {
  return type === "ASSET" || type === "EXPENSE" ? "DEBIT" : "CREDIT";
}

/** Balance-sheet accounts roll forward; income-statement accounts do not. */
export function isBalanceSheet(type: AccountType): boolean {
  return type === "ASSET" || type === "LIABILITY" || type === "EQUITY";
}

export function isIncomeStatement(type: AccountType): boolean {
  return type === "INCOME" || type === "EXPENSE";
}

/**
 * The system accounts the app posts to automatically (SPEC §4.1). They cannot
 * be deleted or retyped, and code finds them by key rather than by name.
 */
export const SYSTEM_ACCOUNTS = {
  ACCOUNTS_RECEIVABLE: "ACCOUNTS_RECEIVABLE",
  ACCOUNTS_PAYABLE: "ACCOUNTS_PAYABLE",
  RETAINED_EARNINGS: "RETAINED_EARNINGS",
  OPENING_BALANCE_EQUITY: "OPENING_BALANCE_EQUITY",
  UNDEPOSITED_FUNDS: "UNDEPOSITED_FUNDS",
  SALES_TAX_PAYABLE: "SALES_TAX_PAYABLE",
  REALIZED_FX_GAIN_LOSS: "REALIZED_FX_GAIN_LOSS",
  FX_ROUNDING_DIFFERENCE: "FX_ROUNDING_DIFFERENCE",
} as const;

export type SystemAccountKey = (typeof SYSTEM_ACCOUNTS)[keyof typeof SYSTEM_ACCOUNTS];

type AccountSeed = {
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  systemKey?: SystemAccountKey;
  description?: string;
};

/**
 * The default chart of accounts given to a new company (SPEC Phase 2). Small
 * on purpose: enough to run this business on day one, easy to extend, and
 * every account the app itself posts to is present and flagged.
 */
export const DEFAULT_CHART_OF_ACCOUNTS: AccountSeed[] = [
  // Assets
  { code: "1000", name: "Operating Bank Account", type: "ASSET", subtype: "CASH" },
  { code: "1010", name: "Cash on Hand", type: "ASSET", subtype: "CASH" },
  {
    code: "1050",
    name: "Undeposited Funds",
    type: "ASSET",
    subtype: "UNDEPOSITED_FUNDS",
    systemKey: SYSTEM_ACCOUNTS.UNDEPOSITED_FUNDS,
    description: "Payments received but not yet deposited.",
  },
  {
    code: "1100",
    name: "Accounts Receivable",
    type: "ASSET",
    subtype: "ACCOUNTS_RECEIVABLE",
    systemKey: SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE,
    description: "Control account. Every line carries a customer.",
  },
  {
    code: "1200",
    name: "Advances to Consultants",
    type: "ASSET",
    subtype: "OTHER_CURRENT_ASSET",
    description: "Cash advanced to a consultant and not yet recovered.",
  },
  { code: "1300", name: "Prepaid Expenses", type: "ASSET", subtype: "OTHER_CURRENT_ASSET" },
  { code: "1500", name: "Equipment", type: "ASSET", subtype: "FIXED_ASSET" },

  // Liabilities
  {
    code: "2000",
    name: "Accounts Payable",
    type: "LIABILITY",
    subtype: "ACCOUNTS_PAYABLE",
    systemKey: SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE,
    description: "Control account. Every line carries a consultant or vendor.",
  },
  { code: "2100", name: "Credit Card", type: "LIABILITY", subtype: "CREDIT_CARD" },
  {
    code: "2200",
    name: "Sales Tax Payable",
    type: "LIABILITY",
    subtype: "OTHER_CURRENT_LIABILITY",
    systemKey: SYSTEM_ACCOUNTS.SALES_TAX_PAYABLE,
  },
  { code: "2300", name: "Accrued Liabilities", type: "LIABILITY", subtype: "OTHER_CURRENT_LIABILITY" },
  { code: "2500", name: "Loans Payable", type: "LIABILITY", subtype: "LONG_TERM_LIABILITY" },

  // Equity
  { code: "3000", name: "Owner Capital", type: "EQUITY", subtype: "EQUITY" },
  { code: "3010", name: "Owner Drawings", type: "EQUITY", subtype: "EQUITY" },
  {
    code: "3100",
    name: "Opening Balance Equity",
    type: "EQUITY",
    subtype: "EQUITY",
    systemKey: SYSTEM_ACCOUNTS.OPENING_BALANCE_EQUITY,
    description: "The balancing figure when opening balances are entered.",
  },
  {
    code: "3900",
    name: "Retained Earnings",
    type: "EQUITY",
    subtype: "RETAINED_EARNINGS",
    systemKey: SYSTEM_ACCOUNTS.RETAINED_EARNINGS,
    description:
      "Nothing posts here except a migration entry. Prior-year profit is computed at report time.",
  },

  // Income
  { code: "4000", name: "Consulting Income", type: "INCOME", subtype: "INCOME" },
  { code: "4100", name: "Other Income", type: "INCOME", subtype: "OTHER_INCOME" },

  // Cost of sales
  { code: "5000", name: "Consultant Fees", type: "EXPENSE", subtype: "COST_OF_SALES" },
  { code: "5100", name: "Subcontractor Costs", type: "EXPENSE", subtype: "COST_OF_SALES" },

  // Operating expenses
  { code: "6000", name: "Bank Charges", type: "EXPENSE", subtype: "EXPENSE" },
  { code: "6050", name: "Software and Subscriptions", type: "EXPENSE", subtype: "EXPENSE" },
  { code: "6100", name: "Supplies Expense", type: "EXPENSE", subtype: "EXPENSE" },
  { code: "6150", name: "Professional Fees", type: "EXPENSE", subtype: "EXPENSE" },
  { code: "6200", name: "Rent", type: "EXPENSE", subtype: "EXPENSE" },
  { code: "6250", name: "Utilities", type: "EXPENSE", subtype: "EXPENSE" },
  { code: "6300", name: "Travel", type: "EXPENSE", subtype: "EXPENSE" },
  { code: "6350", name: "Meals and Entertainment", type: "EXPENSE", subtype: "EXPENSE" },
  { code: "6400", name: "Telephone and Internet", type: "EXPENSE", subtype: "EXPENSE" },

  // Other
  {
    code: "7000",
    name: "Realized FX Gain/Loss",
    type: "EXPENSE",
    subtype: "OTHER_EXPENSE",
    systemKey: SYSTEM_ACCOUNTS.REALIZED_FX_GAIN_LOSS,
    description: "The difference between a document's rate and its payment's rate.",
  },
  {
    code: "7010",
    name: "FX Rounding Difference",
    type: "EXPENSE",
    subtype: "OTHER_EXPENSE",
    systemKey: SYSTEM_ACCOUNTS.FX_ROUNDING_DIFFERENCE,
    description: "Cent-level residual when converted lines miss the converted total.",
  },
];

/** Subtypes offered for each type in the account form. */
export const SUBTYPES_BY_TYPE: Record<AccountType, AccountSubtype[]> = {
  ASSET: ["CASH", "UNDEPOSITED_FUNDS", "ACCOUNTS_RECEIVABLE", "OTHER_CURRENT_ASSET", "FIXED_ASSET"],
  LIABILITY: [
    "ACCOUNTS_PAYABLE",
    "CREDIT_CARD",
    "OTHER_CURRENT_LIABILITY",
    "LONG_TERM_LIABILITY",
  ],
  EQUITY: ["EQUITY", "RETAINED_EARNINGS"],
  INCOME: ["INCOME", "OTHER_INCOME"],
  EXPENSE: ["COST_OF_SALES", "EXPENSE", "OTHER_EXPENSE"],
};

/** Report ordering: assets, liabilities, equity, income, then expenses. */
export const TYPE_ORDER: AccountType[] = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];
