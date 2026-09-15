export async function readBodyBytes(body, maxBytes, { truncate = false } = {}) {
  if (!body) return { bytes: new Uint8Array(), truncated: false };
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive integer");
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) continue;
      if (total + value.byteLength > maxBytes) {
        const remaining = Math.max(0, maxBytes - total);
        if (remaining) chunks.push(value.subarray(0, remaining));
        total += remaining;
        truncated = true;
        await reader.cancel("newsroom byte limit reached");
        if (!truncate) throw new Error(`Response exceeds the ${maxBytes} byte limit`);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: out, truncated };
}

export async function readBodyText(body, maxChars) {
  const maxBytes = Math.max(4096, maxChars * 4);
  const { bytes, truncated: byteTruncated } = await readBodyBytes(body, maxBytes, { truncate: true });
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return { text: text.slice(0, maxChars), truncated: byteTruncated || text.length > maxChars };
}
