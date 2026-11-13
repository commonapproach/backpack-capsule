import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { convert, parseAmount, reportingPeriod } from "../dist/index.js";
import { validateBasicTier } from "../dist/validate.js";

const fixture = readFileSync(new URL("./fixtures/riverside-food-bank.md", import.meta.url), "utf8");
const byType = (capsule, type) => capsule.filter((n) => [n["@type"]].flat().includes(type));

test("organization fields carry over", () => {
  const { capsule } = convert(fixture);
  const [org] = byType(capsule, "cids:Organization");
  assert.equal(org["@id"], "https://rfb.example.org/Organization/riversidefoodbank");
  assert.equal(org.hasLegalName, "Riverside Food Bank");
  assert.equal(org.hasWebAddress, "https://rfb.example.org");
  assert.match(org.hasPurpose, /^End hunger in the Miami Valley/);
  const [ein] = byType(capsule, "org:OrganizationID");
  assert.equal(ein.hasIdentifier, "12-3456789");
  assert.equal(org.hasID, ein["@id"]);
});

test("metrics become indicators and dated reports", () => {
  const { capsule, report } = convert(fixture);
  const indicators = byType(capsule, "cids:Indicator");
  const reports = byType(capsule, "cids:IndicatorReport");
  // "meals distributed" appears for two years: one Indicator, two reports.
  assert.equal(indicators.length, 2);
  assert.equal(reports.length, 3);
  assert.deepEqual(report.counts, { indicators: 2, indicatorReports: 3, financialYears: 1 });

  const fy24 = reports.find((r) => r.hasName === "Riverside Food Bank - FY2024 - meals distributed");
  assert.equal(fy24.value.hasNumericalValue, "48000");
  // fiscal_year_end is 06-30, so FY2024 runs July 2023 to June 2024.
  assert.equal(fy24.startedAtTime, "2023-07-01T00:00:00Z");
  assert.equal(fy24.endedAtTime, "2024-06-30T23:59:59Z");

  const meals = indicators.find((i) => i.hasName === "meals distributed");
  assert.equal(meals.unitDescription, "meals");
  assert.equal(meals.hasIndicatorReport.length, 2);
});

test("calendar-year option", () => {
  const { capsule } = convert(fixture, { yearBasis: "calendar" });
  const r = byType(capsule, "cids:IndicatorReport").find((x) => x.hasName.includes("2024 - households"));
  assert.equal(r.startedAtTime, "2024-01-01T00:00:00Z");
  assert.equal(r.endedAtTime, "2024-12-31T23:59:59Z");
});

test("financials use the Common Form vocabulary", () => {
  const { capsule } = convert(fixture);
  const [fin] = byType(capsule, "cfo:FinancialInformation");
  assert.deepEqual(fin["cfo:forYear"], { "@value": "2024-06-30", "@type": "xsd:date" });
  const figures = fin["cfo:hasFinancialIndicators"];
  assert.deepEqual(figures["cfo:hasTotalRevenues"], { "@value": "1250000", "@type": "xsd:decimal" });
  assert.deepEqual(figures["cfo:hasTotalExpenses"], { "@value": "1180400", "@type": "xsd:decimal" });

  const cidsOnly = convert(fixture, { commonForm: false }).capsule;
  assert.equal(byType(cidsOnly, "cfo:FinancialInformation").length, 0);
  assert.ok(!JSON.stringify(cidsOnly).includes("cfo"));
});

test("placeholders and comments never reach the capsule", () => {
  const { capsule, report } = convert(fixture);
  const text = JSON.stringify(capsule);
  assert.ok(!text.includes("Org to complete"));
  assert.ok(!text.includes("Made-up organization"));
  // Sections that are only placeholders are not reported as lost content.
  assert.ok(!report.notCarried.includes("What we're looking for"));
  assert.ok(report.notCarried.includes("Governance"));
});

test("same input gives the same IDs", () => {
  assert.deepEqual(convert(fixture).capsule, convert(fixture).capsule);
});

test("no website falls back to an EIN-based base and says so", () => {
  const { capsule, report } = convert(fixture.replace(/^website:.*\n/m, ""));
  assert.ok(capsule[0]["@id"].startsWith("urn:ein:123456789/"));
  assert.ok(report.warnings.some((w) => w.includes("no website")));
});

test("graph format", () => {
  const { capsule } = convert(fixture, { format: "graph" });
  assert.ok(Array.isArray(capsule["@graph"]));
});

test("parseAmount", () => {
  assert.deepEqual(parseAmount("$699,731 (contributions 96.3%)"), { value: "699731", rounded: false });
  assert.deepEqual(parseAmount("$91.1M (contributions 93%)"), { value: "91100000", rounded: true });
  assert.deepEqual(parseAmount("$116M"), { value: "116000000", rounded: true });
  assert.deepEqual(parseAmount("$640K"), { value: "640000", rounded: true });
  assert.equal(parseAmount("about two million"), undefined);
});

test("reportingPeriod", () => {
  assert.deepEqual(reportingPeriod(2024, "12-31"), { startDate: "2024-01-01", endDate: "2024-12-31", isCalendar: true });
  assert.deepEqual(reportingPeriod(2024, "06-30"), { startDate: "2023-07-01", endDate: "2024-06-30", isCalendar: false });
  // A February year end follows leap years.
  assert.deepEqual(reportingPeriod(2024, "02-28"), { startDate: "2023-03-01", endDate: "2024-02-29", isCalendar: false });
});

test("the fixture capsule passes CIDS Basic Tier validation", async () => {
  const result = await validateBasicTier(convert(fixture).capsule);
  assert.ok(result.triples > 20, "the capsule should produce RDF statements");
  assert.deepEqual(result.issues.filter((i) => i.severity === "Violation"), []);
  assert.equal(result.conforms, true);
});

test("validation really catches a broken capsule", async () => {
  const { capsule } = convert(fixture);
  const broken = capsule.map((n) => {
    if (n["@type"] !== "cids:IndicatorReport") return n;
    const { startedAtTime, ...rest } = n;
    return rest;
  });
  const result = await validateBasicTier(broken);
  assert.equal(result.conforms, false);
  assert.ok(result.issues.some((i) => i.path.endsWith("startedAtTime")));
});
