/**
 * The shapes the PDF templates render (SPEC §11). Deliberately plain data:
 * the renderer never touches Prisma, so a document can be previewed from a
 * fixture and a template change cannot break a query.
 */

export type BrandingData = {
  companyName: string;
  addressLines: string[];
  email: string | null;
  phone: string | null;
  taxNumber: string | null;
  footerText: string | null;
  logoDataUri: string | null;
};

export type DocumentLineData = {
  description: string;
  quantity: string;
  rate: string;
  amount: string;
};

export type DocumentPdfData = {
  /** "Invoice", "Work Order", "Payment Receipt". */
  title: string;
  /** The allocated number, or the draft marker. */
  number: string;
  isDraft: boolean;
  currency: string;
  partyLabel: string;
  partyName: string;
  partyAddressLines: string[];
  fields: { label: string; value: string }[];
  lines: DocumentLineData[];
  totals: { label: string; value: string; strong?: boolean }[];
  memo: string | null;
  /** Shown under the totals — the FX note, or a payment's applications. */
  notes: string[];
};
