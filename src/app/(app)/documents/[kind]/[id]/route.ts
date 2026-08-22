import { notFound } from "next/navigation";
import { sectionScope } from "@/lib/session-scope";
import { cachedPdf } from "@/lib/pdf/render";
import { ConfigurationError } from "@/lib/errors";

/**
 * PDF download for a document (SPEC §11). Scoped by section, so a vendors-only
 * user cannot pull an invoice PDF by guessing its id.
 */
const KINDS = {
  invoice: { section: "SALES" as const, kind: "invoice" as const },
  "work-order": { section: "CONSULTANTS" as const, kind: "work-order" as const },
  receipt: { section: "SALES" as const, kind: "receipt" as const },
};

export async function GET(
  request: Request,
  context: { params: Promise<{ kind: string; id: string }> },
) {
  const { kind, id } = await context.params;
  const config = KINDS[kind as keyof typeof KINDS];
  if (!config) notFound();

  const scope = await sectionScope(config.section);
  const force = new URL(request.url).searchParams.get("refresh") === "1";

  let pdf;
  try {
    pdf = await cachedPdf(scope.companyId, config.kind, id, { force });
  } catch (thrown) {
    // A misconfigured deployment is the operator's to fix, and the message says
    // which setting. Letting it become a bare 500 sends someone to the server
    // log to learn something the app already knew.
    if (thrown instanceof ConfigurationError) {
      return new Response(`This document could not be produced.\n\n${thrown.message}\n`, {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw thrown;
  }

  return new Response(new Uint8Array(pdf.bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${pdf.filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
