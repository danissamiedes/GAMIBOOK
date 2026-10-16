import { sectionScope } from "@/lib/session-scope";
import { buildRejectWorkbook } from "@/lib/imports/work-orders";

/**
 * The rejected rows with a reason column, so the sheet itself gets fixed.
 *
 * The builder is shared with the work order import: a rejected row is the raw
 * row plus why it was refused, whatever it was going to become.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  const scope = await sectionScope("VENDORS");
  const { batchId } = await context.params;

  const bytes = await buildRejectWorkbook(scope.companyId, batchId);

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="rejected-expenses-${batchId.slice(-6)}.xlsx"`,
    },
  });
}
