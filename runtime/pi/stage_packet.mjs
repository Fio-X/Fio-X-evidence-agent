import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const STAGE_PACKET_SCHEMA_VERSION = '0.1.0';
export const STAGE_PACKET_KINDS = Object.freeze([
  'evidence_ledger',
  'fact_graph',
  'claim_graph',
  'story_graph',
  'editorial_grammar',
  'infographic_spec',
]);

const SHA256 = /^[a-f0-9]{64}$/;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function packetPayload(packet) {
  return {
    schema_version: packet.schema_version,
    refs: packet.refs,
    hashes: packet.hashes,
    reason_codes: packet.reason_codes,
    allowed_scope: packet.allowed_scope,
  };
}

function packetHash(packet) {
  return digest(Buffer.from(JSON.stringify(canonical(packetPayload(packet)))));
}

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function assertPacketShape(packet) {
  if (!packet || packet.schema_version !== STAGE_PACKET_SCHEMA_VERSION) {
    throw fail('stage_packet.schema_version', `schema_version must be ${STAGE_PACKET_SCHEMA_VERSION}`);
  }
  for (const key of ['refs', 'hashes', 'reason_codes', 'allowed_scope']) {
    if (!packet[key] || typeof packet[key] !== 'object') throw fail('stage_packet.field_required', `${key} is required`);
  }
  if (!Array.isArray(packet.reason_codes) || !packet.reason_codes.every((value) => typeof value === 'string' && value.length > 0)) {
    throw fail('stage_packet.reason_codes', 'reason_codes must be a non-empty string array');
  }
  if (!Array.isArray(packet.allowed_scope) || !packet.allowed_scope.every((value) => typeof value === 'string' && value.length > 0)) {
    throw fail('stage_packet.allowed_scope', 'allowed_scope must be a non-empty string array');
  }
  if (Object.keys(packet.refs).length === 0) throw fail('stage_packet.refs', 'refs must not be empty');
  for (const kind of Object.keys(packet.refs)) {
    if (!STAGE_PACKET_KINDS.includes(kind)) throw fail('stage_packet.kind', `unsupported ref kind: ${kind}`);
    if (typeof packet.refs[kind] !== 'string' || !packet.refs[kind]) throw fail('stage_packet.ref', `invalid ref for ${kind}`);
    if (!SHA256.test(packet.hashes[kind] ?? '')) throw fail('stage_packet.hash', `invalid SHA-256 for ${kind}`);
  }
  for (const kind of Object.keys(packet.hashes)) {
    if (!Object.hasOwn(packet.refs, kind)) throw fail('stage_packet.hash_without_ref', `hash has no ref: ${kind}`);
  }
  if (packet.packet_hash !== packetHash(packet)) throw fail('stage_packet.packet_hash', 'packet hash mismatch');
}

export function createStagePacket({ artifacts, reason_codes, allowed_scope }) {
  const refs = {};
  const hashes = {};
  for (const artifact of artifacts ?? []) {
    if (!STAGE_PACKET_KINDS.includes(artifact?.kind)) throw fail('stage_packet.kind', `unsupported ref kind: ${artifact?.kind ?? ''}`);
    if (refs[artifact.kind]) throw fail('stage_packet.duplicate_kind', `duplicate ref kind: ${artifact.kind}`);
    if (typeof artifact.ref !== 'string' || artifact.ref.startsWith('/') || artifact.ref.split('/').includes('..')) {
      throw fail('stage_packet.unsafe_ref', `unsafe ref for ${artifact.kind}`);
    }
    if (!SHA256.test(artifact.hash ?? '')) throw fail('stage_packet.hash', `invalid SHA-256 for ${artifact.kind}`);
    refs[artifact.kind] = artifact.ref;
    hashes[artifact.kind] = artifact.hash;
  }
  const packet = {
    schema_version: STAGE_PACKET_SCHEMA_VERSION,
    refs,
    hashes,
    reason_codes: [...new Set(reason_codes ?? [])].sort(),
    allowed_scope: [...new Set(allowed_scope ?? [])].sort(),
  };
  packet.packet_hash = packetHash(packet);
  assertPacketShape(packet);
  return Object.freeze(packet);
}

export async function resolveStagePacket(packet, { root, scope, read = readFile } = {}) {
  assertPacketShape(packet);
  if (typeof root !== 'string' || !root) throw fail('stage_packet.root', 'root is required');
  if (scope !== undefined && (typeof scope !== 'string' || !packet.allowed_scope.includes(scope))) {
    throw fail('stage_packet.scope_violation', `scope is not allowed: ${scope ?? ''}`);
  }
  const resolved = {};
  for (const kind of Object.keys(packet.refs)) {
    const reference = packet.refs[kind];
    const absolute = path.resolve(root, reference);
    const relative = path.relative(path.resolve(root), absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw fail('stage_packet.unsafe_ref', `ref escapes root: ${reference}`);
    let bytes;
    try {
      bytes = await read(absolute);
    } catch {
      throw fail('stage_packet.missing_ref', `referenced artifact is unavailable: ${kind}`);
    }
    const actual = digest(bytes);
    if (actual !== packet.hashes[kind]) throw fail('stage_packet.hash_mismatch', `referenced artifact hash mismatch: ${kind}`);
    resolved[kind] = { ref: reference, hash: actual, absolute };
  }
  return { packet_hash: packet.packet_hash, scope, resolved };
}

export function serializedBoundaryBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

export function validateStagePacket(packet) {
  try {
    assertPacketShape(packet);
    return { passed: true, issues: [] };
  } catch (error) {
    return { passed: false, issues: [{ code: error.code ?? 'stage_packet.invalid', message: error.message }] };
  }
}
