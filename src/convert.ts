import { parseAmount, parseBackpack, type Backpack } from "./parse.js";

export const CIDS_CONTEXT = "https://ontology.commonapproach.org/contexts/cidsContext.jsonld";
export const CFO_NAMESPACE = "https://ontology.commonapproach.org/cfo#";

export interface ConvertOptions {
  /** Base IRI for every minted @id. Defaults to the backpack `website`. */
  base?: string;
  /**
   * How a metric's `year` becomes a reporting period.
   * "fiscal" (default) uses `fiscal_year_end`; "calendar" is always Jan 1 – Dec 31.
   */
  yearBasis?: "fiscal" | "calendar";
  /** Emit revenue/expenses with the Common Form (cfo) vocabulary. Default true. */
  commonForm?: boolean;
  /**
   * "array" (default): a list of objects, each with its own @context, like
   * Common Approach's sample capsules. "graph": one @context plus @graph.
   */
  format?: "array" | "graph";
}

export interface Report {
  organization: string;
  /** What was converted, in plain language. */
  mapped: string[];
  /** Backpack content that has no place in the capsule (yet). */
  notCarried: string[];
  /** Things a person should look at before sharing the capsule. */
  warnings: string[];
  counts: { indicators: number; indicatorReports: number; financialYears: number };
}

export type JsonLdNode = Record<string, unknown>;
export type Capsule = JsonLdNode[] | { "@context": unknown; "@graph": JsonLdNode[] };

export interface ConvertResult {
  capsule: Capsule;
  report: Report;
}

