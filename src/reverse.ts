import { stringify } from "yaml";
import { reportingPeriod, type Report } from "./convert.js";

export interface ToBackpackOptions {
  /** Which organization to write, by @id or legal name. Needed when a capsule holds several. */
  organization?: string;
  /** Value for `last_updated` (YYYY-MM-DD). Left out when not given, so output is repeatable. */
  today?: string;
}

export interface ToBackpackResult {
  /** A draft organization.md. Sections the capsule has no data for are left as placeholders. */
  markdown: string;
  report: Report;
}

type Node = Record<string, unknown>;

const PLACEHOLDER = "<!-- Org to complete -->";

/**
 * Convert a CIDS capsule (parsed JSON-LD) into a draft Digital Backpack organization.md.
 * Reads the compacted form Common Approach tools write: a list of objects or an
 * `@graph`, with plain or prefixed keys (`hasName`, `cids:hasName`).
 */
export function toBackpack(capsule: unknown, options: ToBackpackOptions = {}): ToBackpackResult {
  const nodes = flatten(capsule);
  if (!nodes.length) throw new Error("The capsule is empty: expected a list of objects or an object with @graph.");

  const byId = new Map<string, Node>();
  for (const n of nodes) if (typeof n["@id"] === "string") byId.set(n["@id"], n);
  /** Follow a link (an IRI, an {"@id"} object, or an embedded object) to the full object. */
  const resolve = (v: unknown): Node | undefined => {
    if (typeof v === "string") return byId.get(v);
    if (isNode(v)) {
      const id = v["@id"];
      if (Object.keys(v).some((k) => !k.startsWith("@"))) return v;
      return typeof id === "string" ? byId.get(id) : undefined;
    }
    return undefined;
  };
  const resolveAll = (v: unknown): Node[] => asArray(v).map(resolve).filter((n): n is Node => Boolean(n));
  const ofType = (name: string) => nodes.filter((n) => isType(n, name));

  const mapped: string[] = [];
  const notCarried: string[] = [];
  const warnings: string[] = [];
  const used = new Set<Node>();

  // ---- Which organization? -------------------------------------------------
  const allIndicators = ofType("Indicator");
  const allReports = ofType("IndicatorReport");
  const orgs = ofType("Organization");
  const org = pickOrganization(orgs, allIndicators, allReports, options.organization);
  const orgId = idOf(org);
  used.add(org);
  const name = text(get(org, "hasLegalName")) ?? text(get(org, "hasName"));
  if (!name) throw new Error("The organization in the capsule has no legal name, and a backpack needs a `name`.");
  mapped.push("Organization.hasLegalName → name");
  const others = orgs.filter((o) => o !== org);
  if (others.length) {
    notCarried.push(
      `${others.length} other organization(s) in the capsule: ${others.map((o) => text(get(o, "hasLegalName")) ?? idOf(o)).join("; ")}`,
    );
    for (const o of others) used.add(o);
  }
  const belongsToOrg = (n: Node) => {
    const owners = refs(get(n, "forOrganization"));
    return owners.length ? owners.includes(orgId ?? "") : orgs.length === 1;
  };

  // ---- Frontmatter ---------------------------------------------------------
  const front: string[] = ['schema_version: "0.1"', `name: ${yaml(name)}`];

  const idNodes = unique([
    ...resolveAll(get(org, "hasID")),
    ...nodes.filter((n) => isType(n, "OrganizationID") && refs(get(n, "forOrganization")).includes(orgId ?? "")),
  ]);
  let hasEin = false;
  for (const idNode of idNodes) {
    used.add(idNode);
    const identifier = text(get(idNode, "hasIdentifier"));
    if (!identifier) continue;
    const ein = asEin(identifier, `${idOf(idNode) ?? ""} ${refs(get(idNode, "issuedBy")).join(" ")}`);
    if (ein && !hasEin) {
      front.push(`ein: "${ein}"`);
      mapped.push("OrganizationID.hasIdentifier → ein");
      hasEin = true;
    } else {
      front.push(`# ein: the capsule has the identifier ${oneLine(identifier)}, which is not a US EIN`);
      notCarried.push(`Organization identifier ${oneLine(identifier)} (not a US EIN; the backpack has no field for other identifiers)`);
    }
  }
  if (!hasEin && !idNodes.length) warnings.push("The capsule has no organization identifier, so `ein` is missing.");

  // Collected below, written here: the fiscal year end is inferred from periods.
  const fiscalYearEndSlot = front.length;

  const website = text(get(org, "hasWebAddress"));
  if (website) {
    front.push(`website: ${yaml(website)}`);
    mapped.push("Organization.hasWebAddress → website");
  } else {
    warnings.push("The capsule has no website for the organization (IDs are not treated as a website).");
  }

  const address = resolveAll(get(org, "hasAddress"))[0];
  if (address) {
    used.add(address);
    const hq = [
      ["city", text(get(address, "addressLocality"))],
      ["state", text(get(address, "addressRegion"))],
      ["country", text(get(address, "addressCountry"))],
    ].filter(([, v]) => v);
    if (hq.length) {
      front.push("hq:", ...hq.map(([k, v]) => `  ${k}: ${yaml(v as string)}`));
      mapped.push("Address → hq (city, state, country)");
      if (get(address, "streetAddress") || get(address, "postalCode")) {
        notCarried.push("Street address and postal code (the backpack `hq` holds city, state and country only)");
      }
    }
  }
  if (options.today) front.push(`last_updated: ${options.today}`);

  // ---- Mission -------------------------------------------------------------
  let mission = PLACEHOLDER;
  const purpose = text(get(org, "hasPurpose"));
  const description = text(get(org, "hasDescription"));
  if (purpose) {
    mission = prose(purpose);
    mapped.push("Organization.hasPurpose → Mission");
  } else if (description) {
    mission = `<!-- Taken from the organization's description in the capsule; org should confirm or replace. -->\n${prose(description)}`;
    mapped.push("Organization.hasDescription → Mission (marked for the org to confirm)");
    warnings.push("The capsule has no mission (hasPurpose), so Mission was filled from the organization's description. Check it reads as a mission.");
  }

  // ---- Indicators and reports → metrics -------------------------------------
  const indicators = unique([
    ...resolveAll(get(org, "hasIndicator")).filter((n) => isType(n, "Indicator")),
    ...allIndicators.filter((n) => refs(get(n, "forOrganization")).includes(orgId ?? "")),
    ...(orgs.length === 1 ? allIndicators : []),
  ]);
  indicators.sort((a, b) => nodes.indexOf(a) - nodes.indexOf(b));

  const outcomes = ofType("Outcome").filter(belongsToOrg);
  const outcomeOf = (ind: Node): Node | undefined =>
    resolveAll(get(ind, "forOutcome")).find((o) => isType(o, "Outcome")) ??
    outcomes.find((o) => refs(get(o, "hasIndicator")).includes(idOf(ind) ?? ""));

  interface Metric {
    metric: string;
    value: string;
    unit?: string;
    year?: number;
    note?: string;
  }
  const groups = new Map<Node | undefined, { metrics: Metric[]; noData: string[] }>();
  const fiscalYearEnds = new Set<string>();
  let reportCount = 0;
  let oddPeriods = 0;
  let textValues = 0;
  const seenPairs = new Set<string>();
  let duplicatePairs = 0;

  for (const ind of indicators) {
    used.add(ind);
    const metricName = oneLine(text(get(ind, "hasName")) ?? idOf(ind) ?? "unnamed indicator");
    const outcome = outcomeOf(ind);
    let group = groups.get(outcome);
    if (!group) groups.set(outcome, (group = { metrics: [], noData: [] }));

    const reports = unique([
      ...resolveAll(get(ind, "hasIndicatorReport")).filter((n) => isType(n, "IndicatorReport")),
      ...allReports.filter((r) => refs(get(r, "forIndicator")).includes(idOf(ind) ?? "")),
    ]);
    const rows = reports.map((r) => ({ r, period: readPeriod(r) }));
    // Newest year first; reports with no date go last.
    rows.sort((a, b) => (b.period.end ?? "").localeCompare(a.period.end ?? ""));

    let written = 0;
    for (const { r, period } of rows) if (writeMetric(group, r, period, metricName, ind)) written++;
    if (!written) group.noData.push(metricName);
  }

  // Reports that point to no indicator still hold real results: use their own name.
  const orphans = allReports.filter(
    (r) => !used.has(r) && belongsToOrg(r) && !resolveAll(get(r, "forIndicator")).some((n) => isType(n, "Indicator")),
  );
  if (orphans.length) {
    let group = groups.get(undefined);
    if (!group) groups.set(undefined, (group = { metrics: [], noData: [] }));
    const rows = orphans.map((r) => ({ r, period: readPeriod(r), name: oneLine(text(get(r, "hasName")) ?? idOf(r) ?? "unnamed report") }));
    rows.sort((a, b) => a.name.localeCompare(b.name) || (b.period.end ?? "").localeCompare(a.period.end ?? ""));
    let kept = 0;
    for (const { r, period, name: reportName } of rows) if (writeMetric(group, r, period, reportName)) kept++;
    if (kept) warnings.push(`${kept} report(s) are not linked to an indicator in the capsule, so the report's own name was used as the metric name.`);
  }

  function writeMetric(
    group: { metrics: Metric[]; noData: string[] },
    r: Node,
    period: ReturnType<typeof readPeriod>,
    metricName: string,
    ind?: Node,
  ): boolean {
    used.add(r);
    const measure = resolve(get(r, "value"));
    const value = text(measure ? get(measure, "hasNumericalValue") : get(r, "value"));
    if (value === undefined) {
      warnings.push(`Report "${oneLine(text(get(r, "hasName")) ?? idOf(r) ?? metricName)}" has no value, so it was left out.`);
      return false;
    }
    if (!isNumber(value)) textValues++;
    if (period.fiscalYearEnd) fiscalYearEnds.add(period.fiscalYearEnd);
    if (period.note) oddPeriods++;
    if (period.year === undefined) warnings.push(`Report for "${metricName}" has no end date, so its metric has no year.`);
    const pair = `${ind ? idOf(ind) : metricName}|${period.year}`;
    if (seenPairs.has(pair)) duplicatePairs++;
    seenPairs.add(pair);

    const unit = (ind && text(get(ind, "unitDescription"))) ?? unitLabel(measure, resolve);
    const reportComment = text(get(r, "hasComment"));
    const note = [ind && text(get(ind, "hasDescription")), reportComment && `Comment: ${reportComment}`, period.note]
      .filter((part): part is string => Boolean(part))
      .map((part) => oneLine(part))
      // Only add full stops between parts, so a lone description is copied unchanged.
      .map((part, i, all) => (i < all.length - 1 ? sentence(part) : part))
      .join(" ");
    group.metrics.push({ metric: metricName, value, unit: unit && oneLine(unit), year: period.year, note: note || undefined });
    reportCount++;
    return true;
  }

  const metricTotal = [...groups.values()].reduce((n, g) => n + g.metrics.length, 0);
  if (metricTotal) {
    mapped.push(`${indicators.length} Indicator(s) + ${reportCount} IndicatorReport(s) → ${metricTotal} metric(s)`);
  } else {
    warnings.push("The capsule has no indicator reports for this organization, so the Metrics section is empty.");
  }
  if (oddPeriods) {
    warnings.push(
      `${oddPeriods} report(s) cover a period that is not one full year. A backpack metric only has a year, so the exact period was added to the methodology note.`,
    );
  }
  if (textValues) warnings.push(`${textValues} report value(s) are text, not numbers; they were copied as text.`);
  if (duplicatePairs) {
    warnings.push(`${duplicatePairs} metric(s) have more than one report for the same year; all were written, so check them.`);
  }
  const usedOutcomes = outcomes.filter((o) => groups.has(o) || belongsToOrg(o));
  for (const o of usedOutcomes) used.add(o);
  if (usedOutcomes.length) {
    notCarried.push(
      `${usedOutcomes.length} Outcome(s): the backpack has no outcome field, so they appear only as comments (in Theory of change and above each group of metrics)`,
    );
  }

  // ---- Common Form financials ----------------------------------------------
  const financialNodes = unique([
    ...resolveAll(get(org, "hasFinancialInformation")),
    ...(orgs.length === 1 ? ofType("FinancialInformation") : []),
  ]);
  const financials = financialNodes
    .map((f) => {
      used.add(f);
      const date = datePart(text(get(f, "forYear")));
      const figures = resolve(get(f, "hasFinancialIndicators"));
      if (figures) used.add(figures);
      return {
        date,
        revenue: figures && text(get(figures, "hasTotalRevenues")),
        expenses: figures && text(get(figures, "hasTotalExpenses")),
        extra: figures ? Object.keys(figures).filter((k) => !k.startsWith("@") && !/hasTotal(Revenues|Expenses)$/.test(k)) : [],
      };
    })
    .filter((f) => f.date)
    .sort((a, b) => (b.date as string).localeCompare(a.date as string));

  let financialSection = PLACEHOLDER;
  if (financials.length) {
    const latest = financials[0];
    const date = latest.date as string;
    fiscalYearEnds.add(date.slice(5));
    const lines = [`- **Fiscal year**: ${date.slice(0, 4)}`];
    if (latest.revenue && isNumber(latest.revenue)) lines.push(`- **Revenue**: ${money(latest.revenue)}`);
    if (latest.expenses && isNumber(latest.expenses)) lines.push(`- **Expenses**: ${money(latest.expenses)}`);
    financialSection = lines.join("\n");
    mapped.push(`Common Form FinancialInformation ${date.slice(0, 4)} → Financials`);
    if (financials.length > 1) notCarried.push(`${financials.length - 1} earlier financial year(s) (a backpack holds one)`);
    if (latest.extra.length) notCarried.push(`Other financial figures: ${latest.extra.map(shortKey).join(", ")}`);
  }

  // A fiscal year end is only written when the capsule gives real evidence for it:
  // a financial year, or impact periods that are full years but not calendar years.
  const evidence = [...fiscalYearEnds].filter((d) => d !== "12-31" || financials.length);
  if (evidence.length === 1) {
    front.splice(fiscalYearEndSlot, 0, `fiscal_year_end: "${evidence[0]}"`);
    mapped.push(`reporting periods → fiscal_year_end ${evidence[0]} (inferred)`);
    warnings.push(`fiscal_year_end "${evidence[0]}" was inferred from the reporting periods in the capsule; confirm it.`);
  } else if (evidence.length > 1) {
    warnings.push(`Reports end on different dates (${evidence.join(", ")}), so no fiscal_year_end was written.`);
  }

  // ---- Contact -------------------------------------------------------------
  const profiles = ofType("OrganizationProfile").filter(belongsToOrg);
  const people = unique([
    ...resolveAll(get(org, "hasContact")),
    ...profiles.flatMap((p) => resolveAll(get(p, "hasPrimaryContact"))),
  ]);
  const contactLines: string[] = [];
  for (const person of people) {
    used.add(person);
    const email = text(get(person, "hasEmail"));
    const personName = [text(get(person, "givenName")), text(get(person, "familyName"))].filter(Boolean).join(" ") || text(get(person, "hasName"));
    if (!email) continue;
    contactLines.push(`- primary contact${personName ? ` (${prose(personName)})` : ""}: <${oneLine(email)}>`);
  }
  if (contactLines.length) {
    mapped.push(`${contactLines.length} contact(s) → Contact`);
    warnings.push("A named contact was copied from the capsule; confirm they are happy to be listed before sharing.");
  }

  // ---- Everything else in the capsule --------------------------------------
  const leftovers = new Map<string, number>();
  for (const n of nodes) {
    if (used.has(n)) continue;
    const t = typesOf(n)[0] ?? "untyped object";
    leftovers.set(t, (leftovers.get(t) ?? 0) + 1);
  }
  if (leftovers.size) {
    notCarried.push(
      `Capsule content with no backpack field${others.length ? ", or belonging to the other organizations" : ""}: ${[...leftovers].map(([t, n]) => `${n} ${shortKey(t)}`).join(", ")}`,
    );
  }
  notCarried.push("Not in a capsule, left for the org to complete: Theory of change, Programs, Governance, Data posture, What we're looking for");

  // ---- Write the markdown ---------------------------------------------------
  const theory = usedOutcomes.length
    ? `<!-- Org to complete. For reference, the capsule reports on these outcomes:\n${usedOutcomes
        .map((o) => {
          const d = text(get(o, "hasDescription"));
          return `- ${comment(text(get(o, "hasName")) ?? idOf(o) ?? "outcome")}${d ? `: ${comment(d)}` : ""}`;
        })
        .join("\n")}\n-->`
    : PLACEHOLDER;

  const metricYaml: string[] = ["metrics:"];
  if (!metricTotal) metricYaml[0] = "metrics: []";
  for (const [outcome, group] of groups) {
    if (outcome) metricYaml.push(`  # Outcome: ${comment(text(get(outcome, "hasName")) ?? idOf(outcome) ?? "")}`);
    else if (groups.size > 1) metricYaml.push("  # Not linked to an outcome");
    for (const m of group.metrics) {
      metricYaml.push(`  - metric: ${yaml(m.metric)}`);
      metricYaml.push(`    value: ${isNumber(m.value) ? m.value : yaml(m.value)}`);
      if (m.unit) metricYaml.push(`    unit: ${yaml(m.unit)}`);
      if (m.year !== undefined) metricYaml.push(`    year: ${m.year}`);
      if (m.note) metricYaml.push("    methodology_note: >", ...wrap(fenceSafe(m.note), 72).map((l) => `      ${l}`));
      metricYaml.push("");
    }
    if (group.noData.length) {
      metricYaml.push("  # In the capsule with no reported data yet:");
      for (const n of group.noData) metricYaml.push(`  # - metric: ${comment(n)}`);
      metricYaml.push("");
    }
  }
  while (metricYaml[metricYaml.length - 1] === "") metricYaml.pop();

  const markdown = [
    "---",
    ...front,
    "---",
    "",
    `<!-- Draft written from a CIDS capsule by backpack-capsule. Sections marked "Org to complete" have no data in the capsule. -->`,
    "",
    "## Mission",
    "",
    mission,
    "",
    "## Theory of change",
    "",
    theory,
    "",
    "## Programs",
    "",
    PLACEHOLDER,
    "",
    "## Financials",
    "",
    financialSection,
    "",
    "## Metrics",
    "",
    "```yaml",
    ...metricYaml,
    "```",
    "",
    "## Governance",
    "",
    PLACEHOLDER,
    "",
    "## Data posture",
    "",
    PLACEHOLDER,
    "",
    "## Contact",
    "",
    contactLines.length ? contactLines.join("\n") : PLACEHOLDER,
    "",
    "## What we're looking for",
    "",
    PLACEHOLDER,
    "",
  ].join("\n");

  return {
    markdown,
    report: {
      title: `Draft backpack for ${name}`,
      organization: name,
      mapped,
      notCarried,
      warnings,
      counts: { indicators: indicators.length, indicatorReports: reportCount, financialYears: financials.length ? 1 : 0 },
    },
  };
}

