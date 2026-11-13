import { parse as parseYaml } from "yaml";

/** One entry of the backpack `metrics:` block, as written by the org. */
export interface BackpackMetric {
  metric: string;
  value?: unknown;
  unit?: string;
  year?: number;
  methodology_note?: string;
}

export interface BackpackFinancials {
  fiscalYear?: number;
  /** Raw text after the label, e.g. "$91.1M (contributions 93%…)". */
  revenue?: string;
  expenses?: string;
  netAssets?: string;
}

export interface Backpack {
  frontmatter: Record<string, unknown>;
  /** Section heading (lower-cased) → prose with HTML comments removed. */
  sections: Map<string, string>;
  /** Section heading (lower-cased) → drafting notes found in HTML comments. */
  draftingNotes: Map<string, string[]>;
  metrics: BackpackMetric[];
  /** Metrics the draft lists as "would ideally add" (commented out, no data). */
  suggestedMetrics: string[];
  financials: BackpackFinancials;
}

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const HTML_COMMENT = /<!--([\s\S]*?)-->/g;

export function parseBackpack(markdown: string): Backpack {
  const fm = FRONTMATTER.exec(markdown);
  if (!fm) {
    throw new Error(
      "No YAML frontmatter found. An organization.md must start with a '---' block containing at least `name`.",
    );
  }
  const frontmatter = (parseYaml(fm[1]) ?? {}) as Record<string, unknown>;
  const body = markdown.slice(fm[0].length);

  const sections = new Map<string, string>();
  const draftingNotes = new Map<string, string[]>();

  // Split on level-2 headings. Anything before the first heading is ignored.
  const parts = body.split(/^##[ \t]+(.+?)[ \t]*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i].trim().toLowerCase();
    const raw = parts[i + 1] ?? "";
    const notes: string[] = [];
    // Placeholders such as <!-- Org to complete --> must never reach the capsule.
    const clean = raw.replace(HTML_COMMENT, (_m, note: string) => {
      notes.push(note.replace(/\s+/g, " ").trim());
      return "";
    });
    sections.set(heading, clean.trim());
    if (notes.length) draftingNotes.set(heading, notes);
  }

  const { metrics, suggested } = parseMetrics(sections.get("metrics") ?? "");

  return {
    frontmatter,
    sections,
    draftingNotes,
    metrics,
    suggestedMetrics: suggested,
    financials: parseFinancials(sections.get("financials") ?? ""),
  };
}

function parseMetrics(section: string): { metrics: BackpackMetric[]; suggested: string[] } {
  const fence = /```ya?ml\r?\n([\s\S]*?)```/.exec(section);
  if (!fence) return { metrics: [], suggested: [] };
  const yamlText = fence[1];

  const suggested: string[] = [];
  for (const m of yamlText.matchAll(/^\s*#\s*-\s*metric:\s*(.+?)\s*$/gm)) suggested.push(m[1]);

  const doc = parseYaml(yamlText) as { metrics?: unknown } | null;
  const list = Array.isArray(doc?.metrics) ? doc.metrics : [];
  const metrics: BackpackMetric[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.metric !== "string" || !e.metric.trim()) continue;
    metrics.push({
      metric: e.metric.trim(),
      value: e.value,
      unit: e.unit == null ? undefined : String(e.unit).trim(),
      year: typeof e.year === "number" ? e.year : Number.parseInt(String(e.year ?? ""), 10) || undefined,
      methodology_note:
        typeof e.methodology_note === "string" ? e.methodology_note.replace(/\s+/g, " ").trim() : undefined,
    });
  }
  return { metrics, suggested };
}

/** Reads `- **Label**: value` bullets from the Financials section. */
function parseFinancials(section: string): BackpackFinancials {
  const fields = new Map<string, string>();
  // Join wrapped bullet lines first so a value split over two lines stays whole.
  const joined = section.replace(/\r?\n[ \t]+(?=\S)/g, " ");
  for (const m of joined.matchAll(/^[-*]\s+\*\*(.+?)\*\*\s*:\s*(.*)$/gm)) {
    fields.set(m[1].trim().toLowerCase(), m[2].trim());
  }
  const fy = Number.parseInt(fields.get("fiscal year") ?? "", 10);
  return {
    fiscalYear: Number.isFinite(fy) ? fy : undefined,
    revenue: fields.get("revenue") || undefined,
    expenses: fields.get("expenses") || undefined,
    netAssets: fields.get("net assets") || undefined,
  };
}

/**
 * Reads the dollar amount at the start of a financial line, e.g. "$699,731 (…)"
 * or "$91.1M". Returns a plain decimal string, or undefined when the text does
 * not start with a clear amount (the converter reports it rather than guessing).
 */
export function parseAmount(text: string | undefined): { value: string; rounded: boolean } | undefined {
  if (!text) return undefined;
  const m = /^\$\s*([0-9][0-9,]*)(?:\.([0-9]+))?\s*([KMB]|thousand|million|billion)?\b/i.exec(text.trim());
  if (!m) return undefined;
  const whole = m[1].replace(/,/g, "");
  const frac = m[2] ?? "";
  const suffix = (m[3] ?? "").toLowerCase();
  const shift = { "": 0, k: 3, thousand: 3, m: 6, million: 6, b: 9, billion: 9 }[suffix] ?? 0;
  if (shift === 0) {
    return { value: frac ? `${whole}.${frac}` : whole, rounded: false };
  }
  // Shift the decimal point with strings so 91.1M is exactly 91100000.
  const padded = frac.padEnd(shift, "0");
  const intPart = (whole + padded.slice(0, shift)).replace(/^0+(?=\d)/, "");
  const rest = padded.slice(shift);
  return { value: rest ? `${intPart}.${rest}` : intPart, rounded: true };
}
