# backpack-to-cids

Convert a [Digital Backpack](https://github.com/Digital-Public-Goods-Network/digital-backpack)
`organization.md` into a [CIDS](https://github.com/commonapproach/CIDS) impact
data capsule (Common Impact Data Standard, Basic Tier, JSON-LD).

> **Status: early MVP.** The converter, the command line tool and offline
> validation work. It is not published to npm yet, and there is no web page yet.

## Try it

```sh
npm install
npm run build
node dist/cli.js test/fixtures/riverside-food-bank.md --validate
```

This writes `riverside-food-bank.capsule.jsonld` and prints a report:

```
Capsule for Riverside Food Bank

Converted
  ✔ name → Organization.hasLegalName
  ✔ Mission → Organization.hasPurpose
  ✔ 3 metric(s) → 2 Indicator(s) + 3 IndicatorReport(s)
  ✔ reporting period FY2024 = 2023-07-01 to 2024-06-30
  ✔ Financials FY2024 → Common Form FinancialInformation (revenue 1250000, expenses 1180400)
  …
Not carried over
  – hq (a Basic Tier Address needs a street address and postal code; the backpack has city/state only)
  …
✔ Passes CIDS Basic Tier validation (56 statements checked; 0 warning(s), 1 suggestion(s))
```

Options: `--base <iri>`, `--calendar-year`, `--no-common-form`, `--graph`,
`-o <file>` (`-o -` for stdout). Run `node dist/cli.js --help` for details.

## As a library

```ts
import { convert, formatReport } from "backpack-to-cids";

const { capsule, report } = convert(markdownText);
console.log(formatReport(report));
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
