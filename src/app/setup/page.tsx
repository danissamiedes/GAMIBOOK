import { redirect } from "next/navigation";
import { currentUserId } from "@/lib/auth";
import { withCompanyScope } from "@/lib/company-scope";
import { resolveActiveCompanyId, setActiveCompany } from "@/lib/active-company";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { Alert, Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { COMMON_TIME_ZONES, MONTHS, SUPPORTED_CURRENCIES, isSupportedCurrency } from "@/lib/currency";

export const metadata = { title: "Set up your company — Ledger" };

/**
 * Company setup wizard (SPEC §1 Phase 1, §5). One screen, because there are
 * only four decisions — but one of them is permanent, and the warning about it
 * is required, not decorative.
 */
export default async function SetupPage() {
  const userId = await currentUserId();
  if (!userId) redirect("/login");

  const companyId = await resolveActiveCompanyId(userId);
  if (!companyId) redirect("/no-access");

  const scope = await withCompanyScope(userId, companyId);
  scope.requireRole("OWNER", "BOOKKEEPER");

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  if (company.setupCompletedAt) redirect("/dashboard");

  async function complete(formData: FormData) {
    "use server";
    const uid = await currentUserId();
    const cid = await resolveActiveCompanyId(uid ?? "");
    const inner = await withCompanyScope(uid, cid);
    inner.requireRole("OWNER", "BOOKKEEPER");

    const existing = await prisma.company.findFirstOrThrow({ where: { id: inner.companyId } });
    if (existing.setupCompletedAt) redirect("/dashboard");

    const name = String(formData.get("name") || "").trim();
    const baseCurrency = String(formData.get("baseCurrency") || "").toUpperCase();
    const fiscalYearStartMonth = Number(formData.get("fiscalYearStartMonth"));
    const timeClockTimeZone = String(formData.get("timeClockTimeZone"));
    const operatingTimeZone = String(formData.get("operatingTimeZone"));

    if (!name || !isSupportedCurrency(baseCurrency)) redirect("/setup");
    if (!Number.isInteger(fiscalYearStartMonth) || fiscalYearStartMonth < 1 || fiscalYearStartMonth > 12) {
      redirect("/setup");
    }

    await prisma.company.update({
      where: { id: inner.companyId },
      data: {
        name,
        baseCurrency,
        fiscalYearStartMonth,
        timeClockTimeZone,
        operatingTimeZone,
        setupCompletedAt: new Date(),
      },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "company.setup_completed",
      entityType: "Company",
      entityId: inner.companyId,
      data: { baseCurrency, fiscalYearStartMonth, timeClockTimeZone, operatingTimeZone },
    });

    await setActiveCompany(inner.companyId);
    redirect("/dashboard");
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <PageHeader
        title="Set up your company"
        description="Four decisions. One of them is permanent."
      />
      <Card>
        <form action={complete} className="space-y-5">
          <Field label="Company name">
            <Input name="name" defaultValue={company.name} required autoFocus />
          </Field>

          <Field label="Base currency">
            <Select name="baseCurrency" defaultValue={company.baseCurrency}>
              {SUPPORTED_CURRENCIES.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code} — {currency.label}
                </option>
              ))}
            </Select>
          </Field>
          <Alert tone="warning">
            <strong>This cannot be changed later.</strong> Every report is presented in this
            currency and every posting is stored in it. Documents in another currency are converted
            at the rate on the document. Changing base currency after anything is posted is not
            supported.
          </Alert>

          <Field label="Fiscal year starts">
            <Select name="fiscalYearStartMonth" defaultValue={company.fiscalYearStartMonth}>
              {MONTHS.map((month, index) => (
                <option key={month} value={index + 1}>
                  {month}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Time clock time zone"
            hint="Consultant clock in/out is displayed and grouped in this zone, for every viewer."
          >
            <Select name="timeClockTimeZone" defaultValue={company.timeClockTimeZone}>
              {COMMON_TIME_ZONES.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Operating time zone"
            hint="Scheduled jobs such as recurring invoicing run on this zone — deliberately separate from the clock zone."
          >
            <Select name="operatingTimeZone" defaultValue={company.operatingTimeZone}>
              {COMMON_TIME_ZONES.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>

          <Button type="submit">Finish setup</Button>
        </form>
      </Card>
    </main>
  );
}
