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

/** Validation errors as [path, message]; empty when the value fits. */
export function validate(schema, value, path = "") {
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
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}${path ? "." : ""}${i}`)));
  }
  if (kindOf(value) === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push([`${path}${path ? "." : ""}${key}`, "Expected required property"]);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in value) errors.push(...validate(sub, value[key], `${path}${path ? "." : ""}${key}`));
    const extraKeys = Object.keys(value).filter((key) => !(schema.properties ?? {})[key]);
    const at = (key) => `${path}${path ? "." : ""}${key}`;
    if (schema.additionalProperties === false) for (const key of extraKeys) errors.push([at(key), "Unexpected property"]);
    else if (schema.additionalProperties && typeof schema.additionalProperties === "object") for (const key of extraKeys) errors.push(...validate(schema.additionalProperties, value[key], at(key)));
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
  const errors = validate(schema, normalized);
  if (errors.length === 0) return { ok: true, args: normalized };
  const lines = errors.map(([path, message]) => `  - ${path}: ${message}`).join("\n");
  return { ok: false, text: `Tool "${name}" rejected its arguments:\n${lines}\n\nArguments as sent:\n${JSON.stringify(raw, null, 2)}` };
}
