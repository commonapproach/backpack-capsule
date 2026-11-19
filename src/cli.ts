#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { convert, formatReport, type ConvertOptions } from "./convert.js";
import { toBackpack } from "./reverse.js";

const HELP = `backpack-capsule — convert between Digital Backpack markdown and CIDS impact data capsules

Usage:
  backpack-capsule <file | https://… | -> [options]

The direction comes from the input:
  a backpack organization.md   →  a CIDS capsule (JSON-LD)
  a CIDS capsule (JSON-LD)     →  a draft backpack organization.md

The input can be a local file, a web address (GitHub links work), or "-" for stdin.

Options:
  -o, --out <file>      Where to write the result ("-" for stdout)
                        Default: <input>.capsule.jsonld or <input>.backpack.md
  -h, --help            Show this help

Backpack → capsule only:
      --base <iri>      Base IRI for IDs (default: the backpack's website)
      --calendar-year   Read metric years as calendar years instead of fiscal years
      --no-common-form  Leave out financials (Common Form vocabulary)
      --graph           Write one @context + @graph instead of a list of objects
      --validate        Check the capsule against the CIDS Basic Tier rules

Capsule → backpack only:
      --org <name|@id>  Which organization to write, when the capsule holds several
`;

async function main(argv: string[]): Promise<number> {
  const options: ConvertOptions = {};
  let input: string | undefined;
  let out: string | undefined;
  let validate = false;
  let org: string | undefined;
  const forwardOnly: string[] = [];

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
    else if (arg === "--org") org = next();
    else if (arg === "--base") (options.base = next()), forwardOnly.push(arg);
    else if (arg === "--calendar-year") (options.yearBasis = "calendar"), forwardOnly.push(arg);
    else if (arg === "--no-common-form") (options.commonForm = false), forwardOnly.push(arg);
    else if (arg === "--graph") (options.format = "graph"), forwardOnly.push(arg);
    else if (arg === "--validate") (validate = true), forwardOnly.push(arg);
    else if (arg.startsWith("-") && arg !== "-") throw new Error(`Unknown option ${arg}`);
    else if (input === undefined) input = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }

  if (!input) {
    process.stderr.write(HELP);
    return 2;
  }

  const source = await readInput(input);
  // The report goes to stderr so `-o -` can be piped.
  const say = (text: string) => process.stderr.write(`${text}\n`);
  // Reading from stdin has no file name to build on, so the result goes to stdout.
  if (input === "-") out ??= "-";
  const inputName = basename(isUrl(input) ? new URL(input).pathname : input);

  // A capsule is JSON; a backpack is markdown that starts with "---".
  if (/^\s*[[{]/.test(source)) {
    if (forwardOnly.length) {
      throw new Error(
        `The input is a capsule, and ${forwardOnly.join(", ")} only appl${forwardOnly.length > 1 ? "y" : "ies"} when converting a backpack into a capsule.`,
      );
    }
    let capsule: unknown;
    try {
      capsule = JSON.parse(source);
    } catch (err) {
      throw new Error(`The input looks like JSON but could not be read: ${err instanceof Error ? err.message : err}`);
    }
    const { markdown, report } = toBackpack(capsule, { organization: org, today: localDate() });
    if (out !== "-") {
      const chosen = out !== undefined;
      out ??= `${inputName.replace(/(\.capsule)?\.(jsonld|json)$/i, "")}.backpack.md`;
      // A draft backpack gets edited by hand afterwards, so never replace one silently.
      if (!chosen && existsSync(out)) {
        throw new Error(`${out} already exists. Use -o to choose where to write the draft.`);
      }
      writeFileSync(out, markdown);
    } else {
      process.stdout.write(markdown);
    }
    say("Capsule → backpack\n");
    say(formatReport(report));
    say("\nThis is a draft: the organization should review it and complete the placeholder sections.");
    if (out !== "-") say(`\nWrote ${out}`);
    return 0;
  }

  if (org) throw new Error("The input is a backpack, and --org only applies when converting a capsule into a backpack.");
  const { capsule, report } = convert(source, options);
  const json = `${JSON.stringify(capsule, null, 2)}\n`;
  if (out === "-") {
    process.stdout.write(json);
  } else {
    out ??= `${inputName.replace(/\.md$/i, "")}.capsule.jsonld`;
    writeFileSync(out, json);
  }

  say("Backpack → capsule\n");
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

function localDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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
