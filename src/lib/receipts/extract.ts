import { z } from "zod";
import { ConfigurationError } from "@/lib/errors";

/**
 * Reading a receipt photo (SPEC §8.2 extension).
 *
 * What comes back is a *suggestion*, never a posting. Every field is optional
 * because a crumpled thermal receipt photographed at an angle genuinely does
 * not always yield a date, and a reader that invents one is worse than a
 * reader that admits it could not tell. Nothing here writes to the ledger —
 * a person approves the numbers first.
 */

export const ReceiptReading = z.object({
  date: z
    .string()
    .nullable()
    .describe("Transaction date as YYYY-MM-DD. Null if not legible."),
  total: z
    .string()
    .nullable()
    .describe(
      "The grand total actually paid, as a plain decimal like 1234.56. Not the subtotal, not the tax, not the cash tendered, not the change. Null if not legible.",
    ),
  currency: z
    .string()
    .nullable()
    .describe("ISO 4217 code such as PHP or USD, inferred from symbols or text. Null if unclear."),
  vendorName: z
    .string()
    .nullable()
    .describe("The merchant's name as printed. Null if not legible."),
  description: z
    .string()
    .nullable()
    .describe(
      "A short description for the books, six words or fewer, naming what was bought rather than repeating the merchant.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How much of the above you are sure of, 0 to 1. Be honest: a blurry photo scores low."),
  isReceipt: z
    .boolean()
    .describe("False if this image is not a receipt or invoice at all."),
});

export type ReceiptReading = z.infer<typeof ReceiptReading>;

const SYSTEM = [
  "You read photographs of receipts and invoices for a bookkeeping system.",
  "",
  "Return only what the image actually shows. A field you cannot read is null —",
  "never a guess, never today's date as a stand-in, never a rounded number.",
  "The books are wrong in a way nobody notices if you invent a plausible figure,",
  "and a null costs someone five seconds of typing.",
  "",
  "The total is the amount finally paid. Receipts routinely also print a",
  "subtotal, a tax line, the cash tendered and the change given; none of those",
  "is the total. Where a receipt shows an amount due and an amount paid and they",
  "differ, take the amount paid.",
].join("\n");

/**
 * Whether automatic reading is switched on for this deployment.
 *
 * The screen asks before it offers a Read button: a button whose only possible
 * outcome is an error is worse than no button, and a queue that keeps saying
 * "not read yet" reads as broken rather than as off.
 */
export function readerConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** How the image is handed to the reader. */
export type ReceiptImage = { bytes: Buffer; mimeType: string };

const SUPPORTED = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * Read one receipt. Throws `ConfigurationError` when the deployment has no API
 * key, so the caller can say which setting is missing rather than failing with
 * something about an undefined constructor.
 */
export async function readReceipt(image: ReceiptImage): Promise<ReceiptReading> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ConfigurationError(
      "Reading receipts automatically needs ANTHROPIC_API_KEY in the deployment's " +
        "settings. Without it the photos still upload and can be typed in by hand.",
    );
  }
  if (!SUPPORTED.has(image.mimeType)) {
    throw new ConfigurationError(
      `A ${image.mimeType} cannot be read. Upload a JPEG, PNG, GIF or WebP.`,
    );
  }

  // Imported lazily, like the S3 driver: a deployment that never reads a
  // receipt should not pay to load the SDK.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");

  const client = new Anthropic();
  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 8192,
    // Extraction from one image is not hard reasoning, and a receipt inbox is
    // a per-photo cost the user pays every day.
    output_config: { effort: "low", format: zodOutputFormat(ReceiptReading) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: image.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: image.bytes.toString("base64"),
            },
          },
          { type: "text", text: "Read this receipt." },
        ],
      },
    ],
  });

  const reading = response.parsed_output;
  if (!reading) {
    throw new Error("The reader returned nothing usable for this image");
  }
  return reading;
}
