import { createHash } from "node:crypto";

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function sourceContentHash({ finalUrl, status, contentType, truncated, text }) {
  return sha256Hex(JSON.stringify({ content_type: contentType, final_url: finalUrl, status, text, truncated }));
}

export function datasetRelativePath(bytes, extension) {
  const ext = /^[a-z0-9]{1,8}$/i.test(String(extension ?? "")) ? String(extension).toLowerCase() : "data";
  const hash = sha256Hex(bytes);
  return { sha256: hash, relativeFile: `data/${hash}.${ext}` };
}

export function computationRelativePath(sql, inputSnapshotHash, resultHash) {
  const key = sha256Hex(`${sql}\n${inputSnapshotHash}\n${resultHash}`);
  return `computations/${key}.json`;
}
