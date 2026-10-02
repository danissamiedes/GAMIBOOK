import Link from "next/link";
import { redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { Alert, Button, Card, DataTable, EmptyState, Field, Input, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Bookable units") };

/**
 * The things people book (SPEC §17).
 *
 * Called whatever the venue calls them — Court, Office, Class, Room — because
 * the word appears all over the public page and nobody books a "unit". The
 * label lives in Booking settings; this screen just reads it.
 */
export default async function UnitsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const scope = await sectionScope("BOOKINGS");
  const { error, saved } = await searchParams;

  const [settings, units] = await Promise.all([
    prisma.bookingSettings.findUnique({ where: { companyId: scope.companyId } }),
    prisma.bookableUnit.findMany({
      where: scope.where,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { _count: { select: { bookings: true } } },
    }),
  ]);

  const label = settings?.unitLabel ?? "Unit";
  const plural = settings?.unitLabelPlural ?? "Units";

  async function add(formData: FormData) {
    "use server";
    const inner = await sectionScope("BOOKINGS");
    const name = String(formData.get("name") || "").trim();
    if (!name) redirect("/bookings/units?error=name");

    const unit = await prisma.bookableUnit.create({
      data: {
        companyId: inner.companyId,
        name,
        note: String(formData.get("note") || "").trim() || null,
        sortOrder: Number(formData.get("sortOrder") || 0),
      },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "bookable_unit.created",
      entityType: "BookableUnit",
      entityId: unit.id,
      summary: name,
    });
    redirect("/bookings/units?saved=1");
  }

  async function toggle(formData: FormData) {
    "use server";
    const inner = await sectionScope("BOOKINGS");
    const id = String(formData.get("unitId") || "");
    const unit = await prisma.bookableUnit.findFirst({ where: { id, ...inner.where } });
    if (!unit) redirect("/bookings/units");
    // Never deleted once it has bookings: those rows are the record of money
    // taken, and they name the court they were for.
    await prisma.bookableUnit.update({
      where: { id: unit.id },
      data: { isActive: !unit.isActive },
    });
    redirect("/bookings/units?saved=1");
  }

  return (
    <>
      <PageHeader
        title={plural}
        description={`What people book here. Each one gets a column on the public page.`}
      />

      <div className="mb-4">
        <Link href="/bookings">
          <Button variant="ghost">All bookings</Button>
        </Link>
      </div>

      {error === "name" ? <Alert tone="error">A name is required.</Alert> : null}
      {saved ? <Alert tone="success">Saved.</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          {units.length === 0 ? (
            <EmptyState title={`No ${plural.toLowerCase()} yet`}>
              Add the first one on the right. Until there is at least one, the public page has
              nothing to show.
            </EmptyState>
          ) : (
            <DataTable>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="px-2 py-2">Name</th>
                  <th className="px-2 py-2">Note</th>
                  <th className="px-2 py-2 text-right">Order</th>
                  <th className="px-2 py-2 text-right">Bookings</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {units.map((unit) => (
                  <tr key={unit.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="px-2 py-2">
                      <span className={unit.isActive ? "" : "text-slate-400 line-through"}>
                        {unit.name}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-sm text-slate-500">{unit.note ?? "—"}</td>
                    <td className="px-2 py-2 text-right text-sm tabular-nums">{unit.sortOrder}</td>
                    <td className="px-2 py-2 text-right text-sm tabular-nums">
                      {unit._count.bookings || "—"}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <form action={toggle}>
                        <input type="hidden" name="unitId" value={unit.id} />
                        <Button variant="ghost" type="submit">
                          {unit.isActive ? "Deactivate" : "Reactivate"}
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>

        <Card tone="muted">
          <h2 className="mb-3 text-sm font-semibold">Add a {label.toLowerCase()}</h2>
          <form action={add} className="space-y-4">
            <Field label="Name">
              <Input name="name" required placeholder={`${label} 1`} />
            </Field>
            <Field label="Note" hint="Optional — shown under the name.">
              <Input name="note" placeholder="Indoor, covered" />
            </Field>
            <Field label="Order" hint="Lower numbers come first on the page.">
              <Input name="sortOrder" type="number" defaultValue={units.length} />
            </Field>
            <Button type="submit">Add {label.toLowerCase()}</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
