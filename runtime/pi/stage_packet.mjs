import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const STAGE_PACKET_SCHEMA_VERSION = '0.2.0';
const SHA256 = /^[a-f0-9]{64}$/;
const REF_KINDS = Object.freeze(['evidence', 'plan', 'claims', 'tools', 'events']);

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function packetHash(packet) {
  return digest(Buffer.from(JSON.stringify(canonical({
    schema_version: packet.schema_version, goal: packet.goal, refs: packet.refs, hashes: packet.hashes,
    passed_gates: packet.passed_gates, remaining_gaps: packet.remaining_gaps, required_visual_modes: packet.required_visual_modes,
  }))));
}
function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function assertPacketShape(packet) {
  if (!packet || packet.schema_version !== STAGE_PACKET_SCHEMA_VERSION) throw fail('retry_packet.schema_version', `schema_version must be ${STAGE_PACKET_SCHEMA_VERSION}`);
  if (typeof packet.goal !== 'string' || packet.goal.length === 0) throw fail('retry_packet.goal', 'goal is required');
  for (const key of ['refs', 'hashes', 'passed_gates', 'remaining_gaps', 'required_visual_modes']) if (!packet[key] || typeof packet[key] !== 'object') throw fail('retry_packet.field_required', `${key} is required`);
  for (const key of ['passed_gates', 'remaining_gaps', 'required_visual_modes']) if (!Array.isArray(packet[key]) || !packet[key].every((value) => typeof value === 'string')) throw fail('retry_packet.array', `${key} must be a string array`);
  for (const kind of Object.keys(packet.refs)) {
    if (!REF_KINDS.includes(kind)) throw fail('retry_packet.kind', `unsupported ref kind: ${kind}`);
    const ref = packet.refs[kind];
    if (typeof ref !== 'string' || ref.startsWith('/') || ref.split('/').includes('..')) throw fail('retry_packet.unsafe_ref', `unsafe ref for ${kind}`);
    if (!SHA256.test(packet.hashes[kind] ?? '')) throw fail('retry_packet.hash', `invalid hash for ${kind}`);
  }
  for (const kind of Object.keys(packet.hashes)) if (!Object.hasOwn(packet.refs, kind)) throw fail('retry_packet.hash_without_ref', `hash has no ref: ${kind}`);
  if (packet.packet_hash !== packetHash(packet)) throw fail('retry_packet.packet_hash', 'packet hash mismatch');
}
export function createRetryContextPacket({ goal, refs, hashes, passed_gates, remaining_gaps, required_visual_modes }) {
  const packet = { schema_version: STAGE_PACKET_SCHEMA_VERSION, goal, refs: { ...refs }, hashes: { ...hashes },
    passed_gates: [...new Set(passed_gates ?? [])].sort(), remaining_gaps: [...new Set(remaining_gaps ?? [])].sort(), required_visual_modes: [...new Set(required_visual_modes ?? [])].sort() };
  packet.packet_hash = packetHash(packet); assertPacketShape(packet); return Object.freeze(packet);
}
export async function resolveRetryContextPacket(packet, { root, read = readFile } = {}) {
  assertPacketShape(packet); if (typeof root !== 'string' || !root) throw fail('retry_packet.root', 'root is required');
  const resolved = {};
  for (const kind of Object.keys(packet.refs)) {
    const absolute = path.resolve(root, packet.refs[kind]); const relative = path.relative(path.resolve(root), absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw fail('retry_packet.unsafe_ref', `ref escapes root: ${packet.refs[kind]}`);
    let bytes; try { bytes = await read(absolute); } catch { throw fail('retry_packet.missing_ref', `referenced artifact is unavailable: ${kind}`); }
    if (digest(bytes) !== packet.hashes[kind]) throw fail('retry_packet.hash_mismatch', `referenced artifact hash mismatch: ${kind}`);
    resolved[kind] = { ref: packet.refs[kind], hash: packet.hashes[kind], absolute };
  }
  return { packet_hash: packet.packet_hash, resolved };
}
export function serializedBoundaryBytes(value) { return Buffer.byteLength(JSON.stringify(value)); }
export function validateRetryContextPacket(packet) { try { assertPacketShape(packet); return { passed: true, issues: [] }; } catch (error) { return { passed: false, issues: [{ code: error.code ?? 'retry_packet.invalid', message: error.message }] }; } }
