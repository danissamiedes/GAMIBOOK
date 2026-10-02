import { prisma } from "@/lib/db";
import { storage, withStorage } from "@/lib/storage";

/**
 * The venue's payment QR, as a booker sees it (SPEC §17).
 *
 * Public, because the people who need it have no account — that is the whole
 * point of the booking page. It is also not a secret: it is the same code
 * printed on a sign at the counter.
 *
 * Only served for a published venue, so an unpublished one gives nothing away,
 * and only as an image: the Content-Type comes from a short allow-list rather
 * than from the uploaded filename.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const settings = await prisma.bookingSettings.findUnique({
    where: { slug },
    select: { isPublished: true, paymentQrKey: true, paymentQrName: true },
  });
  if (!settings?.isPublished || !settings.paymentQrKey) {
    return new Response("Not found", { status: 404 });
  }

  const bytes = await withStorage("get", () => storage().get(settings.paymentQrKey!));

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": imageTypeOf(settings.paymentQrName ?? settings.paymentQrKey),
      // Short, so a venue that swaps its QR is not fighting a week of caches,
      // but long enough that a busy page is not re-fetching it every render.
      "cache-control": "public, max-age=300",
    },
  });
}

/**
 * Images only, from the extension. Echoing whatever a filename claims is how
 * an uploaded "QR" gets served as HTML and runs on the booking page.
 */
function imageTypeOf(name: string): string {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return "application/octet-stream";
}
