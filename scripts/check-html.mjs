import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const scriptPattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let count = 0;
for (const match of html.matchAll(scriptPattern)) {
  count += 1;
  new vm.Script(match[1], { filename: `public/index.html:inline-script-${count}` });
}

if (count === 0) throw new Error("No inline scripts found in public/index.html");
console.log(`Checked ${count} inline scripts in the factory visualizer.`);
