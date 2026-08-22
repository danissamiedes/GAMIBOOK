import { APP_NAME } from "@/lib/brand";
import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/lib/auth";
import { loginErrorCode, loginErrorMessage } from "@/lib/login-errors";
import { Alert, Button, Card, Field, Input } from "@/components/ui";

export const metadata = { title: pageTitle("Sign in") };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");
  const params = await searchParams;

  async function login(formData: FormData) {
    "use server";
    const next = String(formData.get("next") || "/");
    try {
      await signIn("credentials", {
        email: String(formData.get("email") || ""),
        password: String(formData.get("password") || ""),
        redirectTo: next.startsWith("/") ? next : "/",
      });
    } catch (error) {
      // Auth.js signals a successful redirect by throwing; re-throw it.
      if (error && typeof error === "object" && "digest" in error) throw error;
      const code = loginErrorCode(error);
      redirect(`/login?error=${code}${next ? `&next=${encodeURIComponent(next)}` : ""}`);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold text-slate-900 dark:text-slate-50">{APP_NAME}</h1>
      <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">Sign in to continue.</p>
      <Card>
        {params.error ? <Alert tone="error">{loginErrorMessage(params.error)}</Alert> : null}
        <form action={login} className="mt-2 space-y-4">
          <input type="hidden" name="next" value={params.next ?? "/"} />
          <Field label="Email">
            <Input name="email" type="email" autoComplete="username" required autoFocus />
          </Field>
          <Field label="Password">
            <Input name="password" type="password" autoComplete="current-password" required />
          </Field>
          <Button type="submit" className="w-full">
            Sign in
          </Button>
        </form>
      </Card>
      <p className="mt-4 text-center text-sm">
        <Link className="text-slate-600 underline dark:text-slate-400" href="/forgot-password">
          Forgot your password?
        </Link>
      </p>
    </main>
  );
}
