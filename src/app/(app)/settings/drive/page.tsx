import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { driveConfigured, driveServiceAccountEmail, DriveError } from "@/lib/drive/client";
import { setWatchedFolder, stopWatching, syncCompanyFolder } from "@/lib/drive/sync";
import { formatAccountingDate } from "@/lib/dates";
import { ConfigurationError, PostingError } from "@/lib/errors";
import { failTo } from "@/lib/fail";
import { Alert, Button, Card, Field, Input, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Google Drive") };

/**
 * The watched Drive folder (SPEC §8.2 extension).
 *
 * Files are linked, never copied: the queue holds a pointer and the folder
 * keeps the only picture. That is the arrangement this screen has to make
 * legible, because it means deleting a photo in Drive takes the evidence with
 * it — and somebody should know that before they tidy up.
 */
export default async function DriveSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; queued?: string }>;
}) {
  const scope = await sectionScope("SETTINGS");
  const params = await searchParams;

  const configured = driveConfigured();
  const serviceAccount = driveServiceAccountEmail();
  const watch = await prisma.driveWatch.findUnique({ where: { companyId: scope.companyId } });

  async function save(formData: FormData) {
    "use server";
    const inner = await sectionScope("SETTINGS");
    try {
      await setWatchedFolder({
        companyId: inner.companyId,
        userId: inner.userId,
        folderInput: String(formData.get("folder") || ""),
        folderName: String(formData.get("folderName") || "").trim() || null,
      });
    } catch (thrown) {
      if (
        thrown instanceof PostingError ||
        thrown instanceof DriveError ||
        thrown instanceof ConfigurationError
      ) {
        failTo("/settings/drive", thrown.message);
      }
      throw thrown;
    }
    redirect("/settings/drive?saved=1");
  }

  async function syncNow() {
    "use server";
    const inner = await sectionScope("SETTINGS");
    let queued = 0;
    try {
      ({ queued } = await syncCompanyFolder(inner.companyId));
    } catch (thrown) {
      if (
        thrown instanceof PostingError ||
        thrown instanceof DriveError ||
        thrown instanceof ConfigurationError
      ) {
        failTo("/settings/drive", thrown.message);
      }
      throw thrown;
    }
    redirect(`/settings/drive?queued=${queued}`);
  }

  async function stop() {
    "use server";
    const inner = await sectionScope("SETTINGS");
    await stopWatching(inner.companyId, inner.userId);
    redirect("/settings/drive?saved=1");
  }

  return (
    <>
      <PageHeader
        title="Google Drive"
        description="Watch a folder. New photos in it appear in the receipt inbox, linked rather than copied."
      />
      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      {params.saved ? <Alert tone="success">Saved.</Alert> : null}
      {params.queued ? (
        <Alert tone="success">
          {params.queued === "0"
            ? "Nothing new in that folder."
            : `${params.queued} new photo${params.queued === "1" ? "" : "s"} added to the inbox.`}
        </Alert>
      ) : null}

      {!configured ? (
        <Alert tone="warning">
          Drive is not set up for this deployment. A service account key belongs
          in <code>GOOGLE_DRIVE_SERVICE_ACCOUNT</code> in the deployment&apos;s
          settings. Until then this screen can watch nothing.
        </Alert>
      ) : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Watched folder</h2>

          {watch ? (
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-slate-500">Folder</div>
                <div className="break-all">
                  {watch.folderName ? `${watch.folderName} — ` : ""}
                  <a
                    className="underline"
                    href={`https://drive.google.com/drive/folders/${watch.folderId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    open in Drive
                  </a>
                </div>
              </div>
              <div>
                <div className="text-slate-500">Last checked</div>
                <div>
                  {watch.lastSyncAt
                    ? `${formatAccountingDate(watch.lastSyncAt)} — ${watch.queuedTotal} receipt${
                        watch.queuedTotal === 1 ? "" : "s"
                      } queued in total`
                    : "not yet"}
                </div>
              </div>
              {watch.lastError ? <Alert tone="error">{watch.lastError}</Alert> : null}

              <div className="flex items-center gap-2 pt-1">
                <form action={syncNow}>
                  <Button type="submit">Check now</Button>
                </form>
                <form action={stop}>
                  <Button variant="secondary" type="submit">
                    Stop watching
                  </Button>
                </form>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Checked automatically about every 15 minutes.{" "}
                <Link className="underline" href="/receipts">
                  Receipt inbox
                </Link>
              </p>
            </div>
          ) : (
            <form action={save} className="space-y-4">
              <Field
                label="Folder link or ID"
                hint="Open the folder in Drive and copy the address bar. The link is fine as it is."
              >
                <Input name="folder" required placeholder="https://drive.google.com/drive/folders/…" />
              </Field>
              <Field label="Name it (optional)">
                <Input name="folderName" placeholder="Receipts 2026" />
              </Field>
              <Button type="submit" disabled={!configured}>
                Watch this folder
              </Button>
            </form>
          )}
        </Card>

        <Card tone="muted">
          <h2 className="mb-3 text-sm font-semibold">Giving it access</h2>
          {serviceAccount ? (
            <>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Share the folder with this address, the same way you would share
                it with a colleague. <strong>Viewer</strong> is enough.
              </p>
              <p className="mt-2 break-all rounded-md bg-white px-3 py-2 font-mono text-xs dark:bg-slate-900">
                {serviceAccount}
              </p>
            </>
          ) : (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Once the service account key is set, the address to share the
              folder with appears here.
            </p>
          )}
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            It can see only what is shared with it — this folder, and nothing
            else in anyone&apos;s Drive.
          </p>
          <Alert tone="warning">
            Photos are linked, not copied. Deleting one in Drive removes the
            receipt behind any expense it became.
          </Alert>
        </Card>
      </div>
    </>
  );
}