// ---- reading JSON-LD --------------------------------------------------------

function flatten(capsule: unknown): Node[] {
  if (Array.isArray(capsule)) return capsule.flatMap(flatten);
  if (!isNode(capsule)) return [];
  if (Array.isArray(capsule["@graph"])) return capsule["@graph"].flatMap(flatten);
  return [capsule];
}

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const unique = <T>(items: T[]): T[] => [...new Set(items)];
const idOf = (n: Node): string | undefined => (typeof n["@id"] === "string" ? n["@id"] : undefined);
const typesOf = (n: Node): string[] => asArray(n["@type"]).filter((t): t is string => typeof t === "string");

/** True for "cids:Indicator", "Indicator" and the full IRI ending in "#Indicator". */
function isType(n: Node, name: string): boolean {
  return typesOf(n).some((t) => t === name || t.endsWith(`:${name}`) || t.endsWith(`#${name}`));
}

/** Read a property written as `key`, `prefix:key`, or a full IRI ending in the key. */
function get(n: Node, key: string): unknown {
  if (key in n) return n[key];
  for (const k of Object.keys(n)) {
    if (k.endsWith(`:${key}`) || k.endsWith(`#${key}`) || k.endsWith(`/${key}`)) return n[k];
  }
  return undefined;
}

/** A plain value: "x", 5, {"@value": "x"}, or the first of a list. */
function text(v: unknown): string | undefined {
  const first = Array.isArray(v) ? v[0] : v;
  const raw = isNode(first) ? first["@value"] : first;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw !== "string") return undefined;
  return raw.trim() || undefined;
}

