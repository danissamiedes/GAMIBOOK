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
};

function cellStyle(column: { width?: number; align?: "left" | "right" }) {
  return column.width
    ? { width: column.width, textAlign: column.align ?? "left" as const }
    : { flex: 1, textAlign: column.align ?? "left" as const };
}

function ReportPdf({ branding, data }: { branding: BrandingData; data: ReportPdfData }) {
  return (
    <Document title={data.title} author={branding.companyName}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.companyName}>{branding.companyName}</Text>
        <Text style={styles.title}>{data.title}</Text>
        <Text style={styles.subtitle}>{data.subtitle}</Text>

        <View style={styles.headerRow} fixed>
          {data.columns.map((column) => (
            <Text key={column.label} style={[cellStyle(column), styles.label]}>
              {column.label}
            </Text>
          ))}
        </View>

        {data.rows.map((row, rowIndex) => (
          <View key={rowIndex} style={styles.row} wrap={false}>
            {row.map((cell, cellIndex) => (
              <Text key={cellIndex} style={cellStyle(data.columns[cellIndex] ?? {})}>
                {cell}
              </Text>
            ))}
          </View>
        ))}

        {data.totalRow ? (
          <View style={styles.totalRow}>
            {data.totalRow.map((cell, cellIndex) => (
              <Text key={cellIndex} style={cellStyle(data.columns[cellIndex] ?? {})}>
                {cell}
              </Text>
            ))}
          </View>
        ) : null}

        {data.note ? <Text style={{ marginTop: 12, color: "#64748b" }}>{data.note}</Text> : null}

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
