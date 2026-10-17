import type { Section, VendorKind } from "@prisma/client";

/**
 * Credit notes are one document with two homes (SPEC §8.5).
 *
 * A supplier's credit belongs to the Vendors section and a consultant's to
 * Consultants, exactly as their bills do — same table, same screens, and the
 * section decided by whose credit it is rather than by the route. This is the
 * one place that mapping is written down, so the list, the form and the
 * document cannot disagree about it.
 */
export type PartyKey = "vendor" | "consultant";

export const PARTIES: Record<
  PartyKey,
  { kind: VendorKind; section: Section; noun: string; plural: string; billsHref: string }
> = {
  vendor: {
    kind: "REGULAR",
    section: "VENDORS",
    noun: "Vendor",
    plural: "Vendors",
    billsHref: "/expenses?tab=bill",
  },
  consultant: {
    kind: "CONSULTANT",
    section: "CONSULTANTS",
    noun: "Consultant",
    plural: "Consultants",
    billsHref: "/consultant-bills",
  },
};

/** The tab asked for, defaulting to vendors — an unknown value is not an error. */
export function readParty(value: string | undefined): PartyKey {
  return value === "consultant" ? "consultant" : "vendor";
}

/** Which party a credit is for, read back from the vendor it is against. */
export function partyOf(kind: VendorKind): PartyKey {
  return kind === "CONSULTANT" ? "consultant" : "vendor";
}
