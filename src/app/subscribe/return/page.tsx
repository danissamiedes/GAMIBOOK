import Link from "next/link";
import { redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { currentUserId } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { resolveActiveCompanyId } from "@/lib/active-company";
import { withCompanyScope } from "@/lib/company-scope";
import { completeCheckout } from "@/lib/billing/checkout";
import { Alert, Button, Card, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Subscription") };

/**
 * Where PayPal sends the payer back to (SPEC §16).
 *
 * This asks PayPal what happened rather than believing the redirect. A return
 * URL is only a URL — it can be typed, bookmarked or shared — so arriving here
 * proves nothing, and the subscription id in the query has to belong to this
 * organization before it counts for anything.
 *
 * The webhook reaches the same conclusion independently. Either can be first,
 * and both are idempotent, so a payer who closes the tab still ends up
 * subscribed.
 */
export default async function SubscribeReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ subscription_id?: string }>;
}) {
  const userId = await currentUserId();
  if (!userId) redirect("/login?next=/subscribe");

  const companyId = await resolveActiveCompanyId(userId);
  if (!companyId) redirect("/no-access");
  const scope = await withCompanyScope(userId, companyId);
  scope.requireRole("OWNER");

  const { subscription_id: subscriptionId } = await searchParams;
  const company = await prisma.company.findFirstOrThrow({
    where: { id: scope.companyId },
    select: { organizationId: true },
  });

  const result = subscriptionId
    ? await completeCheckout({
        organizationId: company.organizationId,
        providerSubscriptionId: subscriptionId,
      })
    : ({ ok: false, reason: "unknown" } as const);

  return (
    <main className="mx-auto max-w-lg px-4 py-16">
      <PageHeader title={result.ok ? "You're subscribed" : "Not confirmed yet"} />

      <Card className="mt-4">
        {result.ok ? (
          <>
            <Alert tone="success">
              PayPal has confirmed the subscription. Your books are fully open.
            </Alert>
            <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">
              You can cancel any time from your PayPal account. A receipt for each payment comes
              from PayPal directly.
            </p>
            <Link href="/dashboard" className="mt-6 inline-block">
              <Button>Go to your dashboard</Button>
            </Link>
          </>
        ) : (
          <>
            <Alert tone="warning">
              {result.reason === "unknown"
                ? "We could not match that to a subscription for this account."
                : `PayPal has not activated this subscription yet${
                    result.remoteStatus ? ` — it reports "${result.remoteStatus}"` : ""
                  }.`}
            </Alert>
            <p className="mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              If you did approve it, this usually settles itself within a minute — PayPal confirms
              separately and the account updates on its own. Refresh this page, or check back
              shortly.
            </p>
            <div className="mt-6 flex gap-3">
              <Link href="/subscribe">
                <Button variant="secondary">Back to the subscription</Button>
              </Link>
              <Link href="/dashboard">
                <Button variant="ghost">Dashboard</Button>
              </Link>
            </div>
          </>
        )}
      </Card>
    </main>
  );
}