/** The IRIs a property points to. */
function refs(v: unknown): string[] {
  return asArray(v)
    .map((x) => (typeof x === "string" ? x : isNode(x) ? idOf(x) : undefined))
    .filter((x): x is string => Boolean(x));
}

function pickOrganization(orgs: Node[], indicators: Node[], reports: Node[], wanted?: string): Node {
  if (!orgs.length) throw new Error("The capsule has no cids:Organization.");
  const label = (o: Node) => `${text(get(o, "hasLegalName")) ?? "(no name)"} — ${idOf(o) ?? "(no @id)"}`;
  if (wanted) {
    const match = orgs.find((o) => idOf(o) === wanted || text(get(o, "hasLegalName"))?.toLowerCase() === wanted.toLowerCase());
    if (!match) throw new Error(`No organization "${wanted}" in the capsule. It has:\n${orgs.map((o) => `  ${label(o)}`).join("\n")}`);
    return match;
  }
  if (orgs.length === 1) return orgs[0];
  const owns = (o: Node) =>
    asArray(get(o, "hasIndicator")).length > 0 ||
    [...indicators, ...reports].some((n) => refs(get(n, "forOrganization")).includes(idOf(o) ?? ""));
  const owners = orgs.filter(owns);
  if (owners.length === 1) return owners[0];
  const list = (owners.length ? owners : orgs).map((o) => `  ${label(o)}`).join("\n");
  throw new Error(
    `The capsule holds ${owners.length || orgs.length} organizations with data. A backpack describes one, so choose it with --org "<name or @id>":\n${list}`,
  );
}

