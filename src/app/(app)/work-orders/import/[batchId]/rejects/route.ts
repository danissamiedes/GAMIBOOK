import { sectionScope } from "@/lib/session-scope";
import { buildRejectWorkbook } from "@/lib/imports/work-orders";

/** The rejected rows with a reason column, so the user fixes the file itself. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  const scope = await sectionScope("CONSULTANTS");
  const { batchId } = await context.params;

  const bytes = await buildRejectWorkbook(scope.companyId, batchId);

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="rejected-rows-${batchId.slice(-6)}.xlsx"`,
    },
  });
}
