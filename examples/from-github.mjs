// Fetch a real organization.md from the Digital Backpack repo, turn it into a CIDS
// capsule, then turn that capsule back into a draft backpack.
// Run from this repo after `npm install`:   node examples/from-github.mjs
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
