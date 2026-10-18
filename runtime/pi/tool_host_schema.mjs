// Argument conversion and validation for the tool host (agent-spec 10.1, 10.2). Conversion runs first, then the schema check; a failure
// is returned as text in the fixed error format and the tool is not run. Only the schema keywords the registered tools use are
// understood; any other validation keyword makes the check fail closed (unsupportedKeywords lists them) instead of being ignored.
const ANNOTATIONS = new Set(["description", "title", "default", "examples", "$comment", "label"]);
const KNOWN = new Set(["type", "properties", "required", "additionalProperties", "items", "anyOf", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "pattern", ...ANNOTATIONS]);

export function unsupportedKeywords(schema, path = "root", out = []) {
  if (!schema || typeof schema !== "object") return out;
  for (const key of Object.keys(schema)) if (!KNOWN.has(key)) out.push(`${path}: ${key}`);
  for (const [name, sub] of Object.entries(schema.properties ?? {})) unsupportedKeywords(sub, `${path === "root" ? "" : `${path}.`}${name}`, out);
  if (schema.items) unsupportedKeywords(schema.items, `${path}[]`, out);
  (schema.anyOf ?? []).forEach((sub, i) => unsupportedKeywords(sub, `${path}|${i}`, out));
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") unsupportedKeywords(schema.additionalProperties, `${path}{}`, out);
  return out;
}

const kindOf = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
const matchesType = (schema, value) => {
  if (!schema.type) return true;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const kind = kindOf(value);
  return types.some((t) => t === kind || (t === "integer" && kind === "number" && Number.isInteger(value)));
};

const ENUM_SHOWN = 12;
/** What the schema expects of a property, from the schema only (never from the arguments): "(string; one of "a", "b")". Empty when it says nothing. */
export function expectedShape(sub) {
  if (!sub || typeof sub !== "object") return "";
  const parts = [];
  if (sub.type) {
    const types = [].concat(sub.type).join(" or ");
    parts.push(types === "array" && sub.items?.type ? `array of ${[].concat(sub.items.type).join(" or ")}` : types);
  } else if (sub.anyOf) parts.push("one of several shapes");
  if (Array.isArray(sub.enum)) {
    const shown = sub.enum.slice(0, ENUM_SHOWN).map((v) => JSON.stringify(v)).join(", ");
    parts.push(`one of ${shown}${sub.enum.length > ENUM_SHOWN ? ` (+${sub.enum.length - ENUM_SHOWN} more)` : ""}`);
  }
  if ("const" in sub) parts.push(`const ${JSON.stringify(sub.const)}`);
  return parts.length ? ` (${parts.join("; ")})` : "";
}

/** "0,3,5..9": runs of three or more become a..b. */
const indexList = (numbers) => {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b), out = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    if (j - i >= 2) out.push(`${sorted[i]}..${sorted[j]}`); else for (let k = i; k <= j; k++) out.push(String(sorted[k]));
    i = j + 1;
  }
  return out.join(",");
};

/**
 * Error lines for the model. Wording only: one line per error, except that lines identical apart from array indexes are folded into one
 * ("items[0,3,5..9].x: message") when the folded indexes are exactly the combinations that failed. The error list itself is untouched.
 */
