import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { buildTemplateWorkbook } from "@/lib/imports/work-orders";

/** The downloadable template, carrying this company's own names and codes. */
export async function GET() {
  const scope = await sectionScope("CONSULTANTS");

  const [consultants, accounts] = await Promise.all([
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "CONSULTANT", isActive: true },
      select: { name: true, externalRef: true },
      orderBy: { name: "asc" },
    }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: { in: ["EXPENSE", "ASSET"] } },
      select: { code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);

  const bytes = await buildTemplateWorkbook({ consultants, accounts });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="work-order-import-template.xlsx"',
    },
  });
}
