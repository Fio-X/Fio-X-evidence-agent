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

// RFC 2544 reserves 198.18.0.0/15 for benchmarking. Transparent proxy/TUN
// clients commonly use that range for synthetic DNS answers ("fake IPs") and
// route the ensuing TLS connection by its original hostname. Treating every
// such answer as an SSRF target makes all external evidence fetching fail on
// those systems. We only permit this range for DNS-resolved HTTPS hostnames;
// literal IP URLs and plain HTTP remain blocked by the caller.
export function isBenchmarkProxyIp(ip) {
  const value = String(ip ?? "").toLowerCase();
  if (value.startsWith("::ffff:")) return isBenchmarkProxyIp(value.slice(7));
  const parts = value.split(".").map(Number);
  return parts.length === 4
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 198
    && (parts[1] === 18 || parts[1] === 19);
}

export function isPrivateIpAddress(ip) {
  const value = String(ip ?? "").toLowerCase();
  if (value === "::1" || value === "::") return true;
  if (value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) return true;
  if (value.startsWith("::ffff:")) return isPrivateIpAddress(value.slice(7));
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return (
    a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || isBenchmarkProxyIp(value)
    || a >= 224
  );
}

export function assertResolvedAddressesSafe(addresses, protocol) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error("Host did not resolve to an address");
  }
  for (const entry of addresses) {
    const address = typeof entry === "string" ? entry : entry?.address;
    if (!address) throw new Error("Host returned an unsupported network address");
    if (isBenchmarkProxyIp(address)) {
      if (protocol !== "https:") {
        throw new Error("Benchmark proxy DNS addresses require HTTPS");
      }
      continue;
    }
    if (isPrivateIpAddress(address)) {
      throw new Error("Host resolves to a private, local, or unsupported network address");
    }
  }
}
