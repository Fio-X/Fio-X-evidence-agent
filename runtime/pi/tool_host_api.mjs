import { validate } from "./tool_host_schema.mjs";
// Stands in for tool_api.ts inside the tool host process (tool_host.mjs): the same four exports, written as plain JSON Schema builders
// so the host needs no model-side package. Output is a plain JSON Schema object; "optional" is a hidden mark that only Type.Object reads.
const OPTIONAL = Symbol("optional");
const extra = (opts) => (opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {});
const mark = (schema) => Object.defineProperty({ ...schema }, OPTIONAL, { value: true, enumerable: false });
export const Type = {
  String: (opts) => ({ type: "string", ...extra(opts) }),
  Number: (opts) => ({ type: "number", ...extra(opts) }),
  Integer: (opts) => ({ type: "integer", ...extra(opts) }),
  Boolean: (opts) => ({ type: "boolean", ...extra(opts) }),
  Any: (opts) => ({ ...extra(opts) }),
  Literal: (value, opts) => ({ const: value, ...extra(opts) }),
  Optional: (schema) => mark(schema),
  Array: (items, opts) => ({ type: "array", items, ...extra(opts) }),
  Union: (anyOf, opts) => ({ anyOf, ...extra(opts) }),
  Object: (properties = {}, opts) => {
    const required = Object.keys(properties).filter((key) => !properties[key]?.[OPTIONAL]);
    return { type: "object", properties, ...(required.length ? { required } : {}), ...extra(opts) };
  },
};
export const StringEnum = (values, opts) => ({ type: "string", enum: [...values], ...extra(opts) });
// Compile(schema) -> { Check, Errors } over the host's own validator; Errors yields the fields the two callers read (instancePath, keyword, params, message).
const Compile = (schema) => {
  const run = (value) => validate(schema, value);
  return {
    Check: (value) => run(value).length === 0,
    *Errors(value) {
      for (const [path, message] of run(value)) {
        const parts = path === "root" ? [] : path.split(".");
        if (message === "Expected required property") yield { instancePath: `/${parts.slice(0, -1).join("/")}`, keyword: "required", params: { requiredProperties: parts.slice(-1) }, message };
        else yield { instancePath: `/${parts.join("/")}`, keyword: "type", params: {}, message };
      }
    },
  };
};
export const importTypeboxCompile = async () => ({ Compile });