// ---- dates, numbers ---------------------------------------------------------

const datePart = (v: string | undefined): string | undefined => /^\d{4}-\d{2}-\d{2}/.exec(v ?? "")?.[0];

/**
 * A backpack metric has only a `year`. Use the year the period ends in, and keep
 * the exact dates in a note when the period is not one full year.
 */
function readPeriod(report: Node): { year?: number; end?: string; note?: string; fiscalYearEnd?: string } {
  // The date as written, not shifted to UTC: "2025-12-31T12:00:00-08:00" is 31 December.
  const start = datePart(text(get(report, "startedAtTime")));
  const end = datePart(text(get(report, "endedAtTime")));
  if (!end) return {};
  let year = Number(end.slice(0, 4));
  if (!start) return { year, end };
  const full = reportingPeriod(year, end.slice(5));
  if (full.startDate === start && full.endDate === end) return { year, end, fiscalYearEnd: end.slice(5) };
  // A period written as ending on 1 January belongs to the year before.
  if (end.slice(5) === "01-01" && Number(start.slice(0, 4)) < year) year -= 1;
  return { year, end, note: `Reporting period: ${start} to ${end}.` };
}

const isNumber = (v: string) => /^-?\d+(\.\d+)?$/.test(v);

function money(v: string): string {
  const [whole, frac] = v.replace(/^-/, "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${v.startsWith("-") ? "-" : ""}$${grouped}${frac && Number(frac) ? `.${frac}` : ""}`;
}

/** "12-3456789", or nine digits when the ID or issuer says it is an EIN. */
function asEin(identifier: string, context: string): string | undefined {
  const id = identifier.trim();
  if (/^\d{2}-\d{7}$/.test(id)) return id;
  if (/^\d{9}$/.test(id) && /\b(ein|irs)\b/i.test(context.replace(/[^a-z]+/gi, " "))) return `${id.slice(0, 2)}-${id.slice(2)}`;
  return undefined;
}

function unitLabel(measure: Node | undefined, resolve: (v: unknown) => Node | undefined): string | undefined {
  const unit = measure && resolve(get(measure, "unit_of_measure"));
  if (!unit || /unspecifiedUnit$/.test(idOf(unit) ?? "")) return undefined;
  return text(get(unit, "label")) ?? text(get(unit, "symbol"));
}

const shortKey = (k: string) => k.replace(/^.*[#/]/, "");

// ---- writing safe markdown and YAML ----------------------------------------

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** End with a full stop, so joined notes read as sentences. */
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
/** A code fence inside the text would end the metrics block early. */
const fenceSafe = (s: string) => s.replace(/`{3,}/g, "'''");
/** A YAML value on one line, quoted when it needs to be. */
const yaml = (s: string) => stringify(fenceSafe(oneLine(s)), { lineWidth: 0 }).trimEnd();
/** Text for inside an HTML or YAML comment. */
const comment = (s: string) => fenceSafe(oneLine(s)).replace(/--+>/g, "→").replace(/<!--/g, "");
/** Paragraph text: must not open a comment or start a heading. */
const prose = (s: string) =>
  wrap(oneLine(s).replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;"), 78)
    // Wrapping can move a "#" to the start of a line, where it would read as a heading.
    .map((line) => line.replace(/^#/, "\\#"))
    .join("\n");

function wrap(s: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of s.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
