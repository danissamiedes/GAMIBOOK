import { sectionScope } from "@/lib/session-scope";
import { partyTransactionsExport } from "@/lib/parties/export";

/** This consultant's transactions, as a spreadsheet (SPEC §6). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const scope = await sectionScope("CONSULTANTS");
  const { id } = await params;
  return partyTransactionsExport({
    scope,
    vendorId: id,
    vendorKind: "CONSULTANT",
    url: request.url,
  });
}
