import { sectionScope } from "@/lib/session-scope";
import { partyTransactionsExport } from "@/lib/parties/export";

/** This vendor's transactions, as a spreadsheet (SPEC §6). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const scope = await sectionScope("VENDORS");
  const { id } = await params;
  return partyTransactionsExport({
    scope,
    vendorId: id,
    // Regular vendors only: a consultant's account belongs to the Consultants
    // section and must not leave through this door.
    vendorKind: "REGULAR",
    url: request.url,
  });
}
