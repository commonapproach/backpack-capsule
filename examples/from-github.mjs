// Fetch a real organization.md from the Digital Backpack repo and print it as a CIDS capsule.
// Run from this repo after `npm install`:   node examples/from-github.mjs
import { convert, formatReport } from "backpack-to-capsule";

const url =
  "https://raw.githubusercontent.com/Digital-Public-Goods-Network/digital-backpack/main/examples/300108263-globalgiving.md";

const markdown = await (await fetch(url)).text();
const { capsule, report } = convert(markdown);

console.log(JSON.stringify(capsule, null, 2)); // the CIDS capsule (JSON-LD)
console.error(formatReport(report)); // what was converted, and what was not