export function errorLines(errors, notes) {
  const split = (path) => {
    const segs = path === "root" ? [] : path.split(".");
    const index = segs.map((seg, k) => /^\d+$/.test(seg) && notes.arrays.has(segs.slice(0, k).join(".")));
    return { segs, index };
  };
  const text = ([path, message]) => `${message}${message === "Expected required property" ? (notes.expected.get(path) ?? "") : ""}`;
  const groups = new Map(), order = [];
  errors.forEach((error, n) => {
    const { segs, index } = split(error[0]);
    const key = index.some(Boolean) ? JSON.stringify([segs.map((s, k) => (index[k] ? "*" : s)), text(error)]) : `single:${n}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push({ error, segs, index });
  });
  const lines = [];
  for (const key of order) {
    const members = groups.get(key), { segs, index } = members[0];
    const positions = index.flatMap((is, k) => (is ? [k] : []));
    const tuples = members.map((m) => positions.map((k) => Number(m.segs[k])));
    const sets = positions.map((_, c) => new Set(tuples.map((t) => t[c])));
    const product = sets.reduce((n, s) => n * s.size, 1);
    if (members.length > 1 && positions.length > 0 && product === members.length) {
      let out = "";
      segs.forEach((seg, k) => {
        const at = positions.indexOf(k);
        if (at >= 0) out += `[${indexList([...sets[at]])}]`; else out += `${out ? "." : ""}${seg}`;
      });
      lines.push(`  - ${out}: ${text(members[0].error)}`);
    } else for (const m of members) lines.push(`  - ${m.error[0]}: ${text(m.error)}`);
  }
  return lines;
}

/**
 * Validation errors as [path, message]; empty when the value fits. `notes` (optional, { arrays: Set, expected: Map }) only collects wording
 * aids for validationFailure: the paths that hold arrays and the schema's expected shape of each missing required property. It never
 * changes the returned errors.
 */
export function validate(schema, value, path = "", notes = null) {
  const here = path || "root";
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;
  if (schema.anyOf) {
    const branches = schema.anyOf.map((sub) => validate(sub, value, path));
    if (!branches.some((errs) => errs.length === 0)) errors.push([here, "Expected union value"]);
    return errors;
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push([here, `Expected ${JSON.stringify(schema.const)}`]);
  if (schema.enum && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) errors.push([here, `Expected one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`]);
  if (!matchesType(schema, value)) { errors.push([here, `Expected ${[].concat(schema.type).join(" or ")}`]); return errors; }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push([here, `Expected number >= ${schema.minimum}`]);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push([here, `Expected number <= ${schema.maximum}`]);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push([here, `Expected number > ${schema.exclusiveMinimum}`]);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push([here, `Expected number < ${schema.exclusiveMaximum}`]);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push([here, `Expected string length >= ${schema.minLength}`]);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push([here, `Expected string length <= ${schema.maxLength}`]);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push([here, `Expected string to match ${schema.pattern}`]);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push([here, `Expected array length >= ${schema.minItems}`]);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push([here, `Expected array length <= ${schema.maxItems}`]);
    if (schema.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push([here, "Expected array items to be unique"]);
    notes?.arrays.add(path);
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}${path ? "." : ""}${i}`, notes)));
  }
  if (kindOf(value) === "object") {
    for (const key of schema.required ?? []) {
      if (key in value) continue;
      const at = `${path}${path ? "." : ""}${key}`;
      errors.push([at, "Expected required property"]);
      notes?.expected.set(at, expectedShape(schema.properties?.[key]));
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in value) errors.push(...validate(sub, value[key], `${path}${path ? "." : ""}${key}`, notes));
    const extraKeys = Object.keys(value).filter((key) => !(schema.properties ?? {})[key]);
    const at = (key) => `${path}${path ? "." : ""}${key}`;
    if (schema.additionalProperties === false) for (const key of extraKeys) errors.push([at(key), "Unexpected property"]);
    else if (schema.additionalProperties && typeof schema.additionalProperties === "object") for (const key of extraKeys) errors.push(...validate(schema.additionalProperties, value[key], at(key), notes));
  }
  return errors;
}

const NULL_FILL = { string: "", number: 0, integer: 0, boolean: false };
function convertScalar(schema, value, required) {
  const wanted = [].concat(schema.type ?? []);
  if (value === null) return required && wanted.length === 1 && wanted[0] in NULL_FILL ? NULL_FILL[wanted[0]] : value;
  if (matchesType(schema, value)) return value;
  if (typeof value === "string") {
    const text = value.trim();
    if ((wanted.includes("number") || wanted.includes("integer")) && text !== "" && Number.isFinite(Number(text))) return Number(text);
    if (wanted.includes("boolean") && (text === "true" || text === "false")) return text === "true";
  }
  if (wanted.includes("string") && (typeof value === "number" || typeof value === "boolean")) return String(value);
  return value;
}

/** Converts the raw arguments toward the schema (nulls on optional fields dropped, scalars coerced); the result is then validated. */
export function convert(schema, value, required = true) {
  if (!schema || typeof schema !== "object") return value;
  if (schema.anyOf) {
    if (schema.anyOf.some((sub) => validate(sub, value).length === 0)) return value;
    for (const sub of schema.anyOf) { const next = convert(sub, value, required); if (validate(sub, next).length === 0) return next; }
    return value;
  }
  if (Array.isArray(value) && schema.items) return value.map((item) => convert(schema.items, item, true));
  if (kindOf(value) === "object" && schema.properties) {
    const needed = new Set(schema.required ?? []);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const sub = schema.properties[key];
      if (item === null && !needed.has(key)) continue;
      out[key] = sub ? convert(sub, item, needed.has(key)) : item;
    }
    return out;
  }
  return convertScalar(schema, value, required);
}

export function validationFailure(name, schema, raw) {
  const normalized = convert(schema, raw);
  const notes = { arrays: new Set(), expected: new Map() };
  const errors = validate(schema, normalized, "", notes);
  if (errors.length === 0) return { ok: true, args: normalized };
  const lines = errorLines(errors, notes).join("\n");
  return { ok: false, text: `Tool "${name}" rejected its arguments:\n${lines}\n\nArguments as sent:\n${JSON.stringify(raw, null, 2)}` };
}
