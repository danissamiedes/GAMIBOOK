import { beforeEach, describe, expect, it } from "vitest";
import {
  GRACE_DAYS,
  assertSubscriptionPermitsPosting,
  markActive,
  markPastDue,
  standing,
} from "@/lib/billing/subscription";
import { handleWebhookEvent } from "@/lib/billing/webhook";
import { createAccount } from "@/lib/billing/signup";
import { TERMS_VERSION } from "@/lib/billing/terms";
import { PostingError } from "@/lib/errors";
import { postJournalEntry } from "@/lib/ledger/post";
import { makeCompanyWithChart, prisma, resetDatabase } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDatabase();
});

/** A metered organization with a subscription in the state under test. */
async function subscribedCompany(
  data: Partial<{
    status: "PENDING" | "ACTIVE" | "PAST_DUE" | "READ_ONLY" | "CANCELLED";
    graceUntil: Date | null;
    providerSubscriptionId: string;
  }> = {},
) {
  const fixture = await makeCompanyWithChart("Metered Co");
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: fixture.company.id },
    select: { organizationId: true },
  });
  const subscription = await prisma.subscription.create({
    data: {
      organizationId: company.organizationId,
      status: data.status ?? "ACTIVE",
      graceUntil: data.graceUntil ?? null,
      providerSubscriptionId: data.providerSubscriptionId ?? "I-TEST0001",
      providerPlanId: "P-TEST",
    },
  });
  return { fixture, organizationId: company.organizationId, subscription };
}

describe("what a subscription permits (SPEC §16)", () => {
  it("leaves an organization with no subscription completely unmetered", async () => {
    // This is the rule that keeps the practice's own books working the day
    // billing ships. Absence must never be read as "has not paid".
    const fixture = await makeCompanyWithChart("Unmetered Co");
    const company = await prisma.company.findUniqueOrThrow({
      where: { id: fixture.company.id },
      select: { organizationId: true },
    });

    const result = await standing(company.organizationId);
    expect(result.mayPost).toBe(true);
    expect(result.status).toBe("UNMETERED");
    expect(result.notice).toBeUndefined();

    await expect(assertSubscriptionPermitsPosting(fixture.company.id)).resolves.toBeUndefined();
  });

  it("lets an active subscription post, with nothing to say about it", async () => {
    const { organizationId, fixture } = await subscribedCompany({ status: "ACTIVE" });
    const result = await standing(organizationId);
    expect(result.mayPost).toBe(true);
    expect(result.notice).toBeUndefined();
    await expect(assertSubscriptionPermitsPosting(fixture.company.id)).resolves.toBeUndefined();
  });

  it("keeps a past-due subscription fully usable until grace runs out", async () => {
    const graceUntil = new Date(Date.now() + 3 * DAY);
    const { organizationId, fixture } = await subscribedCompany({
      status: "PAST_DUE",
      graceUntil,
    });

    const result = await standing(organizationId);
    expect(result.mayPost).toBe(true);
    expect(result.status).toBe("PAST_DUE");
    expect(result.notice).toMatch(/did not go through/i);
    await expect(assertSubscriptionPermitsPosting(fixture.company.id)).resolves.toBeUndefined();
  });

  it("goes read-only the moment grace expires, without waiting for a job", async () => {
    // Derived from the clock rather than from a stored status, so a scheduler
    // that never ran cannot quietly extend someone's access.
    const graceUntil = new Date(Date.now() - 1000);
    const { organizationId, fixture } = await subscribedCompany({
      status: "PAST_DUE",
      graceUntil,
    });

    const result = await standing(organizationId);
    expect(result.mayPost).toBe(false);
    expect(result.status).toBe("READ_ONLY");

    await expect(assertSubscriptionPermitsPosting(fixture.company.id)).rejects.toThrow(PostingError);

    // The stored row is untouched: the clock decided, not a write.
    const stored = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });
    expect(stored.status).toBe("PAST_DUE");
  });

  it("refuses posting on a cancelled or pending subscription", async () => {
    for (const status of ["CANCELLED", "PENDING"] as const) {
      await resetDatabase();
      const { organizationId, fixture } = await subscribedCompany({ status });
      const result = await standing(organizationId);
      expect(result.mayPost).toBe(false);
      await expect(assertSubscriptionPermitsPosting(fixture.company.id)).rejects.toThrow(
        PostingError,
      );
    }
  });

  it("says why, in words the subscriber can act on", async () => {
    const { organizationId } = await subscribedCompany({ status: "CANCELLED" });
    const result = await standing(organizationId);
    // Read-only must promise the records are still there. Someone whose card
    // failed at year-end needs to know their books are not held hostage.
    expect(result.notice).toMatch(/read-only/i);
    expect(result.notice).toMatch(/export/i);
  });
});

