// Shared, pure SVG parsing primitives for the render_qa_*.mjs family of
// deterministic, browser-free checks (render_qa_contrast.mjs,
// render_qa_geometry.mjs). No DOM, no browser, no network, no new
// dependency: a small XML tokenizer and a 2D affine transform engine, split
// out of render_qa_contrast.mjs (where they were first written and proven
// against real rendered SVG) so render_qa_geometry.mjs's T6a transform work
// can reuse the same tested code instead of re-deriving it. Moving this code
// here does not change its behaviour: render_qa_contrast.mjs imports these
// exact functions back and its own test suite (test_render_qa_contrast.mjs)
// is unchanged.

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&#x27;": "'" };

// ---------------------------------------------------------------------------
// Tiny XML tokenizer -> tree. Not a general XML parser: it assumes
// well-formed, double/single-quoted attributes (as every renderer in this
// repo emits), no processing instructions beyond comments/doctype/CDATA.
// ---------------------------------------------------------------------------

export function decodeEntities(s) {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/g, (m) => ENTITIES[m] ?? m);
}

export function parseAttrs(str) {
  const attrs = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(str))) {
    const value = m[3] !== undefined ? m[3] : m[4];
    attrs[m[1]] = decodeEntities(value ?? "");
  }
  return attrs;
}

export function parseXml(text) {
  const clean = String(text ?? "")
    .replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length))
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => " ".repeat(m.length))
    .replace(/<!DOCTYPE[^>]*>/gi, (m) => " ".repeat(m.length));
  const root = { tag: "#root", attrs: {}, children: [], parent: null, docIndex: -1, text: "" };
  const stack = [root];
  const tagRe = /<(\/?)([a-zA-Z_][\w:.-]*)((?:\s+[^<>]*?)?)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = tagRe.exec(clean))) {
    if (m[5] !== undefined) {
      const parent = stack[stack.length - 1];
      parent.text += parent.tag === "style" || parent.tag === "script" ? m[5] : decodeEntities(m[5]);
      continue;
    }
    const tag = m[2];
    if (m[1] === "/") {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) { stack.length = k; break; }
      }
      continue;
    }
    const node = { tag, attrs: parseAttrs(m[3] || ""), children: [], parent: stack[stack.length - 1], docIndex: m.index, text: "" };
    stack[stack.length - 1].children.push(node);
    if (m[4] !== "/") stack.push(node);
  }
  return root;
}

export function hasAncestorIn(node, set) {
  for (let n = node.parent; n; n = n.parent) if (set.has(n.tag)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 2D affine transform resolution (translate/scale/rotate/skewX/skewY/matrix),
// composed across the ancestor chain. This is exact math, not an
// approximation: any unresolved link (unparseable function, wrong arg count,
// singular matrix) is threaded through as `null` and reported as unmeasured
// rather than guessed.
// ---------------------------------------------------------------------------

export const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function multiply(m1, m2) {
  // Matrix that represents "apply m1 first, then m2".
  return {
    a: m2.a * m1.a + m2.c * m1.b,
    b: m2.b * m1.a + m2.d * m1.b,
    c: m2.a * m1.c + m2.c * m1.d,
    d: m2.b * m1.c + m2.d * m1.d,
    e: m2.a * m1.e + m2.c * m1.f + m2.e,
    f: m2.b * m1.e + m2.d * m1.f + m2.f,
  };
}

export function invert(m) {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

export function apply(m, x, y) {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

export function translate(tx, ty) { return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty }; }
export function scaleFn(sx, sy) { return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }; }
export function skewX(deg) { return { a: 1, b: 0, c: Math.tan((deg * Math.PI) / 180), d: 1, e: 0, f: 0 }; }
export function skewY(deg) { return { a: 1, b: Math.tan((deg * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 }; }
export function rotateFn(deg, cx, cy) {
  const rad = (deg * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const origin = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
  if (!cx && !cy) return origin;
  return multiply(translate(-cx, -cy), multiply(origin, translate(cx, cy)));
}

export function parseTransformList(str) {
  const fns = [];
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let m, consumed = 0;
  while ((m = re.exec(str))) {
    if (str.slice(consumed, m.index).trim() !== "") return null;
    const argsStr = m[2].trim();
    const args = argsStr.length ? argsStr.split(/[,\s]+/).map(Number) : [];
    if (args.some((n) => !Number.isFinite(n))) return null;
    fns.push({ name: m[1], args });
    consumed = re.lastIndex;
  }
  if (str.slice(consumed).trim() !== "") return null;
  return fns;
}

export function functionToMatrix(fn) {
  const a = fn.args;
  switch (fn.name) {
    case "translate": return a.length === 1 ? translate(a[0], 0) : a.length === 2 ? translate(a[0], a[1]) : null;
    case "scale": return a.length === 1 ? scaleFn(a[0], a[0]) : a.length === 2 ? scaleFn(a[0], a[1]) : null;
    case "rotate": return a.length === 1 ? rotateFn(a[0], 0, 0) : a.length === 3 ? rotateFn(a[0], a[1], a[2]) : null;
    case "skewX": return a.length === 1 ? skewX(a[0]) : null;
    case "skewY": return a.length === 1 ? skewY(a[0]) : null;
    case "matrix": return a.length === 6 ? { a: a[0], b: a[1], c: a[2], d: a[3], e: a[4], f: a[5] } : null;
    default: return null;
  }
}

export function ownTransformMatrix(node) {
  const raw = node.attrs.transform;
  if (raw === undefined) return IDENTITY;
  const fns = parseTransformList(raw);
  if (fns === null) return null;
  let acc = IDENTITY;
  for (let i = fns.length - 1; i >= 0; i--) {
    const fm = functionToMatrix(fns[i]);
    if (!fm) return null;
    acc = multiply(acc, fm);
  }
  return acc;
}
