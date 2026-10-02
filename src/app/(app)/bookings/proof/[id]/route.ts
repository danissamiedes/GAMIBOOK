import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { storage, withStorage } from "@/lib/storage";

/**
 * The proof of payment a booker uploaded (SPEC §17).
 *
 * Served through the app rather than from a public bucket URL: the file is a
 * screenshot of somebody's bank account, and a link that works for anyone who
 * has it is the wrong shape for that. The scope check is what makes it private.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const scope = await sectionScope("BOOKINGS");
  const { id } = await params;

  const booking = await prisma.bookingGroup.findFirst({
    where: { id, ...scope.where },
    select: { paymentProofKey: true, paymentProofName: true },
  });
  if (!booking?.paymentProofKey) {
    return new Response("Not found", { status: 404 });
  }

  const bytes = await withStorage("get", () => storage().get(booking.paymentProofKey!));

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": contentTypeOf(booking.paymentProofName ?? booking.paymentProofKey),
      // inline: the admin wants to look at it, not collect a download.
      "content-disposition": `inline; filename="${(booking.paymentProofName ?? "proof").replace(/[^\w.\-]/g, "_")}"`,
      "cache-control": "private, no-store",
    },
  });
}

/**
 * Guessed from the extension, and deliberately a short allow-list.
 *
 * The filename came from a stranger with no account. Echoing whatever it
 * claims back as a Content-Type is how an uploaded "receipt" gets served as
 * HTML and runs in the admin's session.
 */
function contentTypeOf(name: string): string {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  if (extension === "pdf") return "application/pdf";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "heic") return "image/heic";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return "application/octet-stream";
}
