import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { convert, parseAmount, parseBackpack, toBackpack } from "../dist/index.js";

const read = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const backpack = read("riverside-food-bank.md");
const capsule = JSON.parse(read("northside-kitchen.jsonld"));

test("backpack → capsule → backpack keeps every field the capsule can hold", () => {
  const original = parseBackpack(backpack);
  const { markdown } = toBackpack(convert(backpack).capsule);
  const back = parseBackpack(markdown);

  for (const key of ["name", "ein", "website", "fiscal_year_end"]) {
    assert.equal(back.frontmatter[key], original.frontmatter[key], key);
  }
  assert.equal(back.sections.get("mission").replace(/\s+/g, " "), original.sections.get("mission").replace(/\s+/g, " "));
  assert.deepEqual(back.metrics, original.metrics);
  assert.equal(back.financials.fiscalYear, original.financials.fiscalYear);
  assert.equal(parseAmount(back.financials.revenue).value, parseAmount(original.financials.revenue).value);
  assert.equal(parseAmount(back.financials.expenses).value, parseAmount(original.financials.expenses).value);
});

test("capsule → backpack → capsule gives the same capsule", () => {
  const first = convert(backpack).capsule;
  const second = convert(toBackpack(first).markdown).capsule;
  assert.deepEqual(second, first);
});

test("a capsule becomes a draft backpack", () => {
  const { markdown, report } = toBackpack(capsule);
  const bp = parseBackpack(markdown);

  // The organization that owns the indicators is chosen, not the funder placeholder.
  assert.equal(bp.frontmatter.name, "Northside Community Kitchen");
  assert.deepEqual(bp.frontmatter.hq, { city: "Hamilton", state: "ON", country: "Canada" });
  // A Canadian business number is not an EIN, and an @id is not a website.
  assert.equal(bp.frontmatter.ein, undefined);
  assert.equal(bp.frontmatter.website, undefined);
  assert.ok(report.notCarried.some((n) => n.includes("BN000000000")));

  // One metric per IndicatorReport, newest year first.
  assert.equal(bp.metrics.length, 3);
  assert.equal(report.counts.indicatorReports, 3);
  assert.deepEqual(
    bp.metrics.map((m) => [m.metric, m.value, m.unit, m.year]),
    [
      ["Meals served", 21400, "meals", 2025],
      ["Meals served", 18250, "meals", 2024],
      ["Training graduates", 14, "people", 2025],
    ],
  );
  // The year is the date as written, whatever the time zone offset.
  assert.match(bp.metrics[0].methodology_note, /counted daily\. Comment: Includes the new Saturday service\./);
  // A part-year period keeps its exact dates in the note.
  assert.match(bp.metrics[2].methodology_note, /Reporting period: 2025-03-01 to 2025-06-30\./);
  // An indicator with no reports is listed as a metric with no data yet.
  assert.deepEqual(bp.suggestedMetrics, ["Volunteer hours"]);
});

test("placeholders, notes and unsafe text", () => {
  const { markdown, report } = toBackpack(capsule);
  const bp = parseBackpack(markdown);
  // Mission comes from the description, flagged for the org to confirm.
  assert.match(bp.sections.get("mission"), /^A made-up community kitchen: we cook/);
  assert.ok(bp.draftingNotes.get("mission")[0].includes("org should confirm"));
  assert.ok(report.warnings.some((w) => w.includes("Mission was filled")));
  // "-->" in capsule text must not close a comment or lose the rest of the section.
  assert.match(bp.sections.get("mission").replace(/\s+/g, " "), /and share meals\. Motto: "eat well: together"\.$/);
  // Sections a capsule cannot fill are placeholders, which parse as empty.
  for (const section of ["programs", "governance", "data posture", "what we're looking for"]) {
    assert.equal(bp.sections.get(section), "", section);
  }
  // Outcomes survive as comments only.
  assert.ok(markdown.includes("# Outcome: Improve food security"));
  assert.ok(bp.draftingNotes.get("theory of change")[0].includes("Build kitchen skills"));
  assert.match(bp.sections.get("contact"), /primary contact \(Sample Contact\): <hello@northsidekitchen\.example>/);
});

