import { Document, Page, StyleSheet, Text, View, Image } from "@react-pdf/renderer";
import type { BrandingData, DocumentPdfData } from "./types";

/**
 * One template for all three documents (SPEC §11): invoice, work order and
 * payment receipt differ in their heading, fields and totals, not in their
 * shape. Branding sits at the top of each and the footer at the bottom.
 *
 * React-PDF rather than headless Chrome, deliberately: no browser to install
 * in the container, and it is the choice that keeps the Vercel path in SPEC
 * §13 open rather than requiring an external PDF service.
 */

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 9, color: "#0f172a", fontFamily: "Helvetica" },
  header: { flexDirection: "row", justifyContent: "space-between", marginBottom: 24 },
  logo: { width: 120, maxHeight: 48, objectFit: "contain", marginBottom: 6 },
  companyName: { fontSize: 13, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  muted: { color: "#64748b" },
  right: { textAlign: "right" },
  title: { fontSize: 20, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  draft: {
    marginTop: 4,
    alignSelf: "flex-end",
    borderWidth: 1,
    borderColor: "#b45309",
    color: "#b45309",
    paddingVertical: 2,
    paddingHorizontal: 6,
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
  },
  block: { marginBottom: 18, flexDirection: "row", justifyContent: "space-between" },
  label: { fontSize: 7, textTransform: "uppercase", color: "#64748b", marginBottom: 3, letterSpacing: 0.5 },
  fieldRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 2, minWidth: 190 },
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#0f172a",
    paddingBottom: 4,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#e2e8f0",
    paddingVertical: 4,
  },
  cellDescription: { flex: 1, paddingRight: 8 },
  cellNumber: { width: 70, textAlign: "right" },
  cellAmount: { width: 90, textAlign: "right" },
  totals: { marginTop: 10, alignSelf: "flex-end", minWidth: 220 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  totalStrong: {
    borderTopWidth: 1,
    borderTopColor: "#0f172a",
    marginTop: 3,
    paddingTop: 4,
    fontFamily: "Helvetica-Bold",
  },
  memo: { marginTop: 18 },
  notes: { marginTop: 10, color: "#64748b", fontSize: 8 },
  footer: {
    position: "absolute",
    left: 40,
    right: 40,
    bottom: 28,
    borderTopWidth: 0.5,
    borderTopColor: "#cbd5e1",
    paddingTop: 6,
    fontSize: 8,
    color: "#64748b",
  },
});

export function DocumentPdf({
  branding,
  data,
}: {
  branding: BrandingData;
  data: DocumentPdfData;
}) {
  return (
    <Document title={`${data.title} ${data.number}`} author={branding.companyName}>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View style={{ maxWidth: 260 }}>
            {/* react-pdf's Image is not an <img>: it takes no alt, and the
                lint rule cannot tell the difference. */}
            {branding.logoDataUri ? (
              // eslint-disable-next-line jsx-a11y/alt-text
              <Image src={branding.logoDataUri} style={styles.logo} />
            ) : null}
            <Text style={styles.companyName}>{branding.companyName}</Text>
            {branding.addressLines.map((line, index) => (
              <Text key={index} style={styles.muted}>
                {line}
              </Text>
            ))}
            {branding.email ? <Text style={styles.muted}>{branding.email}</Text> : null}
            {branding.phone ? <Text style={styles.muted}>{branding.phone}</Text> : null}
            {branding.taxNumber ? (
              <Text style={styles.muted}>Tax no. {branding.taxNumber}</Text>
            ) : null}
          </View>

          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.title}>{data.title}</Text>
            <Text style={styles.muted}>{data.number}</Text>
            {data.isDraft ? <Text style={styles.draft}>DRAFT — NOT YET ISSUED</Text> : null}
          </View>
        </View>

        <View style={styles.block}>
          <View style={{ maxWidth: 260 }}>
            <Text style={styles.label}>{data.partyLabel}</Text>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>{data.partyName}</Text>
            {data.partyAddressLines.map((line, index) => (
              <Text key={index} style={styles.muted}>
                {line}
              </Text>
            ))}
          </View>

          <View>
            {data.fields.map((field) => (
              <View key={field.label} style={styles.fieldRow}>
                <Text style={styles.muted}>{field.label}</Text>
                <Text>{field.value}</Text>
              </View>
            ))}
          </View>
        </View>

        {data.lines.length > 0 ? (
          <>
            <View style={styles.tableHeader}>
              <Text style={[styles.cellDescription, styles.label]}>Description</Text>
              <Text style={[styles.cellNumber, styles.label]}>Quantity</Text>
              <Text style={[styles.cellNumber, styles.label]}>Rate</Text>
              <Text style={[styles.cellAmount, styles.label]}>Amount</Text>
            </View>
            {data.lines.map((line, index) => (
              <View key={index} style={styles.row} wrap={false}>
                <Text style={styles.cellDescription}>{line.description}</Text>
                <Text style={styles.cellNumber}>{line.quantity}</Text>
                <Text style={styles.cellNumber}>{line.rate}</Text>
                <Text style={styles.cellAmount}>{line.amount}</Text>
              </View>
            ))}
          </>
        ) : null}

        <View style={styles.totals}>
          {data.totals.map((total) => (
            <View
              key={total.label}
              style={total.strong ? [styles.totalRow, styles.totalStrong] : styles.totalRow}
            >
              <Text>{total.label}</Text>
              <Text>{total.value}</Text>
            </View>
          ))}
        </View>

        {data.memo ? (
          <View style={styles.memo}>
            <Text style={styles.label}>Memo</Text>
            <Text>{data.memo}</Text>
          </View>
        ) : null}

        {data.notes.length > 0 ? (
          <View style={styles.notes}>
            {data.notes.map((note, index) => (
              <Text key={index}>{note}</Text>
            ))}
          </View>
        ) : null}

        {branding.footerText ? (
          <View style={styles.footer} fixed>
            <Text>{branding.footerText}</Text>
          </View>
        ) : null}
      </Page>
    </Document>
  );
}
