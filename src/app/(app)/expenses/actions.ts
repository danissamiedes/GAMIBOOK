"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { failTo } from "@/lib/fail";
import { writeAudit } from "@/lib/audit";
import { sectionScope } from "@/lib/session-scope";
import { recordExpense, updateExpense } from "@/lib/payables/expenses";
import { parseMoney } from "@/lib/money";
import { parseAccountingDate, today } from "@/lib/dates";
import { safeExternalUrl } from "@/lib/links";
import { markInboxRecorded } from "@/lib/receipts/inbox";
import { PostingError } from "@/lib/errors";

/**
 * Recording and correcting an expense, from whichever screen asked (SPEC §8.2).
 *
 * The form used to live in a column beside the list and its actions were
 * closures on that page. Now that recording and editing are screens of their
 * own — and a consultant's bill is the same document under a different
 * section — the actions live here, once, and each entry point passes the
 * section it was reached through. The section is never read from the form:
 * the Vendors screens call the Vendors action, and a hidden field claiming
 * otherwise would be a way into a consultant's bill.
 */

type Section = "VENDORS" | "CONSULTANTS";

/** Everything the two forms have in common, read once. */
function readForm(formData: FormData) {
  return {
    vendorId: String(formData.get("vendorId") || "") || null,
    date: parseAccountingDate(String(formData.get("date") || "")) ?? today(),
    dueDate: parseAccountingDate(String(formData.get("dueDate") || "")),
    currency: String(formData.get("currency") || "").toUpperCase(),
    fxRate: parseMoney(String(formData.get("fxRate") || "1")) ?? 1,
    amount: parseMoney(String(formData.get("amount") || "")),
    expenseAccountId: String(formData.get("expenseAccountId")),
    paymentAccountId: String(formData.get("paymentAccountId") || "") || null,
    description: String(formData.get("description") || "").trim(),
    reference: String(formData.get("reference") || "").trim() || null,
    receiptUrl: safeExternalUrl(String(formData.get("fileUrl") || "")),
    /** Set when this was started from a forwarded email (SPEC §8.2 ext). */
    inboxMessageId: String(formData.get("inboxMessageId") || "") || null,
  };
}

async function create(section: Section, kind: "DIRECT" | "BILL", formData: FormData) {
  const scope = await sectionScope(section);
  const form = readForm(formData);
  const back =
    section === "CONSULTANTS"
      ? "/consultant-bills/new"
      : `/expenses/new?tab=${kind === "BILL" ? "bill" : "direct"}`;
  if (!form.amount) failTo(back, "Enter the amount");

  if (section === "CONSULTANTS") {
    // A consultant's bill is owed to a consultant, and this screen cannot be
    // used to post against a regular vendor by editing the form.
    const consultant = await prisma.vendor.findFirst({
      where: { id: form.vendorId ?? "", ...scope.where, kind: "CONSULTANT" },
      select: { id: true },
    });
    if (!consultant) failTo(back, "Pick a consultant");
  }

  let expenseId = "";
  try {
    const result = await recordExpense({
      companyId: scope.companyId,
      kind,
      vendorId: form.vendorId,
      date: form.date,
      dueDate: kind === "BILL" ? form.dueDate : null,
      currency: form.currency,
      fxRate: form.fxRate,
      amount: form.amount!,
      expenseAccountId: form.expenseAccountId,
      paymentAccountId: kind === "DIRECT" ? form.paymentAccountId : null,
      description: form.description,
      reference: form.reference,
      receiptUrl: form.receiptUrl,
      userId: scope.userId,
      role: scope.role,
    });
    expenseId = result.expense.id;
    await writeAudit({
      companyId: scope.companyId,
      userId: scope.userId,
      action:
        section === "CONSULTANTS"
          ? "consultant_bill.recorded"
          : kind === "DIRECT"
            ? "expense.recorded"
            : "bill.recorded",
      entityType: "Expense",
      entityId: expenseId,
      summary: `${form.amount!.toFixed(2)} — ${form.description}`,
    });
  } catch (thrown) {
    if (thrown instanceof PostingError) failTo(back, thrown.message);
    throw thrown;
  }

  // Tick the forwarded email off, after the posting rather than inside it:
  // the inbox is a queue of paperwork, and failing to cross a row out must
  // never undo a bill that is correctly in the books.
  if (form.inboxMessageId) {
    try {
      await markInboxRecorded({
        companyId: scope.companyId,
        messageId: form.inboxMessageId,
        expenseId,
        userId: scope.userId,
      });
    } catch (error) {
      console.error("[inbox] recorded the expense but could not mark the message", error);
    }
  }
  // Onto the document itself: what was just recorded is what somebody wants
  // to see, and it is where editing, tasks and payments are from now on.
  redirect(`/expenses/${expenseId}?saved=1`);
}

async function save(section: Section, formData: FormData) {
  const scope = await sectionScope(section);
  const expenseId = String(formData.get("expenseId") || "");
  const back = `/expenses/${expenseId}/edit`;
  const form = readForm(formData);
  if (!form.amount) failTo(back, "Enter the amount");

  // The expense must be one this section may touch, whatever the form says.
  const existing = await prisma.expense.findFirst({
    where: { id: expenseId, ...scope.where },
    select: { kind: true, vendor: { select: { kind: true } } },
  });
  const consultants = existing?.vendor?.kind === "CONSULTANT";
  if (!existing || (section === "CONSULTANTS") !== consultants) {
    failTo(section === "CONSULTANTS" ? "/consultant-bills" : "/expenses", "That expense was not found");
  }

  try {
    await updateExpense({
      companyId: scope.companyId,
      expenseId,
      vendorId: form.vendorId,
      date: form.date,
      currency: form.currency,
      fxRate: form.fxRate,
      amount: form.amount!,
      expenseAccountId: form.expenseAccountId,
      paymentAccountId: existing!.kind === "DIRECT" ? form.paymentAccountId : null,
      dueDate: existing!.kind === "BILL" ? form.dueDate : null,
      description: form.description,
      reference: form.reference,
      receiptUrl: form.receiptUrl,
      userId: scope.userId,
      role: scope.role,
    });
    await writeAudit({
      companyId: scope.companyId,
      userId: scope.userId,
      action: existing!.kind === "BILL" ? "bill.updated" : "expense.updated",
      entityType: "Expense",
      entityId: expenseId,
    });
  } catch (thrown) {
    if (thrown instanceof PostingError) failTo(back, thrown.message);
    throw thrown;
  }
  redirect(`/expenses/${expenseId}?saved=1`);
}

export async function createDirectExpense(formData: FormData) {
  return create("VENDORS", "DIRECT", formData);
}

export async function createVendorBill(formData: FormData) {
  return create("VENDORS", "BILL", formData);
}

export async function createConsultantBill(formData: FormData) {
  return create("CONSULTANTS", "BILL", formData);
}

export async function saveVendorExpense(formData: FormData) {
  return save("VENDORS", formData);
}

export async function saveConsultantBill(formData: FormData) {
  return save("CONSULTANTS", formData);
}
