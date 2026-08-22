import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { ConfigurationError } from "@/lib/errors";
import { receiptBytes } from "@/lib/receipts/service";

/**
 * Serves a receipt photo through the app rather than from a public URL.
 *
 * The bucket is private on purpose — a receipt carries a vendor, an amount and
 * often a card's last four digits, and a guessable public link is a slow leak
 * of exactly that. Going through here means the section check applies to the
 * image the same way it applies to the row.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const scope = await sectionScope("VENDORS");

  const receipt = await prisma.receiptUpload.findFirst({
    where: { id, ...scope.where },
    select: { fileKey: true, mimeType: true, filename: true },
  });
  if (!receipt) notFound();

  let bytes;
  try {
    bytes = await receiptBytes(receipt);
  } catch (thrown) {
    if (thrown instanceof ConfigurationError) {
      return new Response(`This photo could not be loaded.\n\n${thrown.message}\n`, {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw thrown;
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": receipt.mimeType,
      "content-disposition": `inline; filename="${receipt.filename.replace(/[^\w.\-]/g, "_")}"`,
      "cache-control": "private, no-store",
    },
  });
}