/** Convert the text of a Digital Backpack `organization.md` into a CIDS capsule. */
export function convert(markdown: string, options: ConvertOptions = {}): ConvertResult {
  const bp = parseBackpack(markdown);
  const fm = bp.frontmatter;
  const mapped: string[] = [];
  const notCarried: string[] = [];
  const warnings: string[] = [];

  const name = str(fm.name);
  if (!name) throw new Error("The backpack has no `name` in its frontmatter; a CIDS Organization needs a legal name.");

  const website = str(fm.website);
  const ein = str(fm.ein);
  const base = resolveBase(options.base, website, ein, name, warnings);
  const id = (type: string, slugSource: string) => `${base}/${type}/${slug(slugSource)}`;

  const orgId = id("Organization", name);
  const org: JsonLdNode = { "@type": "cids:Organization", "@id": orgId, hasLegalName: name };
  const nodes: JsonLdNode[] = [org];
  mapped.push("name → Organization.hasLegalName");

  const mission = oneLine(bp.sections.get("mission"));
  if (mission) {
    org.hasPurpose = mission;
    mapped.push("Mission → Organization.hasPurpose");
    for (const note of bp.draftingNotes.get("mission") ?? []) {
      warnings.push(`Mission was carried over, but the backpack has a drafting note on it: "${truncate(note)}"`);
    }
  }
  if (website) {
    org.hasWebAddress = website;
    mapped.push("website → Organization.hasWebAddress");
  }
  if (ein) {
    const einId = id("OrganizationID", `ein${ein}`);
    org.hasID = einId;
    nodes.push({ "@type": "org:OrganizationID", "@id": einId, hasIdentifier: ein });
    mapped.push("ein → OrganizationID.hasIdentifier");
    warnings.push(
      "The EIN has no `issuedBy`: CIDS expects the issuer to be an Organization and there is no agreed IRI for the IRS yet.",
    );
  }

  // ---- Metrics → Indicator + IndicatorReport -------------------------------
  const yearBasis = options.yearBasis ?? "fiscal";
  const fiscalYearEnd = str(fm.fiscal_year_end);
  const indicators = new Map<string, JsonLdNode>();
  const reports: JsonLdNode[] = [];
  const periodsSeen = new Set<string>();

  for (const m of bp.metrics) {
    const indId = id("Indicator", m.metric);
    let ind = indicators.get(indId);
    if (!ind) {
      ind = { "@type": "cids:Indicator", "@id": indId, hasName: m.metric };
      if (m.methodology_note) ind.hasDescription = m.methodology_note;
      ind.unitDescription = m.unit || "unspecified";
      ind.forOrganization = orgId;
      ind.hasIndicatorReport = [];
      indicators.set(indId, ind);
      if (!m.unit) warnings.push(`Metric "${m.metric}" has no unit; wrote unitDescription "unspecified".`);
    }

    const value = numeric(m.value);
    if (value === undefined) {
      warnings.push(`Metric "${m.metric}": value ${JSON.stringify(m.value)} is not a number, so no report was written.`);
      continue;
    }
    if (!m.year) {
      warnings.push(`Metric "${m.metric}" has no year, so no dated report was written (Indicator only).`);
      continue;
    }
    const period = reportingPeriod(m.year, yearBasis === "fiscal" ? fiscalYearEnd : undefined);
    const label = period.isCalendar ? String(m.year) : `FY${m.year}`;
    periodsSeen.add(`${label} = ${period.startDate} to ${period.endDate}`);

    const repId = id("IndicatorReport", `${m.metric}${period.startDate}${period.endDate}`);
    if (reports.some((r) => r["@id"] === repId)) {
      warnings.push(`Metric "${m.metric}" appears twice for ${label}; kept the first value.`);
      continue;
    }
    reports.push({
      "@type": "cids:IndicatorReport",
      "@id": repId,
      hasName: `${name} - ${label} - ${m.metric}`,
      value: { "@type": "i72:Measure", hasNumericalValue: value },
      startedAtTime: `${period.startDate}T00:00:00Z`,
      endedAtTime: `${period.endDate}T23:59:59Z`,
      forIndicator: indId,
      forOrganization: orgId,
    });
    (ind.hasIndicatorReport as string[]).push(repId);
  }

  if (indicators.size) {
    org.hasIndicator = [...indicators.keys()];
    mapped.push(`${bp.metrics.length} metric(s) → ${indicators.size} Indicator(s) + ${reports.length} IndicatorReport(s)`);
    for (const p of periodsSeen) mapped.push(`reporting period ${p}`);
    if (yearBasis === "fiscal" && !fiscalYearEnd) {
      warnings.push("No `fiscal_year_end` in the backpack, so metric years were read as calendar years.");
    }
  } else {
    warnings.push("No metrics found, so the capsule has an Organization but no Indicators.");
  }
  for (const ind of indicators.values()) {
    if (!(ind.hasIndicatorReport as string[]).length) delete ind.hasIndicatorReport;
    nodes.push(ind);
  }
  nodes.push(...reports);

  // ---- Financials → Common Form (cfo) --------------------------------------
  let usesCfo = false;
  let financialYears = 0;
  const fin = bp.financials;
  const revenue = parseAmount(fin.revenue);
  const expenses = parseAmount(fin.expenses);
  const hasFinancials = Boolean(fin.revenue || fin.expenses);

  if (hasFinancials && options.commonForm === false) {
    notCarried.push("Financials (Common Form output is switched off)");
  } else if (hasFinancials) {
    if (fin.revenue && !revenue) warnings.push(`Could not read a dollar amount from Revenue: "${truncate(fin.revenue)}".`);
    if (fin.expenses && !expenses) warnings.push(`Could not read a dollar amount from Expenses: "${truncate(fin.expenses)}".`);
    if (!fin.fiscalYear) {
      warnings.push("Financials have no fiscal year, so they were not written.");
      notCarried.push("Financials (no fiscal year)");
    } else if (revenue || expenses) {
      const period = reportingPeriod(fin.fiscalYear, fiscalYearEnd);
      const finId = id("FinancialInformation", `fy${fin.fiscalYear}`);
      const figures: JsonLdNode = { "@type": "cfo:FinancialIndicators" };
      if (revenue) figures["cfo:hasTotalRevenues"] = decimal(revenue.value);
      if (expenses) figures["cfo:hasTotalExpenses"] = decimal(expenses.value);
      nodes.push({
        "@type": "cfo:FinancialInformation",
        "@id": finId,
        "cfo:forYear": { "@value": period.endDate, "@type": "xsd:date" },
        "cfo:hasFinancialIndicators": figures,
      });
      org["@type"] = ["cids:Organization", "cfo:Organization"];
      org["cfo:hasFinancialInformation"] = { "@id": finId };
      usesCfo = true;
      financialYears = 1;
      mapped.push(
        `Financials FY${fin.fiscalYear} → Common Form FinancialInformation (${[
          revenue && `revenue ${revenue.value}`,
          expenses && `expenses ${expenses.value}`,
        ]
          .filter(Boolean)
          .join(", ")})`,
      );
      if (revenue?.rounded || expenses?.rounded) {
        const examples = [revenue?.rounded && fin.revenue, expenses?.rounded && fin.expenses]
          .filter((t): t is string => Boolean(t))
          .map((t) => t.split(/\s/)[0]);
        warnings.push(
          `The backpack gives rounded financial figures (${examples.join(", ")}), so the capsule holds the rounded amounts.`,
        );
      }
      warnings.push("The Common Form (cfo) part cannot be validated: Common Approach has not published validation rules for it.");
    }
  }
  if (fin.netAssets) notCarried.push("Net assets (Common Form has total assets and total liabilities, not net assets)");

  // ---- Everything else is listed, not silently dropped ---------------------
  if (fm.hq) notCarried.push("hq (a Basic Tier Address needs a street address and postal code; the backpack has city/state only)");
  for (const key of ["ntee_code", "tax_status", "tax_exempt_since", "size_tier"]) {
    if (fm[key] != null) notCarried.push(`${key} (no matching Basic Tier field)`);
  }
  const prose: Array<[string, string]> = [
    ["theory of change", "Theory of change"],
    ["programs", "Programs (programs are Full Tier in CIDS)"],
    ["governance", "Governance"],
    ["data posture", "Data posture"],
    ["contact", "Contact"],
    ["what we're looking for", "What we're looking for"],
  ];
  for (const [key, label] of prose) {
    if (hasContent(bp.sections.get(key))) notCarried.push(label);
  }
  if (bp.suggestedMetrics.length) {
    warnings.push(
      `The backpack suggests ${bp.suggestedMetrics.length} more metric(s) with no data yet: ${bp.suggestedMetrics.join("; ")}.`,
    );
  }

  const context: unknown = usesCfo ? [CIDS_CONTEXT, { cfo: CFO_NAMESPACE }] : CIDS_CONTEXT;
  const capsule: Capsule =
    options.format === "graph"
      ? { "@context": context, "@graph": nodes }
      : nodes.map((n) => ({ "@context": context, ...n }));

  return {
    capsule,
    report: {
      organization: name,
      mapped,
      notCarried,
      warnings,
      counts: { indicators: indicators.size, indicatorReports: reports.length, financialYears },
    },
  };
}

