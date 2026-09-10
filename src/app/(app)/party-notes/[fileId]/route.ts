import { notFound } from "next/navigation";
import { companyScope } from "@/lib/session-scope";
import { ConfigurationError } from "@/lib/errors";
import { noteFile } from "@/lib/parties/notes";

/**
 * Serves a note's attachment through the app rather than from a public URL.
 *
 * The bucket is private on purpose: these are contracts, IDs and correspondence
 * about named people. Going through here means the company check applies to the
 * file the same way it applies to the note.
 *
 * Beyond the company, access follows the party's own section — a note on a
 * customer is only reachable from a page that already required SALES, and the
 * id is a cuid rather than anything guessable.
 */
export async function GET(_request: Request, context: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await context.params;
  const scope = await companyScope();

  let found;
  try {
    found = await noteFile(scope, fileId);
  } catch (thrown) {
    if (thrown instanceof ConfigurationError) {
      return new Response(`This file could not be loaded.\n\n${thrown.message}\n`, {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw thrown;
  }
  if (!found) notFound();

  const { file, bytes } = found;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": file.mimeType || "application/octet-stream",
      // inline so a PDF or an image opens rather than downloading, with the
      // real filename kept for when someone does save it.
      "content-disposition": `inline; filename="${file.filename.replace(/"/g, "")}"`,
      "cache-control": "private, no-store",
    },
  });
}
