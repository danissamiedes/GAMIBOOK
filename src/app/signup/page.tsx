import { APP_NAME, pageTitle } from "@/lib/brand";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/lib/auth";
import { createAccount, SIGNUP_MESSAGES, type SignupProblem } from "@/lib/billing/signup";
import { rateLimit } from "@/lib/rate-limit";
import { PASSWORD_MIN_LENGTH } from "@/lib/password";
import { PLATFORM_ADDON_PRICE, PLATFORM_ADDON_PERIOD } from "@/components/marketing/content";
import { COMMON_TIME_ZONES, SUPPORTED_CURRENCIES } from "@/lib/currency";
import { TERMS_VERSION } from "@/lib/billing/terms";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";

export const metadata = { title: pageTitle("Create your account") };

/**
 * Self-serve signup (SPEC §16). The first door into this app that an owner did
 * not open for you.
 *
 * Creating the account and paying for it are separate steps on purpose. A
 * stranger will not hand over card details before seeing anything, and an
 * account with no subscription is simply unmetered — so an abandoned signup
 * costs nothing and leaves nothing pretending to be paid for.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");
  const { error } = await searchParams;

  async function register(formData: FormData) {
    "use server";

    // A public endpoint that writes users and sends nothing: throttled by the
    // requester's address, because the cost of abuse here is a table full of
    // junk organizations rather than a mailbox full of mail.
    const forwarded = (await headers()).get("x-forwarded-for") ?? "unknown";
    const limit = await rateLimit(`signup:${forwarded.split(",")[0]!.trim()}`, 5, 3600);
    if (!limit.ok) redirect("/signup?error=throttled");

    const read = (key: string) => String(formData.get(key) || "");
    const result = await createAccount({
      name: read("name"),
      email: read("email"),
      password: read("password"),
      confirm: read("confirm"),
      business: read("business"),
      acceptedTerms: formData.get("terms") === "on",
      baseCurrency: read("baseCurrency") || "USD",
      timeZone: read("timeZone") || "Asia/Manila",
    });

    if (!result.ok) redirect(`/signup?error=${result.problem}`);

    // Straight into the account, so the next screen is theirs rather than a
    // login form asking for the password they just chose.
    await signIn("credentials", {
      email: read("email").trim().toLowerCase(),
      password: read("password"),
      redirectTo: "/subscribe",
    });
  }

  const message =
    error === "throttled"
      ? "Too many sign-up attempts from here. Try again in a little while."
      : error
        ? SIGNUP_MESSAGES[error as SignupProblem]
        : undefined;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <Link href="/" className="mb-1 text-2xl font-bold tracking-tight">
        <span className="text-slate-900 dark:text-white">GAMI</span>
        <span className="text-brand-600 dark:text-brand-400">BOOK</span>
      </Link>
      <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">
        Create your account. The {APP_NAME} system is {PLATFORM_ADDON_PRICE}/
        {PLATFORM_ADDON_PERIOD} — you choose your plan on the next screen, and nothing is
        charged until you approve it at PayPal.
      </p>

      <Card>
        {message ? <Alert tone="error">{message}</Alert> : null}

        <form action={register} className="mt-2 space-y-4">
          <Field label="Your name">
            <Input name="name" required autoFocus autoComplete="name" />
          </Field>
          <Field label="Email">
            <Input name="email" type="email" required autoComplete="username" />
          </Field>
          <Field label="Business name" hint="What your books will be filed under. Changeable later.">
            <Input name="business" required autoComplete="organization" />
          </Field>
          <Field label="Base currency" hint="Permanent once anything is posted.">
            <Select name="baseCurrency" defaultValue="USD">
              {SUPPORTED_CURRENCIES.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code} — {currency.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Time zone">
            <Select name="timeZone" defaultValue="Asia/Manila">
              {COMMON_TIME_ZONES.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}>
            <Input name="password" type="password" required autoComplete="new-password" />
          </Field>
          <Field label="Confirm password">
            <Input name="confirm" type="password" required autoComplete="new-password" />
          </Field>

          <label className="flex gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-900/50">
            <input
              type="checkbox"
              name="terms"
              value="on"
              required
              className="mt-0.5 size-4 shrink-0 accent-brand-600"
            />
            <span className="text-slate-700 dark:text-slate-300">
              I have read and accept the{" "}
              <Link
                href="/terms"
                target="_blank"
                className="text-brand-700 underline dark:text-brand-400"
              >
                Terms of Service
              </Link>
              .
              <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                Version {TERMS_VERSION}. Opens in a new tab so you keep what you have typed.
              </span>
            </span>
          </label>

          <Button type="submit" className="w-full">
            Create account
          </Button>
        </form>
      </Card>

      <p className="mt-6 text-center text-sm text-slate-600 dark:text-slate-400">
        Already have an account?{" "}
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </p>
      <p className="mt-2 text-center text-sm text-slate-600 dark:text-slate-400">
        Looking for the bookkeeping service?{" "}
        <Link href="/#contact" className="underline">
          Book a free consultation
        </Link>
      </p>
    </main>
  );
}
