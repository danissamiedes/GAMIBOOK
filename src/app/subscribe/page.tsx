import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { currentUserId } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { resolveActiveCompanyId } from "@/lib/active-company";
import { withCompanyScope } from "@/lib/company-scope";
import { beginCheckout } from "@/lib/billing/checkout";
import { checkoutReadiness, paypalEnvironment } from "@/lib/billing/paypal";
import { standing } from "@/lib/billing/subscription";
import { requestOrigin } from "@/lib/request-origin";
import {
  PLATFORM_ADDON_PERIOD,
  PLATFORM_ADDON_PRICE,
  PLATFORM_OPTIONS,
} from "@/components/marketing/content";
import { Alert, Button, Card, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Your subscription") };

/**
 * Pick up the subscription (SPEC §16).
 *
 * Reached straight after signup, and again from anywhere the books have gone
 * read-only. Nothing is charged here — the button creates a subscription at
 * PayPal and sends the payer there to approve it.
 */
export default async function SubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ cancelled?: string; error?: string }>;
}) {
  const userId = await currentUserId();
  if (!userId) redirect("/login?next=/subscribe");
  const { cancelled, error } = await searchParams;

  const companyId = await resolveActiveCompanyId(userId);
  if (!companyId) redirect("/no-access");
  const scope = await withCompanyScope(userId, companyId);
  scope.requireRole("OWNER");

  const company = await prisma.company.findFirstOrThrow({
    where: { id: scope.companyId },
    select: { organizationId: true, name: true },
  });

  const [current, readiness] = await Promise.all([
    standing(company.organizationId),
    Promise.resolve(checkoutReadiness()),
  ]);

  async function subscribe() {
    "use server";
    const uid = await currentUserId();
    if (!uid) redirect("/login?next=/subscribe");
    const cid = await resolveActiveCompanyId(uid);
    const inner = await withCompanyScope(uid, cid);
    inner.requireRole("OWNER");

    const [innerCompany, innerUser] = await Promise.all([
      prisma.company.findFirstOrThrow({
        where: { id: inner.companyId },
        select: { organizationId: true },
      }),
      prisma.user.findUniqueOrThrow({ where: { id: uid }, select: { email: true, name: true } }),
    ]);

    const result = await beginCheckout({
      organizationId: innerCompany.organizationId,
      email: innerUser.email,
      name: innerUser.name,
      origin: requestOrigin(await headers()),
    });

    if (!result.ok) redirect(`/subscribe?error=${result.reason}`);
    redirect(result.approveUrl);
  }

  const plan = PLATFORM_OPTIONS[0];
  const live = current.status === "ACTIVE" || current.status === "PAST_DUE";

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <PageHeader
        title="Your subscription"
        description={`The ${PLATFORM_ADDON_PRICE}/${PLATFORM_ADDON_PERIOD} GAMIBOOK system, for ${company.name}.`}
      />

      {cancelled ? (
        <Alert tone="warning">
          Checkout was cancelled at PayPal. Nothing has been charged, and you can start again
          whenever you like.
        </Alert>
      ) : null}
      {error === "already-subscribed" ? (
        <Alert tone="success">This organization already has a live subscription.</Alert>
      ) : null}
      {error === "not-configured" ? (
        <Alert tone="error">
          Payments are not switched on yet. PAYPAL_SYSTEM_PLAN_ID is not set on this deployment.
        </Alert>
      ) : null}
      {current.notice ? <Alert tone={current.mayPost ? "warning" : "error"}>{current.notice}</Alert> : null}

      <Card className="mt-6">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-bold">{plan.name}</h2>
          <p>
            <span className="text-2xl font-bold tracking-tight">{PLATFORM_ADDON_PRICE}</span>
            <span className="text-sm text-slate-500">/{PLATFORM_ADDON_PERIOD}</span>
          </p>
        </div>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{plan.pitch}</p>

        <ul className="mt-5 space-y-2 text-sm text-slate-600 dark:text-slate-300">
          {plan.features.map((feature) => (
            <li key={feature}>· {feature}</li>
          ))}
        </ul>

        <div className="mt-7 border-t border-slate-200 pt-5 dark:border-slate-700">
          {live ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              You are subscribed. Manage or cancel it from your PayPal account at any time —
              cancelling takes effect at the end of the period you have paid for.
            </p>
          ) : readiness.ready ? (
            <form action={subscribe}>
              <Button type="submit" className="w-full">
                Continue to PayPal
              </Button>
              <p className="mt-3 text-center text-xs text-slate-500 dark:text-slate-400">
                You approve the subscription at PayPal. Nothing is charged until you do.
                {paypalEnvironment() === "sandbox" ? " (Sandbox mode — test money only.)" : ""}
              </p>
            </form>
          ) : (
            <Alert tone="error">
              Payments are not configured on this deployment. Missing:{" "}
              {readiness.missing.join(", ")}.
            </Alert>
          )}
        </div>
      </Card>

      <p className="mt-6 text-center text-sm text-slate-600 dark:text-slate-400">
        Want the bookkeeping done for you instead?{" "}
        <Link href="/#pricing" className="underline">
          See the service plans
        </Link>
      </p>
      <p className="mt-2 text-center text-sm">
        <Link href="/dashboard" className="text-slate-500 underline">
          Skip for now
        </Link>
      </p>
    </main>
  );
}
