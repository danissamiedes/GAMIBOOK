import type { VendorKind } from "@prisma/client";

/**
 * The two kinds share a table but not a form (SPEC §6). Which section a user
 * holds decides which kind they ever see, and that filtering happens in the
 * data layer — never by hiding fields in the view.
 */
export const VENDOR_KIND_LABELS: Record<VendorKind, string> = {
  CONSULTANT: "Consultant",
  REGULAR: "Regular vendor",
};

export const VENDOR_SECTION: Record<VendorKind, "CONSULTANTS" | "VENDORS"> = {
  CONSULTANT: "CONSULTANTS",
  REGULAR: "VENDORS",
};
