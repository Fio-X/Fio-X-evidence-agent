import assert from "node:assert/strict";
import { computationRelativePath, datasetRelativePath, sourceContentHash } from "../runtime/pi/provenance.mjs";

const encoder = new TextEncoder();
const a = datasetRelativePath(encoder.encode("a,b\n1,2\n"), "csv");
const a2 = datasetRelativePath(encoder.encode("a,b\n1,2\n"), "csv");
const b = datasetRelativePath(encoder.encode("a,b\n1,3\n"), "csv");
assert.equal(a.relativeFile, a2.relativeFile);
assert.notEqual(a.relativeFile, b.relativeFile);
assert.match(a.relativeFile, /^data\/[0-9a-f]{64}\.csv$/);

const s1 = sourceContentHash({ finalUrl: "https://example.test", status: 200, contentType: "text/html", truncated: false, text: "hello" });
const s2 = sourceContentHash({ finalUrl: "https://example.test", status: 200, contentType: "text/html", truncated: false, text: "hello" });
const s3 = sourceContentHash({ finalUrl: "https://example.test", status: 200, contentType: "text/html", truncated: false, text: "changed" });
assert.equal(s1, s2);
assert.notEqual(s1, s3);
assert.equal(s1, "77b849ca02bc41ef7ea33ec4842329f2067c6c529eceb369624f3685620f1f4a", "source hash must match canonical cross-language hash");

const c1 = computationRelativePath("select 1", "inputs-a", "rows-a");
const c2 = computationRelativePath("select 1", "inputs-a", "rows-a");
const c3 = computationRelativePath("select 1", "inputs-b", "rows-a");
assert.equal(c1, c2);
assert.notEqual(c1, c3);
assert.match(c1, /^computations\/[0-9a-f]{64}\.json$/);
console.log("content addressing: PASS");