describe("the posting path enforces it (SPEC §16)", () => {
  it("refuses a real journal entry when the books are read-only", async () => {
    const { fixture, organizationId } = await subscribedCompany({
      status: "PAST_DUE",
      graceUntil: new Date(Date.now() - DAY),
    });

    const entry = () =>
      postJournalEntry({
        companyId: fixture.company.id,
        date: new Date(Date.UTC(2026, 2, 1)),
        memo: "Test",
        sourceType: "MANUAL",
        role: "OWNER",
        lines: [
          { accountId: fixture.code("1000").id, debit: "100.00" },
          { accountId: fixture.code("4000").id, credit: "100.00" },
        ],
      });

    await expect(entry()).rejects.toThrow(/read-only/i);

    // And nothing was written.
    const entries = await prisma.journalEntry.count({ where: { companyId: fixture.company.id } });
    expect(entries).toBe(0);

    // Paying again restores it immediately.
    await prisma.subscription.update({
      where: { organizationId },
      data: { status: "ACTIVE", graceUntil: null },
    });
    await expect(entry()).resolves.toBeTruthy();
  });
});

describe("grace periods (SPEC §16)", () => {
  it("starts the clock on the first failure and never restarts it", async () => {
    // PayPal retries a failed payment and sends an event each time. If every
    // one pushed the deadline out, a subscription that never pays again would
    // work forever.
    const { organizationId } = await subscribedCompany({ status: "ACTIVE" });
    const first = new Date("2026-03-01T00:00:00Z");

    await markPastDue({ providerSubscriptionId: "I-TEST0001", now: first });
    const after = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });
    expect(after.status).toBe("PAST_DUE");
    expect(after.graceUntil?.getTime()).toBe(first.getTime() + GRACE_DAYS * DAY);

    await markPastDue({
      providerSubscriptionId: "I-TEST0001",
      now: new Date("2026-03-10T00:00:00Z"),
    });
    const again = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });
    expect(again.graceUntil?.getTime()).toBe(first.getTime() + GRACE_DAYS * DAY);
  });

  it("clears the clock when a payment succeeds", async () => {
    // A stale graceUntil would send a paying subscriber read-only on a date
    // nobody set.
    const { organizationId } = await subscribedCompany({
      status: "PAST_DUE",
      graceUntil: new Date("2026-03-15T00:00:00Z"),
    });

    await markActive({ providerSubscriptionId: "I-TEST0001" });

    const after = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });
    expect(after.status).toBe("ACTIVE");
    expect(after.graceUntil).toBeNull();
  });
});

describe("PayPal webhooks (SPEC §16)", () => {
  const envelope = (id: string, type: string, resource: Record<string, unknown> = {}) => ({
    id,
    event_type: type,
    resource: { id: "I-TEST0001", ...resource },
  });

  it("activates a subscription and records the next billing date", async () => {
    const { organizationId } = await subscribedCompany({ status: "PENDING" });

    const result = await handleWebhookEvent(
      envelope("EV-1", "BILLING.SUBSCRIPTION.ACTIVATED", {
        subscriber: { email_address: "payer@example.com" },
        billing_info: { next_billing_time: "2026-04-01T00:00:00Z" },
      }),
    );

    expect(result.outcome).toBe("applied");
    const after = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });
    expect(after.status).toBe("ACTIVE");
    expect(after.payerEmail).toBe("payer@example.com");
    expect(after.currentPeriodEnd?.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("ignores a replay of an event it already applied", async () => {
    // The one that matters: a retried PAYMENT.FAILED must not restart grace.
    await subscribedCompany({ status: "ACTIVE" });
    const event = envelope("EV-DUP", "BILLING.SUBSCRIPTION.PAYMENT.FAILED");

    const first = await handleWebhookEvent(event, new Date("2026-03-01T00:00:00Z"));
    expect(first.outcome).toBe("applied");

    const second = await handleWebhookEvent(event, new Date("2026-03-20T00:00:00Z"));
    expect(second.outcome).toBe("duplicate");

    const stored = await prisma.subscription.findFirstOrThrow();
    expect(stored.graceUntil?.toISOString()).toBe(
      new Date(new Date("2026-03-01T00:00:00Z").getTime() + GRACE_DAYS * DAY).toISOString(),
    );
  });

  it("reads the subscription id off a payment event, where it lives elsewhere", async () => {
    // PAYMENT.SALE.COMPLETED carries it as billing_agreement_id, not id.
    const { organizationId } = await subscribedCompany({ status: "PAST_DUE" });

    const result = await handleWebhookEvent({
      id: "EV-SALE",
      event_type: "PAYMENT.SALE.COMPLETED",
      resource: { id: "SALE-123", billing_agreement_id: "I-TEST0001" },
    });

    expect(result.outcome).toBe("applied");
    const after = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });
    expect(after.status).toBe("ACTIVE");
  });

  it("suspends into grace rather than cutting access off", async () => {
    const { organizationId } = await subscribedCompany({ status: "ACTIVE" });
    await handleWebhookEvent(envelope("EV-SUS", "BILLING.SUBSCRIPTION.SUSPENDED"));
    const after = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });
    expect(after.status).toBe("PAST_DUE");
    expect(after.graceUntil).not.toBeNull();
  });

  it("cancels on a cancellation", async () => {
    const { organizationId } = await subscribedCompany({ status: "ACTIVE" });
    await handleWebhookEvent(envelope("EV-CAN", "BILLING.SUBSCRIPTION.CANCELLED"));
    const after = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });
    expect(after.status).toBe("CANCELLED");
    expect(after.cancelledAt).not.toBeNull();
  });

  it("does nothing for an event about a subscription it has never seen", async () => {
    const result = await handleWebhookEvent(
      envelope("EV-STRANGER", "BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-SOMEONE-ELSE" }),
    );
    expect(result.outcome).toBe("unknown-subscription");
  });

  it("ignores event types it has no opinion about", async () => {
    const result = await handleWebhookEvent(envelope("EV-NOISE", "CHECKOUT.ORDER.APPROVED"));
    expect(result.outcome).toBe("ignored");
    // An ignored event is not recorded, so the same id could arrive later as a
    // type we do handle.
    expect(await prisma.providerWebhookEvent.count()).toBe(0);
  });
});

