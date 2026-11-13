import { readFileSync } from "node:fs";
import { CIDS_CONTEXT, type Capsule } from "./convert.js";

export interface ValidationIssue {
  severity: "Violation" | "Warning" | "Info";
  focusNode: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  /** True when there are no Violation-level results. Warnings and Info do not fail a capsule. */
  conforms: boolean;
  issues: ValidationIssue[];
  /** How many RDF statements the capsule produced; 0 means nothing was actually checked. */
  triples: number;
}

const vendor = (file: string) => new URL(`../vendor/cids/${file}`, import.meta.url);

/**
 * Check a capsule against the CIDS Basic Tier SHACL rules that ship with this package.
 * Runs offline: the CIDS context is read from the bundled copy, never fetched.
 * Common Form (cfo) terms are not covered, because no rules exist for them.
 */
export async function validateBasicTier(capsule: Capsule): Promise<ValidationResult> {
  let jsonld: any, n3: any, SHACLValidator: any, rdf: any;
  try {
    jsonld = (await import("jsonld")).default;
    n3 = await import("n3");
    SHACLValidator = (await import("rdf-validate-shacl")).default;
    rdf = (await import("@zazuko/env")).default;
  } catch {
    throw new Error("Validation needs the optional packages jsonld, n3, rdf-validate-shacl and @zazuko/env.");
  }

  const cidsContext = JSON.parse(readFileSync(vendor("cidsContext.jsonld"), "utf8"));
  const documentLoader = async (url: string) => {
    if (url === CIDS_CONTEXT) return { contextUrl: null, document: cidsContext, documentUrl: url };
    throw new Error(`Refusing to fetch ${url}: validation runs offline with the bundled CIDS context only.`);
  };

  const nquads: string = await jsonld.toRDF(capsule, { format: "application/n-quads", documentLoader });
  const data = rdf.dataset(new n3.Parser({ format: "application/n-quads" }).parse(nquads));
  const shapes = rdf.dataset(
    new n3.Parser({ format: "text/turtle" }).parse(readFileSync(vendor("cids.basictier.shacl.ttl"), "utf8")),
  );

  const report = await new SHACLValidator(shapes, { factory: rdf }).validate(data);
  const issues: ValidationIssue[] = report.results.map((r: any) => ({
    severity: (r.severity?.value ?? "").split("#").pop() || "Violation",
    focusNode: r.focusNode?.value ?? "",
    path: r.path?.value ?? "",
    message: (r.message ?? []).map((m: any) => m.value).join(" ") || (r.sourceConstraintComponent?.value ?? ""),
  }));

  return { conforms: !issues.some((i) => i.severity === "Violation"), issues, triples: data.size };
}

export function formatValidation(result: ValidationResult): string {
  const count = (s: ValidationIssue["severity"]) => result.issues.filter((i) => i.severity === s).length;
  const head = result.conforms
    ? `✔ Passes CIDS Basic Tier validation (${result.triples} statements checked; ${count("Warning")} warning(s), ${count("Info")} suggestion(s))`
    : `✘ Fails CIDS Basic Tier validation: ${count("Violation")} violation(s)`;
  const lines = [head];
  for (const i of result.issues) {
    const label = i.severity === "Info" ? "Suggestion" : i.severity;
    lines.push(`  [${label}] ${short(i.focusNode)} · ${short(i.path)} — ${i.message}`);
  }
  return lines.join("\n");
}

const short = (iri: string) => iri.replace(/^.*[#/](?=[^#/]+$)/, "");
