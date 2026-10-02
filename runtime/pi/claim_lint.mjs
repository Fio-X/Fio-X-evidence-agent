// Opt-in lint for the SQL and the sentence of a claim (NEWSROOM_CLAIM_SQL_LINT=1).
// The claim sentence is filled from the rows of its SQL, so a number typed into
// that SQL as a constant would reach the sentence as if the data held it. The
// lint reads DuckDB's own parse (json_serialize_sql) and only ever refuses.
import { FILE_READER_FUNCTIONS } from "./computation_rows.mjs";

const NUMERIC_TYPES = new Set(["TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT", "FLOAT", "DOUBLE", "DECIMAL"]);
const ROUNDERS = new Set(["round", "trunc", "truncate"]);

const isNode = (value) => value !== null && typeof value === "object";

function constantNumber(expr) {
  const v = expr.value;
  if (!isNode(v) || v.is_null !== false) return null;
  const raw = Number(v.value);
  if (!Number.isFinite(raw)) return null;
  const scale = v.type?.id === "DECIMAL" ? Number(v.type?.type_info?.scale ?? 0) : 0;
  return raw / 10 ** scale;
}

function isPowerOfTen(expr) {
  if (expr?.class !== "CONSTANT" || !NUMERIC_TYPES.has(expr.value?.type?.id)) return false;
  const n = constantNumber(expr);
  if (n === null || n <= 0) return false;
  const k = Math.round(Math.log10(n));
  return Math.abs(k) <= 12 && Math.abs(n - 10 ** k) <= Math.abs(n) * 1e-9;
}

function mentionsData(expr) {
  if (!isNode(expr)) return false;
  if (expr.class === "COLUMN_REF" || expr.class === "STAR") return true;
  if (expr.class === "SUBQUERY") return true;
  return Object.values(expr).some((child) => (Array.isArray(child) ? child.some(mentionsData) : mentionsData(child)));
}

function render(expr) {
  if (!isNode(expr)) return String(expr);
  switch (expr.class) {
    case "CONSTANT": {
      const v = expr.value;
      if (v?.is_null) return "NULL";
      return v?.type?.id === "VARCHAR" ? `'${v.value}'` : String(constantNumber(expr) ?? v?.value);
    }
    case "COLUMN_REF": return (expr.column_names ?? []).join(".");
    case "STAR": return "*";
    case "FUNCTION": {
      const kids = (expr.children ?? []).map(render);
      return expr.is_operator && kids.length === 2 ? `(${kids[0]} ${expr.function_name} ${kids[1]})` : `${expr.function_name}(${kids.join(", ")})`;
    }
    case "CAST": return `CAST(${render(expr.child)} AS ${expr.cast_type?.id ?? "?"})`;
    case "SUBQUERY": return "(subquery)";
    default: return String(expr.class ?? "expression").toLowerCase();
  }
}

// Constants an expression of a select list holds. A constant is a number the
// data does not hold, unless it is a unit step: ROUND/TRUNC precision, or a
// power of ten that scales a value taken from the data.
function constantsIn(expr, found) {
  if (!isNode(expr)) return;
  if (Array.isArray(expr)) { for (const item of expr) constantsIn(item, found); return; }
  if (expr.class === "SUBQUERY") return; // its own select list is walked as a node
  if (expr.class === "CONSTANT") {
    const v = expr.value;
    if (!isNode(v) || v.is_null !== false) return;
    const id = v.type?.id;
    if (NUMERIC_TYPES.has(id)) found.push(expr);
    else if (id === "VARCHAR" && /\d/.test(String(v.value))) found.push(expr);
    return;
  }
  if (expr.class === "FUNCTION") {
    const kids = expr.children ?? [];
    const name = String(expr.function_name ?? "").toLowerCase();
    kids.forEach((child, index) => {
      if (ROUNDERS.has(name) && index === 1 && child?.class === "CONSTANT" && NUMERIC_TYPES.has(child.value?.type?.id) && Number.isInteger(constantNumber(child))) return;
      if ((name === "*" || name === "/") && kids.length === 2 && isPowerOfTen(child) && mentionsData(kids[1 - index])) return;
      constantsIn(child, found);
    });
    for (const key of ["filter", "order_bys", "window"]) if (expr[key] !== undefined) constantsIn(expr[key], found);
    return;
  }
  for (const [key, child] of Object.entries(expr)) if (isNode(child) && key !== "type" && key !== "value") constantsIn(child, found);
}

/** Violations in a json_serialize_sql AST, as sentences that name the
 *  expression. Empty when the SQL passes. */
export function lintClaimSqlAst(ast) {
  const out = [];
  if (!ast || ast.error) return ["the SQL could not be parsed"];
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!isNode(node)) return;
    if (node.type === "SELECT_NODE" && Array.isArray(node.select_list)) {
      for (const item of node.select_list) {
        const found = [];
        constantsIn(item, found);
        if (found.length) out.push(`the select-list expression ${render(item)}${item.alias ? ` (AS ${item.alias})` : ""} holds the constant ${render(found[0])}; a number in a claim's SQL must come from the data, not be typed into the query`);
      }
    }
    if (node.type === "TABLE_FUNCTION") {
      const name = String(node.function?.function_name ?? "").toLowerCase();
      if (!FILE_READER_FUNCTIONS.has(name)) out.push(`the table function ${name || "?"}() generates rows; only a data file reader (read_csv, read_json, read_parquet ...) may feed a claim`);
    }
    if (node.type === "EXPRESSION_LIST") out.push("a VALUES list types rows into the query; the rows of a claim must come from a data file");
    for (const child of Object.values(node)) visit(child);
  };
  visit(ast.statements ?? ast);
  return out;
}

const LOW_WORDS = /\b(lowest|least|smallest|fewest)\b|最低|最少|最小/i;
const HIGH_WORDS = /\b(highest|most|largest|greatest)\b|最高|最多|最大/i;

/** In one clause (split on , . ; and their full-width forms) a max.* placeholder
 *  may not sit next to a low word, nor a min.* next to a high word. */
export function lintClaimTemplate(template) {
  const out = [];
  // A placeholder holds dots of its own: swap it for a marker before splitting.
  const marked = String(template ?? "").replace(/\{\s*([^{}]*?)\s*\}/g, (_, body) => (/^max\./.test(body) ? "\u0001MAX\u0001" : /^min\./.test(body) ? "\u0001MIN\u0001" : "\u0001"));
  for (const clause of marked.split(/[,.;，。；]/)) {
    const shown = clause.replace(/\u0001(MAX|MIN)\u0001/g, (_, k) => `{${k.toLowerCase()}.…}`).replace(/\u0001/g, "{…}").trim();
    if (clause.includes("\u0001MAX\u0001") && LOW_WORDS.test(clause)) out.push(`the clause "${shown}" puts a max placeholder next to a word for the lowest value; use min, or change the words`);
    if (clause.includes("\u0001MIN\u0001") && HIGH_WORDS.test(clause)) out.push(`the clause "${shown}" puts a min placeholder next to a word for the highest value; use max, or change the words`);
  }
  return out;
}
