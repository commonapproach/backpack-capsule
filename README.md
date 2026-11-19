# backpack-capsule

Convert between [Digital Backpack](https://github.com/Digital-Public-Goods-Network/digital-backpack)
`organization.md` files and [CIDS](https://github.com/commonapproach/CIDS)
impact data capsules (Common Impact Data Standard, Basic Tier, JSON-LD), in
either direction.

> **Status: early MVP.** Both directions, the command line tool and offline
> validation work. It will be available on npm soon; until then, run it
> straight from GitHub as shown below.

## Try it

One command does both. It looks at the input: markdown becomes a capsule, a
capsule becomes a draft backpack.

### Backpack → capsule

```sh
npx github:commonapproach/backpack-capsule https://raw.githubusercontent.com/Digital-Public-Goods-Network/digital-backpack/main/examples/300108263-globalgiving.md --validate
```

It writes `300108263-globalgiving.capsule.jsonld` and prints a report:

```
Backpack → capsule

Capsule for GlobalGiving Foundation Inc

Converted
  ✔ name → Organization.hasLegalName
  ✔ Mission → Organization.hasPurpose
  ✔ website → Organization.hasWebAddress
  ✔ ein → OrganizationID.hasIdentifier
  ✔ 2 metric(s) → 2 Indicator(s) + 2 IndicatorReport(s)
  ✔ reporting period 2024 = 2024-01-01 to 2024-12-31
  ✔ Financials FY2024 → Common Form FinancialInformation (revenue 91100000, expenses 116000000)

Not carried over
  – hq (a Basic Tier Address needs a street address and postal code; the backpack has city/state only)
  …

✔ Passes CIDS Basic Tier validation (45 statements checked; 0 warning(s), 2 suggestion(s))
```

Part of the capsule it writes:

```json
{
  "@context": [
    "https://ontology.commonapproach.org/contexts/cidsContext.jsonld",
    { "cfo": "https://ontology.commonapproach.org/cfo#" }
  ],
  "@type": "cids:IndicatorReport",
  "@id": "https://www.globalgiving.org/IndicatorReport/activenonprofitpartners2024010120241231",
  "hasName": "GlobalGiving Foundation Inc - 2024 - active nonprofit partners",
  "value": { "@type": "i72:Measure", "hasNumericalValue": "5000" },
  "startedAtTime": "2024-01-01T00:00:00Z",
  "endedAtTime": "2024-12-31T23:59:59Z",
  "forIndicator": "https://www.globalgiving.org/Indicator/activenonprofitpartners",
  "forOrganization": "https://www.globalgiving.org/Organization/globalgivingfoundationinc"
}
```

### Capsule → backpack

```sh
npx github:commonapproach/backpack-capsule https://raw.githubusercontent.com/commonapproach/backpack-capsule/main/test/fixtures/northside-kitchen.jsonld
```

It writes `northside-kitchen.backpack.md`, a **draft** `organization.md`. What
the capsule holds is filled in; everything else is left as an
`<!-- Org to complete -->` placeholder, the same convention the Digital
Backpack project uses for its own drafts. An excerpt:

````markdown
---
schema_version: "0.1"
name: Northside Community Kitchen
# ein: the capsule has the identifier BN000000000, which is not a US EIN
hq:
  city: Hamilton
  state: ON
  country: Canada
last_updated: 2026-11-13
---

…

## Theory of change

<!-- Org to complete. For reference, the capsule reports on these outcomes:
- Improve food security: Neighbours have reliable access to healthy meals.
- Build kitchen skills
-->

…

## Metrics

```yaml
metrics:
  # Outcome: Improve food security
  - metric: Meals served
    value: 21400
    unit: meals
    year: 2025
    methodology_note: >
      Meals plated at the kitchen, counted daily. Comment: Includes the new
      Saturday service.
  …
```
````

The report lists what could not be carried over, such as outcomes, themes and
identifiers that are not a US EIN. If a capsule holds several organizations,
choose one with `--org "<name or @id>"`.

### Options

The input can be a web address (GitHub links work), a local file, or `-` for
stdin. `-o <file>` chooses where to write (`-o -` prints instead). When
converting a backpack: `--base <iri>`, `--calendar-year`, `--no-common-form`,
`--graph`, `--validate`. Add `--help` for details.

## In code

```js
import { toCapsule, toBackpack, formatReport } from "backpack-capsule";

const url =
  "https://raw.githubusercontent.com/Digital-Public-Goods-Network/digital-backpack/main/examples/300108263-globalgiving.md";
const markdown = await (await fetch(url)).text();

// Backpack → capsule
const { capsule, report } = toCapsule(markdown);
console.log(JSON.stringify(capsule, null, 2)); // the CIDS capsule (JSON-LD)
console.error(formatReport(report)); // what was converted, and what was not

// Capsule → backpack
const draft = toBackpack(capsule);
console.log(draft.markdown); // a draft organization.md
console.error(formatReport(draft.report));
```

This is [`examples/from-github.mjs`](examples/from-github.mjs). To run it:

```sh
git clone https://github.com/commonapproach/backpack-capsule.git
cd backpack-capsule
npm install
node examples/from-github.mjs
```

Both functions are pure, with one small dependency (`yaml`) and no Node APIs,
so they should also run in the browser (not tested yet). Validation is
separate (`validateBasicTier` in `dist/validate.js`) and Node-only for now.

## What gets converted

### Backpack → capsule

| Backpack | Capsule | Vocabulary |
|---|---|---|
| `name` | `Organization.hasLegalName` | CIDS |
| `website` | `Organization.hasWebAddress`, and the base of every `@id` | CIDS |
| Mission | `Organization.hasPurpose` | CIDS |
| `ein` | `Organization.hasID` → `OrganizationID.hasIdentifier` | CIDS |
| each `metrics[]` entry | one `Indicator` per metric, one `IndicatorReport` per year | CIDS |
| Financials: revenue, expenses | `FinancialInformation` → `FinancialIndicators` | Common Form (`cfo`) |

### Capsule → backpack

| Capsule | Backpack |
|---|---|
| `Organization.hasLegalName` | `name` |
| `Organization.hasWebAddress` | `website` |
| `Organization.hasPurpose` (or `hasDescription`, flagged for the org to confirm) | Mission |
| `OrganizationID.hasIdentifier`, when it is a US EIN | `ein` |
| `Address` | `hq` (city, state, country) |
| each `IndicatorReport` | one `metrics[]` entry: name, value, unit, year, note |
| Common Form `FinancialInformation` | Financials: fiscal year, revenue, expenses |
| primary contact (`Person`) | Contact |
| `Outcome` | comments only; the backpack has no outcome field |

A backpack converted to a capsule and back keeps every field in the first
table. A capsule from another tool loses more on the way: its outcomes survive
only as comments, and text values and part-year periods are simplified.

## Tests

```sh
npm test
```

The test fixtures (`test/fixtures/`) are made-up organizations.