test("same capsule gives the same markdown, and last_updated is opt-in", () => {
  assert.equal(toBackpack(capsule).markdown, toBackpack(capsule).markdown);
  assert.ok(!toBackpack(capsule).markdown.includes("last_updated"));
  assert.equal(parseBackpack(toBackpack(capsule, { today: "2026-11-13" }).markdown).frontmatter.last_updated, "2026-11-13");
});

test("accepts @graph and picks an organization by name", () => {
  const graph = { "@context": "https://ontology.commonapproach.org/contexts/cidsContext.jsonld", "@graph": capsule };
  assert.equal(toBackpack(graph).markdown, toBackpack(capsule).markdown);
  const funder = toBackpack(capsule, { organization: "a made-up funder" });
  assert.equal(parseBackpack(funder.markdown).frontmatter.name, "A Made-up Funder");
  assert.equal(parseBackpack(funder.markdown).metrics.length, 0);
});

test("several organizations with data need a choice", () => {
  const two = [
    ...capsule,
    { "@type": "cids:Organization", "@id": "https://other.example/Organization/other", hasLegalName: "Other Org", hasIndicator: ["https://other.example/Indicator/x"] },
  ];
  assert.throws(() => toBackpack(two), /holds 2 organizations with data[\s\S]*Other Org/);
  assert.equal(parseBackpack(toBackpack(two, { organization: "Other Org" }).markdown).frontmatter.name, "Other Org");
});

test("awkward text stays valid YAML and markdown", () => {
  const tricky = [
    { "@type": "cids:Organization", "@id": "urn:x:org", hasLegalName: "Org: with #colon & \"quotes\"", hasPurpose: "## not a heading\n<!-- not a comment -->" },
    {
      "@type": "cids:Indicator",
      "@id": "urn:x:ind",
      hasName: "rate: yes/no ``` fence",
      hasDescription: "# starts with hash, has ``` fence and --> arrow",
      unitDescription: "100",
      forOrganization: "urn:x:org",
    },
    {
      "@type": "cids:IndicatorReport",
      "@id": "urn:x:rep",
      forIndicator: "urn:x:ind",
      value: { "@type": "i72:Measure", hasNumericalValue: "Gender equality" },
      startedAtTime: "2024-03-01T00:00:00",
      endedAtTime: "2025-01-01T00:00:00",
    },
  ];
  const { markdown, report } = toBackpack(tricky);
  const bp = parseBackpack(markdown);
  assert.equal(bp.frontmatter.name, 'Org: with #colon & "quotes"');
  assert.match(bp.sections.get("mission"), /not a heading/);
  assert.equal(bp.sections.has("not a heading"), false);
  assert.equal(bp.metrics.length, 1);
  assert.equal(bp.metrics[0].metric, "rate: yes/no ''' fence");
  assert.equal(bp.metrics[0].unit, "100");
  assert.equal(bp.metrics[0].value, "Gender equality");
  // A period ending on 1 January belongs to the year before.
  assert.equal(bp.metrics[0].year, 2024);
  assert.ok(report.warnings.some((w) => w.includes("text, not numbers")));
});

test("a heading marker in the middle of long text cannot start a new section", () => {
  // Long enough that wrapping puts "## Governance" at the start of a line.
  const purpose = `${"word ".repeat(15)}abc ## Governance is not a heading here`;
  const { markdown } = toBackpack([{ "@type": "cids:Organization", "@id": "urn:x:org", hasLegalName: "Org", hasPurpose: purpose }]);
  assert.ok(markdown.split("\n").includes("\\## Governance is not a heading here"));
  const bp = parseBackpack(markdown);
  assert.match(bp.sections.get("mission"), /Governance is not a heading here/);
  assert.equal(bp.sections.get("governance"), "");
});
