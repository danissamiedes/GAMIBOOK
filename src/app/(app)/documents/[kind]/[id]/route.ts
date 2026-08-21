import { notFound } from "next/navigation";
import { sectionScope } from "@/lib/session-scope";
import { cachedPdf } from "@/lib/pdf/render";

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

  const pdf = await cachedPdf(scope.companyId, config.kind, id, { force });

  return new Response(new Uint8Array(pdf.bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${pdf.filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
