// Offline driver only (src/next_drive.rs, NEXT_DRIVE_FETCH_FROM): node loads this before the tool host, so every fetch is answered
// from a finished run's downloads (its data/origins records, by requested URL) and nothing goes to the network. A URL with no record
// gets a 404 and a line in NEXT_DRIVE_FETCH_LOG, so a missing download shows as one, never as a guess.
import fs from "node:fs";
import path from "node:path";

const root = process.env.NEXT_DRIVE_FETCH_FROM;
const log = process.env.NEXT_DRIVE_FETCH_LOG;
const byUrl = new Map();
for (const name of fs.readdirSync(path.join(root, "data", "origins"))) {
  const origin = JSON.parse(fs.readFileSync(path.join(root, "data", "origins", name), "utf8"));
  byUrl.set(origin.requested_url, origin);
}
globalThis.fetch = async (input) => {
  const url = String(input?.url ?? input);
  const origin = byUrl.get(url);
  if (log) fs.appendFileSync(log, `${origin ? "local" : "missing"} ${url}\n`);
  const response = origin
    ? new Response(fs.readFileSync(path.join(root, origin.file)), { status: 200, headers: { "content-type": origin.content_type } })
    : new Response("not in the local downloads", { status: 404, headers: { "content-type": "text/plain" } });
  // A built Response has no url; the runtime reads it (the final address after redirects).
  Object.defineProperty(response, "url", { value: origin?.final_url ?? url });
  return response;
};
