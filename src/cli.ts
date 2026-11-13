#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { convert, formatReport, type ConvertOptions } from "./convert.js";

const HELP = `backpack-to-cids — convert a Digital Backpack organization.md into a CIDS capsule

Usage:
  backpack-to-cids <organization.md> [options]

Options:
  -o, --out <file>      Where to write the capsule (default: <input>.capsule.jsonld; "-" for stdout)
      --base <iri>      Base IRI for IDs (default: the backpack's website)
      --calendar-year   Read metric years as calendar years instead of fiscal years
      --no-common-form  Leave out financials (Common Form vocabulary)
      --graph           Write one @context + @graph instead of a list of objects
      --validate        Check the capsule against the CIDS Basic Tier rules
  -h, --help            Show this help
`;

async function main(argv: string[]): Promise<number> {
  const options: ConvertOptions = {};
  let input: string | undefined;
  let out: string | undefined;
  let validate = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(HELP);
      return 0;
    } else if (arg === "-o" || arg === "--out") out = next();
    else if (arg === "--base") options.base = next();
    else if (arg === "--calendar-year") options.yearBasis = "calendar";
    else if (arg === "--no-common-form") options.commonForm = false;
    else if (arg === "--graph") options.format = "graph";
    else if (arg === "--validate") validate = true;
    else if (arg.startsWith("-") && arg !== "-") throw new Error(`Unknown option ${arg}`);
    else if (input === undefined) input = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }

  if (!input) {
    process.stderr.write(HELP);
    return 2;
  }

  const { capsule, report } = convert(readFileSync(input, "utf8"), options);
  const json = `${JSON.stringify(capsule, null, 2)}\n`;
  // The report goes to stderr so `-o -` can be piped.
  const say = (text: string) => process.stderr.write(`${text}\n`);

  if (out === "-") {
    process.stdout.write(json);
  } else {
    out ??= `${basename(input).replace(/\.md$/i, "")}.capsule.jsonld`;
    writeFileSync(out, json);
  }

  say(formatReport(report));

  let exit = 0;
  if (validate) {
    const { validateBasicTier, formatValidation } = await import("./validate.js");
    const result = await validateBasicTier(capsule);
    say("");
    say(formatValidation(result));
    if (!result.conforms) exit = 1;
  } else {
    say("");
    say("Not validated (run again with --validate to check against CIDS Basic Tier).");
  }
  if (out !== "-") say(`\nWrote ${out}`);
  return exit;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