describe("self-serve signup (SPEC §16)", () => {
  const good = {
    name: "Jane Doe",
    email: "jane@example.com",
    password: "a-long-enough-password",
    confirm: "a-long-enough-password",
    business: "Acme Services",
    acceptedTerms: true,
  };

  it("builds the whole account in one go", async () => {
    const result = await createAccount(good);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const membership = await prisma.membership.findFirstOrThrow({
      where: { userId: result.userId },
    });
    expect(membership.role).toBe("OWNER");

    // A usable account means a chart of accounts too — an owner who signs in
    // to a company that cannot record anything has not finished signing up.
    const accounts = await prisma.account.count({ where: { companyId: result.companyId } });
    expect(accounts).toBeGreaterThan(20);
  });

  it("creates no subscription — checkout does that", async () => {
    const result = await createAccount(good);
    expect(result.ok).toBe(true);
    expect(await prisma.subscription.count()).toBe(0);

    // And so a signup abandoned before payment is simply unmetered, not a
    // half-made subscription pretending to be something.
    if (!result.ok) return;
    expect((await standing(result.organizationId)).status).toBe("UNMETERED");
  });

  it("refuses to create an account without accepting the terms", async () => {
    // Enforced here, not only by `required` on the checkbox: a box the browser
    // polices is not a record of anyone agreeing to anything.
    const result = await createAccount({ ...good, acceptedTerms: false });
    expect(result).toEqual({ ok: false, problem: "terms" });
    expect(await prisma.user.count()).toBe(0);
  });

  it("records which version of the terms was accepted, not just that it was", async () => {
    const result = await createAccount(good);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const user = await prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
    expect(user.termsAcceptedAt).not.toBeNull();
    expect(user.termsAcceptedVersion).toBe(TERMS_VERSION);
  });

  it("refuses a second account on the same email", async () => {
    await createAccount(good);
    const again = await createAccount({ ...good, business: "Другое" });
    expect(again).toEqual({ ok: false, problem: "taken" });
    expect(await prisma.user.count()).toBe(1);
  });

  it("checks the obvious things before writing anything", async () => {
    const cases: [Partial<typeof good>, string][] = [
      [{ name: "  " }, "name"],
      [{ email: "not-an-email" }, "email"],
      [{ password: "short", confirm: "short" }, "password"],
      [{ confirm: "something-else-entirely" }, "confirm"],
      [{ business: "" }, "business"],
      [{ acceptedTerms: false }, "terms"],
    ];
    for (const [patch, problem] of cases) {
      const result = await createAccount({ ...good, ...patch });
      expect(result).toEqual({ ok: false, problem });
    }
    expect(await prisma.user.count()).toBe(0);
  });

  it("leaves nothing behind when the transaction fails", async () => {
    // A half-built account is worse than none: the person cannot use it and
    // cannot sign up again with the same email either.
    const before = await prisma.organization.count();
    await createAccount({ ...good, email: "bad" });
    expect(await prisma.organization.count()).toBe(before);
  });
});
