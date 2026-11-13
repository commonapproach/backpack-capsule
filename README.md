# backpack-to-capsule

Convert a [Digital Backpack](https://github.com/Digital-Public-Goods-Network/digital-backpack)
`organization.md` into a [CIDS](https://github.com/commonapproach/CIDS) impact
data capsule (Common Impact Data Standard, Basic Tier, JSON-LD).

> **Status: early MVP.** The converter, the command line tool and offline
> validation work.

## Try it

```sh
npx github:commonapproach/backpack-to-capsule https://raw.githubusercontent.com/Digital-Public-Goods-Network/digital-backpack/main/examples/300108263-globalgiving.md --validate
```

It writes `300108263-globalgiving.capsule.jsonld` and prints a report:

```
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

The input can be a web address (GitHub links work), a local file, or `-` for
stdin. Options: `--base <iri>`, `--calendar-year`, `--no-common-form`,
`--graph`, `-o <file>` (`-o -` prints the capsule instead of writing a file).
Add `--help` for details.

## In code

```js
import { convert, formatReport } from "backpack-to-capsule";

const url =
  "https://raw.githubusercontent.com/Digital-Public-Goods-Network/digital-backpack/main/examples/300108263-globalgiving.md";

const markdown = await (await fetch(url)).text();
const { capsule, report } = convert(markdown);

console.log(JSON.stringify(capsule, null, 2)); // the CIDS capsule (JSON-LD)
console.error(formatReport(report)); // what was converted, and what was not
```

This is [`examples/from-github.mjs`](examples/from-github.mjs). To run it:

```sh
git clone https://github.com/commonapproach/backpack-to-capsule.git
cd backpack-to-capsule
npm install
node examples/from-github.mjs
```

`convert` is a pure function with one small dependency (`yaml`) and no Node
APIs, so it should also run in the browser (not tested yet). Validation is
separate (`validateBasicTier` in `dist/validate.js`) and Node-only for now.

## What gets converted

| Backpack | Capsule | Vocabulary |
|---|---|---|
| `name` | `Organization.hasLegalName` | CIDS |
| `website` | `Organization.hasWebAddress`, and the base of every `@id` | CIDS |
| Mission | `Organization.hasPurpose` | CIDS |
| `ein` | `Organization.hasID` → `OrganizationID.hasIdentifier` | CIDS |
| each `metrics[]` entry | one `Indicator` per metric, one `IndicatorReport` per year | CIDS |
| Financials: revenue, expenses | `FinancialInformation` → `FinancialIndicators` | Common Form (`cfo`) |


## Tests

```sh
npm test
```

The test fixture (`test/fixtures/riverside-food-bank.md`) is a made-up
organization.
