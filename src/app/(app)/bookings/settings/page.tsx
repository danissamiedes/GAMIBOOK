import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { parseMinute, toTimeInput } from "@/lib/bookings/slots";
import { requestOrigin } from "@/lib/request-origin";
import { storage, storageKeys, withStorage } from "@/lib/storage";
import { Alert, Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("Booking settings") };

/** A QR is a small square image. Anything larger is a photo of a wall. */
const MAX_QR_BYTES = 5 * 1024 * 1024;
const QR_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Lowercase, hyphenated, no surprises in a URL. */
function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * How this company's bookings work (SPEC §17).
 *
 * The public page does not exist until it is published here, and it lives at
 * an address the company chooses. Publishing is the switch that makes a venue
 * reachable by strangers, so it is a deliberate tick rather than a side effect
 * of filling the form in.
 */
export default async function BookingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const scope = await sectionScope("BOOKINGS");
  const { error, saved } = await searchParams;

  const [company, existing] = await Promise.all([
    prisma.company.findFirstOrThrow({
      where: { id: scope.companyId },
      select: { name: true, operatingTimeZone: true, email: true },
    }),
    prisma.bookingSettings.findUnique({ where: { companyId: scope.companyId } }),
  ]);

  const origin = requestOrigin(await headers());

  async function save(formData: FormData) {
    "use server";
    const inner = await sectionScope("BOOKINGS");

    const slug = toSlug(String(formData.get("slug") || ""));
    if (!slug) redirect("/bookings/settings?error=slug");

    const opens = parseMinute(String(formData.get("opensAt") || ""));
    const closes = parseMinute(String(formData.get("closesAt") || ""));
    if (opens === null || closes === null) redirect("/bookings/settings?error=time");
    if (closes <= opens) redirect("/bookings/settings?error=window");

    const slotMinutes = Number(formData.get("slotMinutes") || 60);
    if (!Number.isInteger(slotMinutes) || slotMinutes < 5 || slotMinutes > 720) {
      redirect("/bookings/settings?error=slot");
    }

    const unitLabel = String(formData.get("unitLabel") || "Unit").trim() || "Unit";
    const data = {
      unitLabel,
      unitLabelPlural: String(formData.get("unitLabelPlural") || "").trim() || `${unitLabel}s`,
      slug,
      isPublished: formData.get("isPublished") === "on",
      venueName: String(formData.get("venueName") || "").trim() || null,
      venueAddress: String(formData.get("venueAddress") || "").trim() || null,
      intro: String(formData.get("intro") || "").trim() || null,
      slotMinutes,
      opensAtMinute: opens,
      closesAtMinute: closes,
      horizonDays: Math.min(90, Math.max(1, Number(formData.get("horizonDays") || 14))),
      paymentInstructions: String(formData.get("paymentInstructions") || "").trim() || null,
      holdMinutes: Math.min(1440, Math.max(5, Number(formData.get("holdMinutes") || 120))),
      notifyEmail: String(formData.get("notifyEmail") || "").trim() || null,
    };

    // The QR is only touched when a new one is sent or removal is ticked, so
    // saving the form for any other reason never loses the image already there.
    const qr = formData.get("paymentQr");
    const removeQr = formData.get("removeQr") === "on";
    let qrFields: { paymentQrKey?: string | null; paymentQrName?: string | null } = {};

    if (qr instanceof File && qr.size > 0) {
      if (qr.size > MAX_QR_BYTES) redirect("/bookings/settings?error=qrSize");
      if (qr.type && !QR_TYPES.includes(qr.type)) redirect("/bookings/settings?error=qrType");

      const key = storageKeys.bookingQr(inner.companyId, qr.name);
      // Read the bytes before handing the callback over: an `await` inside the
      // arrow would need it to be async, and withStorage takes a plain thunk.
      const bytes = Buffer.from(await qr.arrayBuffer());
      await withStorage("upload", () => storage().put(key, bytes, qr.type || undefined));
      qrFields = { paymentQrKey: key, paymentQrName: qr.name };
    } else if (removeQr) {
      qrFields = { paymentQrKey: null, paymentQrName: null };
    }

    try {
      await prisma.bookingSettings.upsert({
        where: { companyId: inner.companyId },
        create: { companyId: inner.companyId, ...data, ...qrFields },
        update: { ...data, ...qrFields },
      });
    } catch (fault) {
      // The slug is unique across every company: two venues cannot share a
      // public address, and the second one to try must be told why.
      if (fault && typeof fault === "object" && "code" in fault && fault.code === "P2002") {
        redirect("/bookings/settings?error=slugTaken");
      }
      throw fault;
    }

    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "booking_settings.updated",
      entityType: "BookingSettings",
      summary: data.isPublished ? `published at /book/${slug}` : "saved, not published",
    });
    redirect("/bookings/settings?saved=1");
  }

  const MESSAGES: Record<string, string> = {
    slug: "The public address needs at least one letter or number.",
    slugTaken: "Another venue already uses that address. Pick a different one.",
    time: "Those opening hours could not be read.",
    window: "Closing time has to be after opening time.",
    slot: "A slot is between 5 minutes and 12 hours long.",
    qrType: "The QR has to be an image — a PNG, JPEG or WebP.",
    qrSize: "That image is over 5 MB. A screenshot of a QR is usually far smaller.",
  };

  const slug = existing?.slug ?? toSlug(company.name);

  return (
    <>
      <PageHeader
        title="Booking settings"
        description={`Times are in this company's operating zone, ${company.operatingTimeZone}.`}
      />

      <div className="mb-4">
        <Link href="/bookings">
          <Button variant="ghost">All bookings</Button>
        </Link>
      </div>

      {error ? <Alert tone="error">{MESSAGES[error] ?? "That could not be saved."}</Alert> : null}
      {saved ? <Alert tone="success">Saved.</Alert> : null}

      <Card className="max-w-2xl">
        <form action={save} encType="multipart/form-data" className="space-y-5">
          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold">The public page</legend>

            <Field
              label="Address"
              hint={`Your page will be at ${origin}/book/<address>`}
            >
              <Input name="slug" defaultValue={slug} required />
            </Field>

            <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-900/50">
              <input
                type="checkbox"
                name="isPublished"
                defaultChecked={existing?.isPublished ?? false}
                className="mt-0.5 size-4 accent-brand-600"
              />
              <span>
                <strong className="block">Open for bookings</strong>
                <span className="text-slate-600 dark:text-slate-400">
                  Until this is ticked the page is not reachable at all, even by someone who has
                  the link.
                </span>
              </span>
            </label>

            {existing?.isPublished ? (
              <p className="text-sm">
                Live at{" "}
                <a
                  href={`/book/${existing.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted underline-offset-2"
                >
                  {origin}/book/{existing.slug}
                </a>
              </p>
            ) : null}

            <Field label="Venue name" hint={`Blank uses the company name, ${company.name}.`}>
              <Input name="venueName" defaultValue={existing?.venueName ?? ""} />
            </Field>
            <Field label="Address shown to bookers">
              <Input name="venueAddress" defaultValue={existing?.venueAddress ?? ""} />
            </Field>
            <Field label="Introduction" hint="Optional. A line or two at the top of the page.">
              <Input name="intro" defaultValue={existing?.intro ?? ""} />
            </Field>
          </fieldset>

          <fieldset className="space-y-4 border-t border-slate-200 pt-5 dark:border-slate-700">
            <legend className="text-sm font-semibold">What people book</legend>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Called a" hint="Court, Office, Class, Room.">
                <Input name="unitLabel" defaultValue={existing?.unitLabel ?? "Court"} required />
              </Field>
              <Field label="Several are" hint="Courts, Offices, Classes.">
                <Input name="unitLabelPlural" defaultValue={existing?.unitLabelPlural ?? "Courts"} />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Opens">
                <Input
                  name="opensAt"
                  type="time"
                  required
                  defaultValue={toTimeInput(existing?.opensAtMinute ?? 420)}
                />
              </Field>
              <Field label="Closes">
                <Input
                  name="closesAt"
                  type="time"
                  required
                  defaultValue={toTimeInput(existing?.closesAtMinute ?? 1380)}
                />
              </Field>
              <Field label="Slot length">
                <Select name="slotMinutes" defaultValue={String(existing?.slotMinutes ?? 60)}>
                  {[30, 45, 60, 90, 120].map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {minutes} minutes
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Days ahead" hint="How far into the future the page offers.">
              <Input
                name="horizonDays"
                type="number"
                min={1}
                max={90}
                defaultValue={existing?.horizonDays ?? 14}
              />
            </Field>
          </fieldset>

          <fieldset className="space-y-4 border-t border-slate-200 pt-5 dark:border-slate-700">
            <legend className="text-sm font-semibold">Payment</legend>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              No money moves through GAMIBOOK. The booker pays you however you ask, uploads proof,
              and somebody here confirms it.
            </p>

            <Field
              label="How to pay"
              hint="Shown to the booker once their slot is held. Bank details, wallet number, or 'pay at the desk'."
            >
              <textarea
                name="paymentInstructions"
                rows={4}
                defaultValue={existing?.paymentInstructions ?? ""}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
              />
            </Field>

            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                Payment QR
              </p>

              {existing?.paymentQrKey && existing.isPublished ? (
                <div className="mb-3 flex items-start gap-4">
                  {/* Served from the public route, which is what the booker
                      sees — so a broken image here is a broken image there. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/book/${existing.slug}/qr`}
                    alt="The payment QR shown to bookers"
                    className="size-28 rounded-md border border-slate-200 object-contain dark:border-slate-700"
                  />
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name="removeQr" className="mt-0.5 size-4 accent-brand-600" />
                    <span className="text-slate-600 dark:text-slate-400">
                      Remove this QR
                      <span className="block text-xs">
                        {existing.paymentQrName}
                      </span>
                    </span>
                  </label>
                </div>
              ) : existing?.paymentQrKey ? (
                <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                  A QR is saved. It appears here and on the booking page once the venue is
                  published.
                </p>
              ) : null}

              <input
                type="file"
                name="paymentQr"
                accept="image/png,image/jpeg,image/webp"
                className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white"
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                A screenshot of your GCash, Maya or bank QR. Shown to the booker beside the
                payment instructions. PNG, JPEG or WebP, up to 5 MB.{" "}
                {existing?.paymentQrKey ? "Choosing a file replaces the one above." : ""}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Hold for" hint="Minutes a slot is held before payment arrives.">
                <Input
                  name="holdMinutes"
                  type="number"
                  min={5}
                  max={1440}
                  defaultValue={existing?.holdMinutes ?? 120}
                />
              </Field>
              <Field label="Tell us at" hint={`Blank uses ${company.email ?? "the company email"}.`}>
                <Input name="notifyEmail" type="email" defaultValue={existing?.notifyEmail ?? ""} />
              </Field>
            </div>
          </fieldset>

          <Button type="submit">Save settings</Button>
        </form>
      </Card>
    </>
  );
}
