/**
 * Create the first owner on a fresh deployment.
 *
 * `npm run seed` is for development: it invents two companies, four months of
 * transactions and a shared password. You must never point it at real books.
 * This script is the production counterpart — one organization, one empty
 * company, one owner, and nothing else.
 *
 *   docker compose -f docker-compose.prod.yml exec app npm run bootstrap
 *
 * It refuses to run if any user already exists, so it cannot be used to slip a
 * second owner into a live system. Invite people from Settings → Users instead.
 *
 * Every answer can also come from the environment, so an unattended deploy can
 * run it without a terminal:
 *
 *   LEDGER_ADMIN_EMAIL, LEDGER_ADMIN_NAME, LEDGER_ADMIN_PASSWORD,
 *   LEDGER_ORG_NAME, LEDGER_COMPANY_NAME
 *
 * Prefer the prompts where you have a terminal. A password passed as an
 * environment variable ends up in the shell history, in `docker inspect`, and
 * in whatever the process manager logs.
 */
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";
import { PrismaClient, type SequenceKind } from "@prisma/client";
import { hashPassword, PASSWORD_MIN_LENGTH } from "../src/lib/password";
import { createDefaultChartOfAccounts } from "../src/lib/ledger/chart";

const prisma = new PrismaClient();

const SEQUENCES: { kind: SequenceKind; prefix: string; nextValue: number }[] = [
  { kind: "WORK_ORDER", prefix: "WO", nextValue: 1001 },
  { kind: "INVOICE", prefix: "INV", nextValue: 1001 },
  { kind: "JOURNAL_ENTRY", prefix: "JE", nextValue: 1 },
  { kind: "SALES_ORDER", prefix: "SO", nextValue: 1001 },
];

class Abort extends Error {}

/**
 * Readline echoes what is typed by writing it back to its output stream, so the
 * way to hide a password is to give it an output stream that can be silenced —
 * not to reach into the interface's internals, which are undocumented and have
 * moved between Node versions.
 */
let muted = false;
const output = new Writable({
  write(chunk, _encoding, callback) {
    if (!muted) stdout.write(chunk);
    callback();
  },
});

/**
 * One readline interface for the whole run, created on first use. Creating a
 * fresh one per question loses whatever else was already buffered on stdin,
 * which turns a fast-typed answer into a hang on the next prompt.
 */
let rl: Interface | undefined;
function prompts(): Interface {
  if (!rl) rl = createInterface({ input: stdin, output, terminal: true });
  return rl;
}

/** True when there is a person at a terminal who can answer a question. */
const interactive = Boolean(stdin.isTTY && stdout.isTTY);

/**
 * Read one value: the environment wins, then a prompt, then the fallback. With
 * no terminal and no fallback, say which variable to set rather than hanging on
 * a prompt nobody will ever see.
 */
async function value(envVar: string, question: string, fallback?: string): Promise<string> {
  const fromEnv = process.env[envVar]?.trim();
  if (fromEnv) return fromEnv;
  if (!interactive) {
    if (fallback) return fallback;
    throw new Abort(`No terminal to ask on. Set ${envVar}.`);
  }
  const answer = (
    await prompts().question(fallback ? `${question} [${fallback}] ` : `${question} `)
  ).trim();
  return answer || fallback || "";
}

/** As above, but the typed characters are not echoed. */
async function secret(envVar: string, question: string): Promise<string> {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  if (!interactive) throw new Abort(`No terminal to ask on. Set ${envVar}.`);

  const line = prompts();
  // The prompt goes to the real stdout, then everything readline would echo is
  // swallowed until the answer is in.
  const askQuietly = async (label: string) => {
    stdout.write(label);
    muted = true;
    try {
      return await line.question("");
    } finally {
      muted = false;
      stdout.write("\n");
    }
  };

  const first = await askQuietly(question);
  const again = await askQuietly("Again: ");
  if (first !== again) throw new Abort("Those did not match.");
  return first;
}

async function main() {
  const users = await prisma.user.count();
  if (users > 0) {
    throw new Abort(
      `Refusing to run: this database already has ${users} user${users === 1 ? "" : "s"}.\n` +
        "Invite people from Settings → Users. If you meant to start over, you want a new database.",
    );
  }

  if (interactive) console.log("Setting up the first owner. Everything else is done in the app.\n");

  const email = (await value("LEDGER_ADMIN_EMAIL", "Owner email:")).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Abort(`Not an email address: ${email}`);

  const name = await value("LEDGER_ADMIN_NAME", "Owner name:");
  if (!name) throw new Abort("An owner needs a name.");

  const organizationName = await value("LEDGER_ORG_NAME", "Organization name:", `${name}'s books`);
  const companyName = await value("LEDGER_COMPANY_NAME", "Company name:", organizationName);

  const password = await secret(
    "LEDGER_ADMIN_PASSWORD",
    `Password (at least ${PASSWORD_MIN_LENGTH} characters): `,
  );
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Abort(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }

  const passwordHash = await hashPassword(password);

  const company = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({ data: { name: organizationName } });

    // setupCompletedAt stays null on purpose: the first sign-in lands on the
    // setup wizard, which is where the permanent base-currency decision is
    // made with the warning attached to it.
    const created = await tx.company.create({
      data: {
        organizationId: organization.id,
        name: companyName,
        baseCurrency: "PHP",
        fiscalYearStartMonth: 1,
        timeClockTimeZone: "Asia/Manila",
        operatingTimeZone: "Asia/Manila",
      },
    });

    const user = await tx.user.create({ data: { email, name, passwordHash } });
    await tx.membership.create({
      data: { userId: user.id, companyId: created.id, role: "OWNER", sections: [] },
    });

    for (const sequence of SEQUENCES) {
      await tx.numberSequence.create({ data: { companyId: created.id, ...sequence } });
    }

    await createDefaultChartOfAccounts(created.id, tx);
    return created;
  });

  console.log(
    `\nDone. Sign in as ${email} and you will land on the setup wizard, where you\n` +
      `choose the base currency for ${company.name}. That choice is permanent.\n`,
  );
}

function isCancelled(error: unknown): boolean {
  // Ctrl+D or a closed stdin mid-prompt. That is a person changing their mind,
  // not a failure worth a stack trace.
  const code = (error as { code?: string } | null)?.code;
  return code === "ABORT_ERR" || code === "ERR_USE_AFTER_CLOSE";
}

main()
  .catch((error) => {
    if (isCancelled(error)) {
      console.error("\nCancelled. Nothing was written.");
    } else {
      console.error(error instanceof Abort ? error.message : error);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    rl?.close();
    await prisma.$disconnect();
  });
