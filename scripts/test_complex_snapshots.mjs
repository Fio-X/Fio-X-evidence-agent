#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { renderVizBundle } from "../runtime/pi/viz.mjs";

const names=["sankey","node-link","matrix","hierarchy","timeline","streamgraph","log-scatter"];
const actual={};
for(const name of names){
  const fixture=JSON.parse(await readFile(new URL(`../fixtures/complex/${name}.json`,import.meta.url),"utf8"));
  const bundle=renderVizBundle(fixture.spec,fixture.rows);
  actual[name]={desktop:createHash("sha256").update(bundle.desktop).digest("hex"),mobile:createHash("sha256").update(bundle.mobile).digest("hex")};
}
const target=new URL("../fixtures/complex-snapshots.json",import.meta.url);
if(process.argv.includes("--update")){await writeFile(target,JSON.stringify(actual,null,2)+"\n");console.log("complex snapshots updated");process.exit(0);}
const expected=JSON.parse(await readFile(target,"utf8"));
assert.deepEqual(actual,expected);
console.log("complex viz snapshots: PASS");
for(const [name,h] of Object.entries(actual))console.log(`${name}: desktop=${h.desktop.slice(0,12)} mobile=${h.mobile.slice(0,12)}`);
