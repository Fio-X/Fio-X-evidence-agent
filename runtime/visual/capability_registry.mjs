import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CAPABILITIES_PATH = path.join(ROOT, 'config', 'visual-capabilities.json');
const EXTERNAL_PATH = path.join(ROOT, 'config', 'external-visual-adapters.json');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function visualCapabilityRegistry() { return readJson(CAPABILITIES_PATH); }
export function externalVisualAdapterRegistry() { return readJson(EXTERNAL_PATH); }
export function capabilityIntent(name) {
  const registry = visualCapabilityRegistry();
  const intent = registry.intents?.[name];
  if (!intent) throw new Error(`unknown visual capability intent: ${name}`);
  return structuredClone(intent);
}
export function validateCapabilityRegistry() {
  const registry = visualCapabilityRegistry();
  const errors = [];
  if (!['0.1.0','0.2.0'].includes(registry.schema_version)) errors.push('visual capability registry schema_version must be 0.1.0 or 0.2.0');
  for (const [name, intent] of Object.entries(registry.intents ?? {})) {
    if (!Array.isArray(intent.topology) || !intent.topology.length) errors.push(`${name}: topology required`);
    if (!Array.isArray(intent.requires) || !intent.requires.length) errors.push(`${name}: requires required`);
    if (!Array.isArray(intent.preferred_backends) || !intent.preferred_backends.length) errors.push(`${name}: preferred_backends required`);
  }
  const external = externalVisualAdapterRegistry();
  for (const [name, adapter] of Object.entries(external.adapters ?? {})) {
    if (!['contract_only', 'qualified', 'disabled'].includes(adapter.status)) errors.push(`${name}: invalid adapter status`);
  }
  return errors;
}
