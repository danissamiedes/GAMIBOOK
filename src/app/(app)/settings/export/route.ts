import { redirect } from "next/navigation";
import { currentUserId } from "@/lib/auth";
import { resolveActiveCompanyId } from "@/lib/active-company";
import { withCompanyScope } from "@/lib/company-scope";
import { buildCompanyExport } from "@/lib/exports/company-export";
import { writeAudit } from "@/lib/audit";

/**
 * The full data export (SPEC §13).
 *
 * OWNER only, and deliberately stricter than the Settings section around it.
 * The archive contains every section's data in one file — a VENDORS-only
 * bookkeeper who may not open a customer record must not be able to download
 * one inside a zip. Section access is a wall, not a speed bump, so the escape
 * hatch belongs to whoever owns the books.
 */
export async function GET() {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const companyId = await resolveActiveCompanyId(userId);
  if (!companyId) redirect("/no-access");

  const scope = await withCompanyScope(userId, companyId);
  if (!scope.hasRole("OWNER")) {
    redirect(
      `/no-access?reason=${encodeURIComponent(
        "Only an owner can download a full data export. It contains every section's data in one file, including sections your access does not cover.",
      )}`,
    );
  }

  const archive = await buildCompanyExport(scope.companyId);

  // Exporting the whole business is worth a line in the audit log: it is the
  // one action that takes everything out of the app at once.
  await writeAudit({
    companyId: scope.companyId,
    userId,
    action: "company.exported",
    entityType: "Company",
    entityId: scope.companyId,
    summary: `${archive.tables.reduce((rows, table) => rows + table.rows, 0)} rows in ${
      archive.tables.length
    } files`,
  });

  return new Response(new Uint8Array(archive.bytes), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${archive.filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
