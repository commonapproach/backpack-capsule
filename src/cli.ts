#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { convert, formatReport, type ConvertOptions } from "./convert.js";

const HELP = `backpack-to-capsule — convert a Digital Backpack organization.md into a CIDS capsule

Usage:
  backpack-to-capsule <organization.md | https://… | -> [options]

The input can be a local file, a web address (GitHub links work), or "-" for stdin.

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

  const { capsule, report } = convert(await readInput(input), options);
  const json = `${JSON.stringify(capsule, null, 2)}\n`;
  // The report goes to stderr so `-o -` can be piped.
  const say = (text: string) => process.stderr.write(`${text}\n`);

  // Reading from stdin has no file name to build on, so the capsule goes to stdout.
  if (input === "-") out ??= "-";
  if (out === "-") {
    process.stdout.write(json);
  } else {
    const name = isUrl(input) ? new URL(input).pathname : input;
    out ??= `${basename(name).replace(/\.md$/i, "")}.capsule.jsonld`;
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

const isUrl = (input: string) => /^https?:\/\//i.test(input);

/** The input can be a local file, a web address, or "-" for stdin. */
async function readInput(input: string): Promise<string> {
  if (input === "-") return readFileSync(0, "utf8");
  if (!isUrl(input)) return readFileSync(input, "utf8");
  // A github.com page link ("…/blob/…") returns HTML, so fetch the raw file instead.
  const url = input.replace(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i,
    "https://raw.githubusercontent.com/$1/$2/$3",
  );
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url} (${res.status} ${res.statusText})`);
  return res.text();
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