/** Plain-text version of the report, for terminals and the web page. */
export function formatReport(report: Report): string {
  const lines: string[] = [`Capsule for ${report.organization}`];
  const block = (title: string, items: string[], mark: string) => {
    if (!items.length) return;
    lines.push("", title);
    for (const item of items) lines.push(`  ${mark} ${item}`);
  };
  block("Converted", report.mapped, "✔");
  block("Not carried over", report.notCarried, "–");
  block("Check before sharing", report.warnings, "!");
  return lines.join("\n");
}

// ---- helpers ---------------------------------------------------------------

function resolveBase(
  explicit: string | undefined,
  website: string | undefined,
  ein: string | undefined,
  name: string,
  warnings: string[],
): string {
  const pick = explicit ?? website;
  if (pick) return pick.replace(/\/+$/, "");
  const fallback = ein ? `urn:ein:${ein.replace(/\D/g, "")}` : `urn:backpack:${slug(name)}`;
  warnings.push(
    `The backpack has no website, so IDs were minted under "${fallback}". Pass a base IRI (--base https://…) to use the org's own domain.`,
  );
  return fallback;
}

/** Same ID style as Common Approach's sample capsules: lower-case letters and digits only. */
export function slug(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * The period a `year` stands for. With a fiscal year end of 06-30, 2024 means
 * 2023-07-01 to 2024-06-30 (US convention: a fiscal year is named for the year it ends in).
 */
export function reportingPeriod(
  year: number,
  fiscalYearEnd?: string,
): { startDate: string; endDate: string; isCalendar: boolean } {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(fiscalYearEnd ?? "");
  const month = m ? Number(m[1]) : 12;
  const day = m ? Number(m[2]) : 31;
  if (!m || month < 1 || month > 12 || day < 1 || day > 31 || (month === 12 && day === 31)) {
    return { startDate: `${year}-01-01`, endDate: `${year}-12-31`, isCalendar: true };
  }
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const lastOfMonth = (y: number) => new Date(Date.UTC(y, month, 0)).getUTCDate();
  // "02-28" means "end of February", including in leap years.
  const monthEnd = day >= new Date(Date.UTC(2001, month, 0)).getUTCDate();
  const end = new Date(Date.UTC(year, month - 1, monthEnd ? lastOfMonth(year) : day));
  const start = monthEnd
    ? new Date(Date.UTC(year - 1, month, 1))
    : new Date(Date.UTC(year - 1, month - 1, day + 1));
  return { startDate: iso(start), endDate: iso(end), isCalendar: false };
}

function numeric(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^-?\d[\d,]*(\.\d+)?$/.test(value.trim())) return value.trim().replace(/,/g, "");
  return undefined;
}

function decimal(value: string) {
  return { "@value": value, "@type": "xsd:decimal" };
}

function str(value: unknown): string | undefined {
  if (value == null) return undefined;
  const s = String(value).trim();
  return s || undefined;
}

function oneLine(text: string | undefined): string | undefined {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  return s || undefined;
}

/** True when a section still has real text after comments and empty bullets are removed. */
function hasContent(text: string | undefined): boolean {
  if (!text) return false;
  return text
    .split(/\r?\n/)
    .some((line) => line.replace(/^[-*#\s]*/, "").replace(/\*\*[^*]+\*\*\s*:?/g, "").trim().length > 0);
}

function truncate(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
