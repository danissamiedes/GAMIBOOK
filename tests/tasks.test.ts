import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { issueInvoice } from "@/lib/invoices/service";
import { approveWorkOrder } from "@/lib/payables/work-orders";
import { recordExpense } from "@/lib/payables/expenses";
import { withCompanyScope } from "@/lib/company-scope";
import {
  assignableUsers,
  createTask,
  listTasks,
  setTaskStatus,
  tasksForDocument,
  whyNotATask,
} from "@/lib/tasks";
import {
  makeCompanyWithChart,
  makeCustomer,
  makeDraftInvoice,
  makeUser,
  makeVendor,
  prisma,
  resetDatabase,
} from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const DATE = utc(2026, 8, 15);

/**
 * SPEC §14: tasks, and who may see them.
 *
 * The load-bearing property is the visibility rule. A task is derived from the
 * document it hangs on, so it can never be a way to read something the access
 * rules already refuse — a bookkeeper without SALES must not learn from a task
 * board what an invoice they cannot open is about.
 */
describe("tasks", () => {
  let fixture: Fixture;
  let owner: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Task Co", "PHP");
    owner = await makeUser("OWNER", fixture.company.id);
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const scopeFor = (userId: string) => withCompanyScope(userId, fixture.company.id);

  const anInvoice = async () => {
    const customer = await makeCustomer(fixture.company.id);
    const draft = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: DATE,
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          rate: "1000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    const { invoice } = await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: draft.id,
      role: "OWNER",
    });
    return invoice;
  };

  const aWorkOrder = async () => {
    const consultant = await makeVendor(fixture.company.id, "CONSULTANT");
    const created = await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: consultant.id,
        issueDate: DATE,
        dueDate: DATE,
        currency: "PHP",
        total: "5000.00",
        balanceDue: "5000.00",
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "Consultation",
              quantity: "1",
              rate: "5000.00",
              amount: "5000.00",
              accountId: fixture.code("5000").id,
            },
          ],
        },
      },
    });
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: created.id });
    return created;
  };

  describe("whyNotATask", () => {
    it("wants a subject", () => {
      expect(whyNotATask({ subject: "   " })).toMatch(/subject/);
      expect(whyNotATask({ subject: "Call Robelyn" })).toBeNull();
    });

    it("refuses a task claiming two documents", () => {
      expect(
        whyNotATask({ subject: "Both", link: { invoiceId: "a", workOrderId: "b" } }),
      ).toMatch(/one document/);
    });
  });

  it("records a task against a document, with its details", async () => {
    const scope = await scopeFor(owner.id);
    const invoice = await anInvoice();

    const task = await createTask(scope, {
      subject: "Chase the PO number",
      note: "Accounts payable asked for it twice.",
      dueDate: utc(2026, 8, 20),
      priority: "HIGH",
      assignedUserId: owner.id,
      link: { invoiceId: invoice.id },
    });

    expect(task.status).toBe("OPEN");
    expect(task.priority).toBe("HIGH");
    expect(task.createdByUserId).toBe(owner.id);
    expect(await tasksForDocument(scope, { invoiceId: invoice.id })).toHaveLength(1);
  });

  it("keeps a standalone task, with no document at all", async () => {
    const scope = await scopeFor(owner.id);
    const task = await createTask(scope, { subject: "Renew the business permit" });

    expect(task.invoiceId).toBeNull();
    expect(await listTasks(scope)).toHaveLength(1);
  });

  describe("who can see it", () => {
    it("hides a task about an invoice from someone without Sales", async () => {
      const ownerScope = await scopeFor(owner.id);
      const invoice = await anInvoice();
      await createTask(ownerScope, {
        subject: "Secret invoice business",
        link: { invoiceId: invoice.id },
      });

      // Holds VENDORS only — the invoice is not theirs to open, so neither is
      // anything a task might say about it.
      const vendorsOnly = await makeUser("BOOKKEEPER", fixture.company.id, undefined, ["VENDORS"]);
      const theirScope = await scopeFor(vendorsOnly.id);

      expect(await listTasks(theirScope)).toHaveLength(0);
      expect(await listTasks(ownerScope)).toHaveLength(1);
    });

    it("shows a task about a bill to whoever holds Vendors", async () => {
      const ownerScope = await scopeFor(owner.id);
      const vendor = await makeVendor(fixture.company.id, "REGULAR");
      const { expense } = await recordExpense({
        companyId: fixture.company.id,
        kind: "BILL",
        vendorId: vendor.id,
        date: DATE,
        amount: "800.00",
        currency: "PHP",
        description: "Paint",
        expenseAccountId: fixture.code("5000").id,
        role: "OWNER",
      });
      await createTask(ownerScope, { subject: "Get the receipt", link: { expenseId: expense.id } });

      const vendorsOnly = await makeUser("BOOKKEEPER", fixture.company.id, undefined, ["VENDORS"]);
      expect(await listTasks(await scopeFor(vendorsOnly.id))).toHaveLength(1);

      const salesOnly = await makeUser("BOOKKEEPER", fixture.company.id, undefined, ["SALES"]);
      expect(await listTasks(await scopeFor(salesOnly.id))).toHaveLength(0);
    });

    it("shows a standalone task to everyone, having no document to protect", async () => {
      await createTask(await scopeFor(owner.id), { subject: "Renew the permit" });

      const bankingOnly = await makeUser("BOOKKEEPER", fixture.company.id, undefined, ["BANKING"]);
      expect(await listTasks(await scopeFor(bankingOnly.id))).toHaveLength(1);
    });

    it("refuses to raise a task on a document the raiser cannot open", async () => {
      const invoice = await anInvoice();
      const vendorsOnly = await makeUser("BOOKKEEPER", fixture.company.id, undefined, ["VENDORS"]);

      await expect(
        createTask(await scopeFor(vendorsOnly.id), {
          subject: "Nosy",
          link: { invoiceId: invoice.id },
        }),
      ).rejects.toThrow(/cannot raise a task on that document/);
    });

    it("will not attach another company's document", async () => {
      const elsewhere = await makeCompanyWithChart("Elsewhere", "PHP");
      const theirCustomer = await makeCustomer(elsewhere.company.id);
      const theirDraft = await makeDraftInvoice({
        companyId: elsewhere.company.id,
        customerId: theirCustomer.id,
        currency: "PHP",
        issueDate: DATE,
        lines: [
          {
            description: "Theirs",
            quantity: "1",
            rate: "10.00",
            incomeAccountId: elsewhere.code("4000").id,
          },
        ],
      });

      await expect(
        createTask(await scopeFor(owner.id), {
          subject: "Reaching",
          link: { invoiceId: theirDraft.id },
        }),
      ).rejects.toThrow(/not in this company/);
    });
  });

  describe("finishing one", () => {
    it("completes and reopens, stamping who and when", async () => {
      const scope = await scopeFor(owner.id);
      const task = await createTask(scope, { subject: "Call the bank" });

      const done = await setTaskStatus(scope, task.id, "COMPLETED");
      expect(done.status).toBe("COMPLETED");
      expect(done.completedAt).not.toBeNull();
      expect(done.completedByUserId).toBe(owner.id);

      const again = await setTaskStatus(scope, task.id, "OPEN");
      expect(again.status).toBe("OPEN");
      // The constraint in the migration says a completed task has a time and an
      // open one does not, so reopening has to clear it.
      expect(again.completedAt).toBeNull();
    });

    it("cannot be ticked by someone who cannot see it", async () => {
      const ownerScope = await scopeFor(owner.id);
      const invoice = await anInvoice();
      const task = await createTask(ownerScope, {
        subject: "Theirs to do",
        link: { invoiceId: invoice.id },
      });

      const vendorsOnly = await makeUser("BOOKKEEPER", fixture.company.id, undefined, ["VENDORS"]);
      await expect(
        setTaskStatus(await scopeFor(vendorsOnly.id), task.id, "COMPLETED"),
      ).rejects.toThrow(/not found/);
    });
  });

  it("filters by status, assignee and priority", async () => {
    const scope = await scopeFor(owner.id);
    const other = await makeUser("BOOKKEEPER", fixture.company.id, undefined, ["SALES"]);

    await createTask(scope, { subject: "Mine, high", priority: "HIGH", assignedUserId: owner.id });
    await createTask(scope, { subject: "Theirs", assignedUserId: other.id });
    const done = await createTask(scope, { subject: "Finished" });
    await setTaskStatus(scope, done.id, "COMPLETED");

    expect(await listTasks(scope, { status: "OPEN" })).toHaveLength(2);
    expect(await listTasks(scope, { status: "COMPLETED" })).toHaveLength(1);
    expect(await listTasks(scope, { status: "ALL" })).toHaveLength(3);
    expect(await listTasks(scope, { assignedUserId: other.id })).toHaveLength(1);
    expect(await listTasks(scope, { priority: "HIGH" })).toHaveLength(1);
  });

  it("goes when its document goes", async () => {
    const scope = await scopeFor(owner.id);
    const workOrder = await aWorkOrder();
    await createTask(scope, { subject: "About this order", link: { workOrderId: workOrder.id } });

    expect(await prisma.task.count()).toBe(1);
    await prisma.workOrder.delete({ where: { id: workOrder.id } });
    // A task pointing at a document that no longer exists is a row nobody can
    // act on, so the foreign key takes it too.
    expect(await prisma.task.count()).toBe(0);
  });

  it("refuses an assignee who is not in the company", async () => {
    const elsewhere = await makeCompanyWithChart("Elsewhere", "PHP");
    const stranger = await makeUser("OWNER", elsewhere.company.id);

    await expect(
      createTask(await scopeFor(owner.id), { subject: "Hi", assignedUserId: stranger.id }),
    ).rejects.toThrow(/not a member of this company/);
  });

  it("offers only members who use the books as assignees", async () => {
    // A CONSULTANT holds no sections — they clock in and out and see nothing
    // else, so a task assigned to them would be one they could never open.
    await makeUser("CONSULTANT", fixture.company.id);
    await makeUser("BOOKKEEPER", fixture.company.id, undefined, ["SALES"]);

    const users = await assignableUsers(fixture.company.id);
    expect(users).toHaveLength(2);
  });
});
