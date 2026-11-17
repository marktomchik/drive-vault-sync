import { readFileSync, writeFileSync } from "node:fs";
import patches from "./patches.mjs";
const [, , input, output] = process.argv;
let src = readFileSync(input, "utf8").replace(/\r\n/g, "\n");
for (const [label, find, replace] of patches) {
  const count = src.split(find).length - 1;
  if (count !== 1) { console.error(`patch "${label}": expected 1 match, found ${count}`); process.exit(1); }
  src = src.replace(find, () => replace);
  console.log(`ok ${label}`);
}
writeFileSync(output, src);
