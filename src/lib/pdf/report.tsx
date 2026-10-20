import { createElement, type ReactElement } from "react";
import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
  type DocumentProps,
} from "@react-pdf/renderer";
import type { BrandingData } from "./types";

/**
 * Report PDFs (SPEC §12: "PDF export is added for all reports once the
 * renderer exists in Phase 7"). One landscape-agnostic table with a company
 * header block, driven by rows the report already computes for the screen.
 */

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 9, color: "#0f172a", fontFamily: "Helvetica" },
  companyName: { fontSize: 12, fontFamily: "Helvetica-Bold" },
  title: { fontSize: 16, fontFamily: "Helvetica-Bold", marginTop: 10 },
  subtitle: { color: "#64748b", marginBottom: 14 },
  headerRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#0f172a",
    paddingBottom: 4,
    marginBottom: 3,
  },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#e2e8f0", paddingVertical: 3 },
  totalRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: "#0f172a",
    paddingTop: 4,
    marginTop: 3,
    fontFamily: "Helvetica-Bold",
  },
  boldRow: { fontFamily: "Helvetica-Bold" },
  ruledRow: { borderTopWidth: 1, borderTopColor: "#0f172a" },
  label: { fontSize: 7, textTransform: "uppercase", color: "#64748b", letterSpacing: 0.5 },
  footer: { position: "absolute", left: 36, right: 36, bottom: 24, fontSize: 7, color: "#94a3b8" },
});

export type ReportPdfData = {
  title: string;
  subtitle: string;
  columns: { label: string; width?: number; align?: "left" | "right" }[];
  rows: string[][];
  totalRow?: string[];
  note?: string;
  /**
   * Turn the page on its side, for a report with a column per month. The
   * type is wound down to suit: thirteen columns of money do not fit across
   * A4 at the size a two-column report is set in, and a report that runs off
   * the edge of the paper is not an export.
   */
  landscape?: boolean;
  /** Rows that are a heading or a total, by index, set in bold. */
  boldRows?: number[];
  /** Rows to draw a rule above, by index — where a section ends. */
  ruledRows?: number[];
};

/**
 * Characters the built-in Helvetica cannot draw, and what to use instead.
 *
 * No font is registered, so the PDF is set in one of the fourteen standard
 * fonts — and anything outside their encoding is not drawn at all, silently.
 * A part-month heading came out as "OCT 1OCT 20, 2026" with its en dash
 * simply gone, and an account or customer named with a typographic
 * apostrophe would lose it the same way. Better a hyphen than a hole.
 */
const SUBSTITUTIONS: [RegExp, string][] = [
  [/[\u2010-\u2015]/g, "-"],
  [/[\u2018\u2019\u201b]/g, "'"],
  [/[\u201c\u201d\u201f]/g, '"'],
  [/\u2026/g, "..."],
  [/\u00a0/g, " "],
  [/[\u2007\u2009\u202f]/g, " "],
];

export function pdfSafe(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SUBSTITUTIONS) out = out.replace(pattern, replacement);
  // Anything still outside Latin-1 would be dropped without trace; a
  // question mark at least shows that something was there.
  return out.replace(/[^\u0000-\u00ff]/g, "?");
}

function cellStyle(column: { width?: number; align?: "left" | "right" }) {
  return column.width
    ? { width: column.width, textAlign: column.align ?? "left" as const }
    : { flex: 1, textAlign: column.align ?? "left" as const };
}

function ReportPdf({ branding, data }: { branding: BrandingData; data: ReportPdfData }) {
  // Enough columns and even a sideways page runs out: the type shrinks with
  // them, to a floor below which nobody could read it anyway.
  const fontSize = data.landscape
    ? data.columns.length > 14
      ? 6
      : data.columns.length > 10
        ? 7
        : 8
    : 9;
  const bold = new Set(data.boldRows ?? []);
  const ruled = new Set(data.ruledRows ?? []);

  return (
    <Document title={data.title} author={branding.companyName}>
      <Page
        size="A4"
        orientation={data.landscape ? "landscape" : "portrait"}
        style={[styles.page, { fontSize }]}
      >
        <Text style={styles.companyName}>{pdfSafe(branding.companyName)}</Text>
        <Text style={styles.title}>{pdfSafe(data.title)}</Text>
        <Text style={styles.subtitle}>{pdfSafe(data.subtitle)}</Text>

        <View style={styles.headerRow} fixed>
          {data.columns.map((column) => (
            <Text
              key={column.label}
              // The column heading must never be larger than the figures
              // under it, however far the type has been wound down.
              style={[cellStyle(column), styles.label, { fontSize: Math.min(7, fontSize) }]}
            >
              {pdfSafe(column.label)}
            </Text>
          ))}
        </View>

        {data.rows.map((row, rowIndex) => (
          <View
            key={rowIndex}
            style={[
              styles.row,
              bold.has(rowIndex) ? styles.boldRow : {},
              ruled.has(rowIndex) ? styles.ruledRow : {},
            ]}
            wrap={false}
          >
            {row.map((cell, cellIndex) => (
              <Text key={cellIndex} style={cellStyle(data.columns[cellIndex] ?? {})}>
                {pdfSafe(cell)}
              </Text>
            ))}
          </View>
        ))}

        {data.totalRow ? (
          <View style={styles.totalRow}>
            {data.totalRow.map((cell, cellIndex) => (
              <Text key={cellIndex} style={cellStyle(data.columns[cellIndex] ?? {})}>
                {pdfSafe(cell)}
              </Text>
            ))}
          </View>
        ) : null}

        {data.note ? (
          <Text style={{ marginTop: 12, color: "#64748b" }}>{pdfSafe(data.note)}</Text>
        ) : null}

        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
        />
      </Page>
    </Document>
  );
}

export async function renderReportPdf(
  branding: BrandingData,
  data: ReportPdfData,
): Promise<Buffer> {
  const element = createElement(ReportPdf, { branding, data }) as ReactElement<DocumentProps>;
  return renderToBuffer(element);
}
