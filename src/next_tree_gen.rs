//! New route, visual group: the page tree generator (P4a, plan B; prototype gen_tree.py of the design). Two steps, both
//! generic: no node or chart name is written here, every name comes from the registry (runtime/page_tree/node-bindings.json)
//! or the flow's page input.
//!   declare  during the flow's fill, for a layer its recipe binds external: what the flow's Filled takes from it (the rows it
//!            draws, the facts and the format it declares, its hero data with every select resolved), from the registry's
//!            `declares` over the page input; every select is recomputed by the core (next_tree::recheck), never taken from
//!            the flow, and the flow's own pick must equal the core's.
//!   tree     once the fill is done: the page tree the core checks (C1-C5) and asks the external nodes over (B0-B7): the
//!            fill's texts as runs, its facts with each literal chosen code written as a select reference, the external
//!            layers' nodes from their declarations, the registry's checks. Layers the registry leaves rust stay out of it,
//!            their drawn rows too.
//! The page input (page_input in next_run.rs) is plain data the flow already holds: {recipe, order, shape{main, place, year,
//! unit, fmt, suffix, countries}, picks{rules, ranked, marks, t0, t1}, rows, name_kind}, and for a layer the registry lays
//! out in a view frame the map points and the extent the flow computed ({points, page{ext}}); a template in the registry
//! reads it only by PAGE_IN_PATHS. A node's declaration is its recipe's (declares_by_recipe) when the registry gives one.

use crate::next_tree::{self as core, st, Got, J};
use std::collections::BTreeSet;
use serde_json::Value;

/// The page input paths a declaration template may read (`$shape.main`, ...); nothing else is substituted.
const PAGE_IN_PATHS: [&str; 11] = [
    "shape.main", "shape.place", "shape.year", "shape.fmt", "shape.suffix", "shape.countries", "picks.marks", "picks.t0", "page.ext", "fill.accent",
    "fmt.change",
];

/// A template with every `$path` (a string value or an object key) read from the page input by PAGE_IN_PATHS.
fn sub(v: &J, page_in: &J) -> Result<J, String> {
    Ok(match v {
        J::Str(s) if s.starts_with('$') => {
            let path = &s[1..];
            if !PAGE_IN_PATHS.contains(&path) {
                return Err(format!("template path {s} is not a page input path the generator reads"));
            }
            let mut x = page_in;
            for p in path.split('.') {
                x = x.get(p).ok_or_else(|| format!("template path {s}: the page input has no {p}"))?;
            }
            x.clone()
        }
        J::Obj(m) => J::Obj(
            m.iter()
                .map(|(k, x)| {
                    let key = if k.starts_with('$') { st(&sub(&J::Str(k.clone()), page_in)?) } else { k.clone() };
                    Ok((key, sub(x, page_in)?))
                })
                .collect::<Result<_, String>>()?,
        ),
        J::Arr(a) => J::Arr(a.iter().map(|x| sub(x, page_in)).collect::<Result<_, String>>()?),
        v => v.clone(),
    })
}

/// The page's selects: the shape's countries and each pick rule the recipe names, as the registry's select declaration
/// (`picks`), with the results given rather than computed (the claims' marks). A pick rule with no declaration refuses:
/// the core could not recompute it.
fn selects_of(page_in: &J, reg: &J) -> Result<(Vec<J>, Given), String> {
    let (mut out, mut given) = (Vec::new(), Vec::new());
    let rules = std::iter::once(J::str("countries")).chain(page_in.g("picks").g("rules").arr().iter().cloned());
    for rule in rules {
        let rule = st(&rule);
        let decl = reg.g("picks").get(&rule).ok_or_else(|| format!("pick rule {rule}: the registry declares no select the core recomputes"))?;
        let s = sub(&J::Obj(decl.obj().iter().filter(|(k, _)| k != "given").cloned().collect()), page_in)?;
        if let Some(g) = decl.get("given") {
            given.push((st(s.g("id")), sub(g, page_in)?));
        }
        out.push(s);
    }
    Ok((out, given))
}

/// The select results given rather than computed, by select id.
type Given = Vec<(String, J)>;

fn given_of<'a>(given: &'a [(String, J)], id: &str) -> Option<&'a J> {
    given.iter().find(|(k, _)| k == id).map(|(_, v)| v)
}

fn with_result(s: &J, result: J) -> J {
    let mut s = s.clone();
    s.set("result", result);
    s
}

/// The core's own select results over the page input's rows, two passes (the first computes, the second holds every
/// result to its recomputation), and the flow's own pick of each select held to the core's. (failures, results)
fn recompute(page_in: &J, sels: &[J], given: &[(String, J)]) -> (Vec<String>, Got) {
    let page = |items: Vec<J>| {
        J::obj_of(vec![
            ("kind", J::str("Page")),
            ("selects", J::obj_of(vec![("kind", J::str("Selects")), ("items", J::Arr(items))])),
            (
                "facts",
                J::obj_of(vec![
                    ("kind", J::str("Facts")),
                    ("tables", J::Obj(vec![])),
                    ("rows", page_in.g("rows").clone()),
                    ("facts", J::Obj(vec![])),
                    ("fmts", J::Obj(vec![])),
                ]),
            ),
            ("checks", J::obj_of(vec![("kind", J::str("Checks")), ("items", J::Arr(vec![]))])),
        ])
    };
    let id = |s: &J| st(s.g("id"));
    let first = sels.iter().map(|s| with_result(s, given_of(given, &id(s)).cloned().unwrap_or(J::Arr(vec![])))).collect();
    let (_, got, _) = core::recheck(&page(first));
    let second = sels
        .iter()
        .map(|s| with_result(s, given_of(given, &id(s)).or_else(|| got.get(&id(s))).cloned().unwrap_or(J::Arr(vec![]))))
        .collect();
    let (mut bad, got, _) = core::recheck(&page(second));
    for (rule, held) in page_in.g("picks").obj() {
        if rule != "rules" && held.is_arr() && given_of(given, rule).is_none() {
            if let Some(mine) = got.get(rule) {
                if held != mine {
                    bad.push(format!("pick {rule}: the flow holds {}, the core's select {rule} computes {}", held.repr(), mine.repr()));
                }
            }
        }
    }
    (bad, got)
}

/// A node's declaration on the page input's recipe: the recipe's own (declares_by_recipe) when the registry gives one.
fn declares<'a>(reg: &'a J, layer: &str, page_in: &J) -> Result<&'a J, String> {
    let n = reg.g("nodes").g(layer);
    let own = page_in.g("recipe").s().and_then(|r| n.g("declares_by_recipe").get(r));
    own.or_else(|| n.get("declares")).ok_or_else(|| format!("node {layer}: the registry declares nothing for it"))
}

/// The external layer's node in the page tree, from its registry declaration; its items by the core's generic expansion.
/// Before the fill is done (`after` none) a field tied to a bind set only then (binds_after_fill, the accent) is left out.
fn node_of(layer: &str, page_in: &J, reg: &J, got: &Got, sels: &[J], after: Option<&J>, knobs: Option<J>) -> Result<J, String> {
    let d = declares(reg, layer, page_in)?;
    let mut n = J::obj_of(vec![("kind", J::str("Node")), ("id", J::str(layer)), ("node", J::str(layer))]);
    let mut binds = sub(d.get("binds").unwrap_or(&J::Obj(vec![])), page_in)?;
    if let Some(after) = after.filter(|a| a.has("fill")) {
        for (k, v) in sub(d.get("binds_after_fill").unwrap_or(&J::Obj(vec![])), after)?.obj() {
            binds.set(k, v.clone());
        }
    }
    if let Some(k) = knobs {
        n.set("knobs", k);
    }
    if binds.truthy() {
        n.set("binds", binds);
    }
    if let Some(f) = d.get("items_for") {
        n.set("items_for", f.clone());
    }
    let mut entry = reg.g("nodes").g(layer).clone();
    if after.is_none() {
        let later: Vec<String> = d.g("binds_after_fill").obj().iter().map(|(k, _)| format!("binds.{k}")).collect();
        let fields: Vec<(String, J)> =
            entry.g("items").g("fields").obj().iter().filter(|(_, x)| !x.g("ref").s().is_some_and(|r| later.iter().any(|l| l == r))).cloned().collect();
        let mut items = entry.g("items").clone();
        items.set("fields", J::Obj(fields));
        entry.set("items", items);
    }
    let spec = J::obj_of(vec![(
        "selects",
        J::obj_of(vec![("items", J::Arr(sels.iter().map(|s| with_result(s, got.get(&st(s.g("id"))).cloned().unwrap_or(J::Null))).collect()))]),
    )]);
    let items = core::expand_items(&n, &entry, &spec, got, page_in)?;
    n.set("items", J::Arr(items));
    if let Some(g) = d.get("geometry") {
        n.set("geometry", sub(g, page_in)?);
    }
    Ok(n)
}

/// The select a node's items follow: its ranked bind, else its items_for.
fn order_of(n: &J) -> Option<String> {
    let b = n.g("binds");
    core::ref_id(if b.has("ranked") { b.g("ranked") } else { n.g("items_for") })
}

/// fmt dec_rule held_decimals: the most decimals the chosen rows' values hold as the data gave them (at its time, or at
/// each of its times), at most the cap.
fn held_decimals(rows: &[J], q: &J, got: &Got) -> Result<i64, String> {
    let (by, _) = q.g("filter").obj().first().ok_or("held_decimals: a filter of one dimension")?;
    let codes = core::resolved(q.g("filter"), got)?.g(by).clone();
    let times: Vec<&J> = match q.g("time") {
        J::Arr(a) => a.iter().collect(),
        t => vec![t],
    };
    let held = rows
        .iter()
        .filter(|r| r.g("table") == q.g("table") && times.contains(&r.g("time")) && codes.arr().contains(r.g("dims").g(by)))
        .filter_map(|r| r.g("value").s())
        .map(|v| v.split_once('.').map_or(0, |(_, d)| d.len() as i64))
        .max()
        .unwrap_or(0);
    Ok(held)
}

/// What the flow's Filled takes from one external layer (Request::NodeDeclare), each part derived here, none from a node.
#[derive(Debug, Clone)]
pub struct NodeDeclared {
    pub node: String,
    /// The rows the layer draws, in the page input's order.
    pub drawn: Vec<Value>,
    /// The rows it only computes from (its numbers are other facts: a change's two ends), in the page input's order.
    pub reads: Vec<Value>,
    pub facts: Vec<(String, Value)>,
    pub fmts: Vec<(String, Value)>,
    /// Its binds with every reference resolved (a select to its recomputed result, {fact: k} to k, {family: f} to f), less
    /// the keys the registry keeps in the page tree only (declares.tree_only).
    pub data: Vec<(String, Value)>,
    /// Hero keys other than its data (declares.hero_style: {"style": ...}, which the page's lead reads).
    pub hero: Vec<(String, Value)>,
    /// A leaf's data under the hero's leaves (declares.leaf: its items with every select resolved to its code), by key.
    pub leaves: Vec<(String, Value)>,
}

/// fmt dec_rule over the page input: held_decimals (the only rule the generator computes), at most its cap.
fn dec_of(layer: &str, rule: &J, page_in: &J, got: &Got) -> Result<i64, String> {
    if rule.g("rule").s() != Some("held_decimals") {
        return Err(format!("{layer}: fmt dec_rule {}: not one the generator computes", rule.g("rule").repr()));
    }
    let cap = rule.g("max").g("value").num().ok_or_else(|| format!("{layer}: dec_rule max has no value"))? as i64;
    Ok(held_decimals(page_in.g("rows").arr(), rule.g("rows"), got)?.min(cap))
}

/// declares.fmt_change, rule points_if_percent: a change printed in points when the unit prints as the rule's percent sign
/// (its points key, suffix and at most max_dec decimals), else in the unit; its decimals by its dec_rule. (key, format)
fn change_fmt(layer: &str, fc: &J, page_in: &J, got: &Got) -> Result<(String, J), String> {
    if fc.g("rule").s() != Some("points_if_percent") {
        return Err(format!("{layer}: fmt_change rule {}: not one the generator computes", fc.g("rule").repr()));
    }
    let side = if page_in.g("shape").g("suffix") == fc.g("percent") { fc.g("points") } else { fc.g("else") };
    let mut dec = dec_of(layer, fc.g("dec_rule"), page_in, got)?;
    if let Some(most) = side.g("max_dec").num() {
        dec = dec.min(most as i64);
    }
    let fd = J::obj_of(vec![("scale", J::Int(1)), ("dec", J::Int(dec)), ("suffix", side.g("suffix").clone())]);
    Ok((st(side.g("key")), fd))
}

/// The declaration as JSON in the generator's own order (the prototype's), for the fixtures.
fn declared_j(layer: &str, page_in: &J, reg: &J) -> Result<J, String> {
    let d = declares(reg, layer, page_in)?;
    let (sels, given) = selects_of(page_in, reg)?;
    let (bad, got) = recompute(page_in, &sels, &given);
    if !bad.is_empty() {
        return Err(format!("{layer}: the core's selects do not recompute: {}", bad.iter().take(3).cloned().collect::<Vec<_>>().join("; ")));
    }
    let mut fd = sub(d.g("fmt"), page_in)?;
    let rule = fd.remove("dec_rule").ok_or_else(|| format!("{layer}: declares.fmt has no dec_rule"))?;
    let dec = dec_of(layer, &rule, page_in, &got)?;
    let fd = J::obj_of(vec![("scale", fd.g("scale").clone()), ("dec", J::Int(dec)), ("suffix", fd.g("suffix").clone())]);
    let fmt = st(page_in.g("shape").g("fmt"));
    let mut fmts = J::Obj(vec![(fmt, fd)]);
    // a change's format, its key read by the facts that print in it ($fmt.change)
    let mut facts_in = page_in.clone();
    if let Some(fc) = d.get("fmt_change") {
        let (key, cfd) = change_fmt(layer, &sub(fc, page_in)?, page_in, &got)?;
        fmts.set(&key, cfd);
        facts_in.set("fmt", J::obj_of(vec![("change", J::Str(key))]));
    }
    let facts = sub(d.g("facts"), &facts_in)?;
    let n = node_of(layer, page_in, reg, &got, &sels, None, None)?;
    let sid = order_of(&n).ok_or_else(|| format!("{layer}: its items follow no select"))?;
    let refs: Vec<(String, &J)> = sels.iter().map(|s| (st(s.g("id")), s)).collect();
    let root = core::root_rank(&refs, &sid)?;
    let over = root.g("over").clone();
    let codes = got.get(&sid).cloned().unwrap_or(J::Arr(vec![]));
    let by = st(over.g("by"));
    // the rows of the select at its time (rows_of_select), or at its time and the time its change runs from
    let rows_by = |rule: &J| -> Result<Vec<J>, String> {
        let times: Vec<&J> = match rule.s() {
            None => return Ok(vec![]),
            Some("rows_of_select") => vec![over.g("time")],
            Some("rows_of_select_both_ends") => vec![over.g("time"), core::change_from(root).unwrap_or(&J::Null)],
            Some(r) => return Err(format!("{layer}: rows rule {r}: not one the generator computes")),
        };
        Ok(page_in
            .g("rows")
            .arr()
            .iter()
            .filter(|r| r.g("table") == over.g("table") && times.contains(&r.g("time")) && codes.arr().contains(r.g("dims").g(&by)))
            .cloned()
            .collect())
    };
    let (drawn, reads) = (rows_by(d.g("rows"))?, rows_by(d.g("reads"))?);
    let mut data = J::Obj(vec![]);
    for (k, v) in n.g("binds").obj() {
        let x = match v {
            J::Str(s) if core::ref_parts(s).is_some() => core::resolve_ref(s, &got)?,
            J::Obj(_) if v.has("fact") => v.g("fact").clone(),
            J::Obj(_) if v.has("family") => v.g("family").clone(),
            v => v.clone(),
        };
        if !d.g("tree_only").arr().iter().any(|t| t.s() == Some(k)) {
            data.set(k, x);
        }
    }
    let mut out = J::obj_of(vec![("rows", J::Arr(drawn)), ("facts", facts), ("fmts", fmts)]);
    if !reads.is_empty() {
        out.set("reads", J::Arr(reads));
    }
    if data.truthy() {
        out.set("data", data);
    }
    if let Some(hs) = d.get("hero_style") {
        out.set("hero", J::obj_of(vec![("style", sub(hs, page_in)?)]));
    }
    // a leaf's data: the node's items, each field the leaf reads from the item field the registry names (a select
    // reference resolved to its code), and the leaf's other keys from the page input
    if let Some(lf) = d.get("leaf") {
        let mut items = Vec::new();
        for it in n.g("items").arr() {
            let mut x = J::Obj(vec![]);
            for (k, from) in lf.g("items").obj() {
                let v = it.get(&st(from)).ok_or_else(|| format!("{layer}: leaf item field {k}: the items have no {}", st(from)))?;
                x.set(k, if v.s().is_some_and(|s| core::ref_parts(s).is_some()) { core::resolve_ref(&st(v), &got)? } else { v.clone() });
            }
            items.push(x);
        }
        let mut leaf = J::obj_of(vec![("items", J::Arr(items))]);
        for (k, v) in lf.obj().iter().filter(|(k, _)| k != "key" && k != "items") {
            leaf.set(k, sub(v, page_in)?);
        }
        out.set("leaves", J::Obj(vec![(st(lf.g("key")), leaf)]));
    }
    Ok(out)
}

/// Request::NodeDeclare: what fill_of takes from the external layer `layer` over the flow's page input.
pub fn declare(layer: &str, page_in: &Value) -> Result<NodeDeclared, String> {
    let (reg, _) = core::registry_in_force();
    let out = declared_j(layer, &J::from_value(page_in), &reg).map_err(|e| format!("node {layer}: declare: {e}"))?;
    let pairs = |k: &str| out.g(k).obj().iter().map(|(k, v)| (k.clone(), v.to_value())).collect();
    Ok(NodeDeclared {
        node: layer.to_string(),
        drawn: out.g("rows").arr().iter().map(J::to_value).collect(),
        reads: out.g("reads").arr().iter().map(J::to_value).collect(),
        facts: pairs("facts"),
        fmts: pairs("fmts"),
        data: pairs("data"),
        hero: pairs("hero"),
        leaves: pairs("leaves"),
    })
}

/// A fill text ('...{key}...{key.n}...{key.t}...') as page tree runs: literal words and fact runs, in order. A brace that
/// names no key stays a literal word.
fn runs_of(text: &str) -> J {
    let key_ok = |k: &str| {
        let mut parts = k.split('.');
        let head = parts.next().unwrap_or("");
        head.chars().next().is_some_and(|c| c.is_ascii_lowercase())
            && head.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            && parts.all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
    };
    let (mut out, mut word) = (Vec::new(), String::new());
    let mut rest = text;
    while let Some(i) = rest.find('{') {
        let after = &rest[i + 1..];
        match after.find('}').map(|j| &after[..j]).filter(|k| key_ok(k)) {
            Some(inner) => {
                word.push_str(&rest[..i]);
                if !word.is_empty() {
                    out.push(J::obj_of(vec![("w", J::str(&word))]));
                    word.clear();
                }
                let split = inner.rsplit_once('.').filter(|(h, p)| matches!(*p, "n" | "t") && key_ok(h));
                out.push(match split {
                    Some((key, part)) => J::obj_of(vec![("fact", J::str(key)), ("part", J::str(part))]),
                    None => J::obj_of(vec![("fact", J::str(inner))]),
                });
                rest = &after[inner.len() + 1..];
            }
            None => {
                word.push_str(&rest[..=i]);
                rest = after;
            }
        }
    }
    word.push_str(rest);
    if !word.is_empty() {
        out.push(J::obj_of(vec![("w", J::str(&word))]));
    }
    J::Arr(out)
}

/// A select reference for a code: its index in the first select whose result holds it.
fn code_ref(code: &str, got: &Got, order: &[String]) -> Option<String> {
    order.iter().find_map(|sid| {
        let i = got.get(sid)?.arr().iter().position(|c| c.s() == Some(code))?;
        Some(format!("select:{sid}[{i}]"))
    })
}

/// A fill fact with each literal chosen code (the place dimension of a filter) as a select reference; a code no select
/// holds refuses: the core could not hold the fact to one.
fn as_refs(v: &J, got: &Got, order: &[String], place: &str) -> Result<J, String> {
    Ok(match v {
        J::Obj(m) => J::Obj(
            m.iter()
                .map(|(k, x)| {
                    let code = x.g(place).s().filter(|c| !c.starts_with("select:"));
                    let y = match (k == "filter" && x.is_obj(), code) {
                        (true, Some(c)) => {
                            let hit = code_ref(c, got, order).ok_or_else(|| format!("fact filter {place}={c}: no select holds the code"))?;
                            let mut f = x.clone();
                            f.set(place, J::Str(hit));
                            f
                        }
                        _ => as_refs(x, got, order, place)?,
                    };
                    Ok((k.clone(), y))
                })
                .collect::<Result<_, String>>()?,
        ),
        v => v.clone(),
    })
}

/// A fill fact held to the rows the page holds. The leaf computes a fact over the page's rows (fill.rows), the core over
/// the whole page input: a fact whose query also reads input rows the page does not hold (an aggregate at the year, which
/// no select ranks) takes the place filter of the select whose codes are just the page's, so both read the same rows. A
/// fact with no such select, or still reading past the page's rows, refuses.
fn held_to_page(key: &str, q: J, (inputs, held): (&[J], &[J]), got: &Got, order: &[String], place: &str) -> Result<J, String> {
    let srcs: BTreeSet<String> = held.iter().map(|r| st(r.g("src"))).collect();
    let past = |q: &J| -> Result<Vec<String>, String> {
        let rq = core::resolved(q, got)?;
        Ok(core::fact_rows(&rq, inputs).into_iter().map(|r| st(r.g("src"))).filter(|s| !srcs.contains(s)).collect())
    };
    let extra = past(&q)?;
    if extra.is_empty() {
        return Ok(q);
    }
    let no = |why: &str| format!("fact {key}: reads input rows the page does not hold {extra:?}, {why}");
    if q.g("filter").has(place) {
        return Err(no("past its own place filter"));
    }
    let codes: BTreeSet<String> = held.iter().filter(|r| r.g("table") == q.g("table")).map(|r| st(r.g("dims").g(place))).collect();
    let sid = order
        .iter()
        .find(|sid| got.get(*sid).is_some_and(|c| c.arr().iter().map(st).collect::<BTreeSet<_>>() == codes))
        .ok_or_else(|| no("and no select holds just the page's codes"))?;
    let mut filter = q.g("filter").clone();
    if !filter.is_obj() {
        filter = J::Obj(vec![]);
    }
    filter.set(place, J::Str(format!("select:{sid}")));
    let mut out = q;
    out.set("filter", filter);
    if !past(&out)?.is_empty() {
        return Err(no(&format!("even held to select {sid}")));
    }
    Ok(out)
}

/// The registry's checks, per page and per external node, with the node's own select and family put in.
fn checks_of(page_in: &J, reg: &J, body: &[J], external: &[String], unit: &J) -> J {
    let stop = |id: String, kind: &J, args: J| J::obj_of(vec![("id", J::Str(id)), ("kind", kind.clone()), ("args", args), ("on_fail", J::str("stop"))]);
    let mut checks: Vec<J> = reg.g("page").g("checks").arr().iter().map(|c| stop(st(c.g("kind")), c.g("kind"), J::obj_of(vec![("unit", unit.clone())]))).collect();
    for layer in external {
        let Some(n) = body.iter().find(|x| x.g("id").s() == Some(layer)) else { continue };
        let order = order_of(n).unwrap_or_default();
        for (j, c) in reg.g("nodes").g(layer).g("checks").arr().iter().enumerate() {
            let args = match c.g("kind").s() {
                Some("count_equals") => J::obj_of(vec![("items", J::str(layer)), ("select", J::str(&order))]),
                Some("one_row_per_code") => {
                    J::obj_of(vec![("family", n.g("binds").g("family").get("family").cloned().unwrap_or(J::str("val")))])
                }
                Some("points_pinned") => J::obj_of(vec![("table", page_in.g("points").g("table").clone())]),
                _ => J::Obj(
                    c.obj().iter().filter(|(k, _)| k != "kind").map(|(k, v)| (k.clone(), if v.s() == Some("$order") { J::str(&order) } else { v.clone() })).collect(),
                ),
            };
            checks.push(stop(format!("{layer}_{j}"), c.g("kind"), args));
        }
    }
    checks.push(J::obj_of(vec![
        ("id", J::str("names")),
        ("kind", J::str("named")),
        ("name_kind", page_in.g("name_kind").clone()),
        ("codes", J::obj_of(vec![("select", J::str("ranked"))])),
        ("on_fail", J::str("stop")),
    ]));
    J::obj_of(vec![("kind", J::str("Checks")), ("items", J::Arr(checks))])
}

/// The knobs a node laid out in a rows frame carries: where the frame starts across the page, after a panel the registry
/// says stands beside it when the fill draws that panel (frames.<f>.beside: the leaves it is, its width and the gap).
fn frame_knobs(layer: &str, reg: &J, fill: &J) -> Option<J> {
    let fr = reg.g("frames").g(&st(reg.g("nodes").g(layer).g("frame")));
    if fr.g("kind").s() != Some("rows") {
        return None;
    }
    let beside = fr.g("beside");
    let drawn = beside.g("leaves").s().is_some_and(|l| fill.g("knobs").g("spec").g("hero").g("leaves").has(l));
    let x0 = if drawn { beside.g("w").num().unwrap_or(0.0) + beside.g("gap").num().unwrap_or(0.0) } else { 0.0 };
    Some(J::obj_of(vec![("x0", if x0.fract() == 0.0 { J::Int(x0 as i64) } else { J::Num(x0) })]))
}

/// The fill's rows in the order the page input holds them (R10 holds the tree's rows to it): the fill keeps each layer's
/// rows in the order the layers put them (a change page's circles their later end first, its bars both ends after), which
/// the leaf reads by src only. A row the input does not hold stays after them, in its order, for R10 to refuse.
fn in_input_order(rows: &[J], input: &[J]) -> Vec<J> {
    let at = |r: &J| input.iter().position(|x| x.g("src") == r.g("src")).unwrap_or(usize::MAX);
    let mut out = rows.to_vec();
    out.sort_by_key(at);
    out
}

/// The page tree the core checks and asks the external layers over, from the page input and the finished fill.
pub(crate) fn tree_j(page_in: &J, fill: &J, reg: &J, external: &[String]) -> Result<J, String> {
    let (sels, given) = selects_of(page_in, reg)?;
    let (bad, got) = recompute(page_in, &sels, &given);
    if !bad.is_empty() {
        return Err(format!("the core's selects do not recompute: {}", bad.iter().take(3).cloned().collect::<Vec<_>>().join("; ")));
    }
    let order: Vec<String> = sels.iter().map(|s| st(s.g("id"))).collect();
    let shape = page_in.g("shape");
    let place = st(shape.g("place"));
    let spec = fill.g("knobs").g("spec");
    let (inputs, held) = (page_in.g("rows").arr(), fill.g("rows").arr());
    let facts = J::Obj(
        spec.g("facts")
            .obj()
            .iter()
            .map(|(k, q)| Ok((k.clone(), held_to_page(k, as_refs(q, &got, &order, &place)?, (inputs, held), &got, &order, &place)?)))
            .collect::<Result<_, String>>()?,
    );
    let mut fmts = spec.g("fmts").clone();
    let fmt = st(shape.g("fmt"));
    for layer in external {
        let rule = sub(declares(reg, layer, page_in)?.g("fmt").g("dec_rule"), page_in)?;
        let f = fmts.get_mut(&fmt).ok_or_else(|| format!("the fill has no format {fmt}"))?;
        f.set("dec_rule", rule);
    }
    let accent = spec.g("hero").g("data").g("accent").s().map(|c| code_ref(c, &got, &order).ok_or_else(|| format!("the accent {c}: no select holds the code")));
    let after = match accent {
        Some(r) => Some(J::obj_of(vec![("fill", J::obj_of(vec![("accent", J::Str(r?))]))])),
        None => None,
    };
    let mut body = Vec::new();
    // with no accent the binds set after the fill are left out, and the items mark no code (next_tree code_is)
    let after = after.unwrap_or(J::Obj(vec![]));
    for layer in fill.g("order").arr().iter().map(st).filter(|l| external.contains(l)) {
        body.push(node_of(&layer, page_in, reg, &got, &sels, Some(&after), frame_knobs(&layer, reg, fill))?);
    }
    let text = |k: &str, role: &str| {
        J::obj_of(vec![("kind", J::str("Text")), ("role", J::str(role)), ("origin", J::str("text_step")), ("runs", runs_of(spec.g(k).s().unwrap_or("")))])
    };
    let unit = shape.g("unit").clone();
    let texts = J::obj_of(vec![
        ("title", text("title", "headline")),
        ("dek", text("dek", "dek")),
        ("kicker", text("kicker", "kicker")),
        (
            "unit",
            J::obj_of(vec![
                ("kind", J::str("Text")),
                ("role", J::str("unit")),
                ("origin", J::str("program")),
                ("runs", J::Arr(vec![J::obj_of(vec![("w", J::str("单位："))]), J::obj_of(vec![("src", J::Str(format!("name:unit_short_zh:{}", st(&unit))))])])),
            ]),
        ),
    ]);
    let or_fill = |k: &str, fk: &str| page_in.get(k).cloned().unwrap_or_else(|| fill.g("knobs").get(fk).cloned().unwrap_or(J::Obj(vec![])));
    let (names, named) = (or_fill("names", "labels"), or_fill("named", "named"));
    let points = page_in.get("points").or_else(|| fill.g("knobs").get("points")).cloned().unwrap_or(J::Null);
    let recipe = fill.get("recipe").or_else(|| page_in.get("recipe")).cloned().unwrap_or(J::Null);
    let selects: Vec<J> = sels.iter().map(|s| with_result(s, got.get(&st(s.g("id"))).cloned().unwrap_or(J::Null))).collect();
    let checks = checks_of(page_in, reg, &body, external, &unit);
    let drawn: Vec<J> = fill.g("drawn").arr().iter().filter(|d| external.iter().any(|l| d.g("layer").s() == Some(l))).cloned().collect();
    let page = J::obj_of(vec![
        ("kind", J::str("Page")),
        ("schema_version", J::str("0.1.0")),
        ("recipe", recipe),
        ("order", fill.g("order").clone()),
        ("scoped", J::Bool(false)),
        ("texts", texts),
        (
            "facts",
            J::obj_of(vec![
                ("kind", J::str("Facts")),
                ("tables", spec.g("tables").clone()),
                ("facts", facts),
                ("fmts", fmts),
                ("rows", J::Arr(in_input_order(fill.g("rows").arr(), page_in.g("rows").arr()))),
                ("labels", names.clone()),
                ("named", named.clone()),
                ("points", points.clone()),
            ]),
        ),
        ("selects", J::obj_of(vec![("kind", J::str("Selects")), ("items", J::Arr(selects))])),
        ("checks", checks),
        (
            "body",
            J::obj_of(vec![
                ("kind", J::str("Frame")),
                ("id", J::str("page")),
                ("role", J::str("page")),
                ("children", J::Arr(vec![J::obj_of(vec![("kind", J::str("Frame")), ("id", J::str("hero")), ("role", J::str("hero")), ("children", J::Arr(body))])])),
            ]),
        ),
        ("record", J::obj_of(vec![("drawn", J::Arr(drawn))])),
    ]);
    let select_spec = J::Obj(sels.iter().map(|s| (st(s.g("id")), J::Obj(s.obj().iter().filter(|(k, _)| k != "id").cloned().collect()))).collect());
    let rules = J::Obj(external.iter().map(|l| Ok((l.clone(), declares(reg, l, page_in)?.g("rows").clone()))).collect::<Result<_, String>>()?);
    Ok(J::obj_of(vec![
        ("rows", page_in.g("rows").clone()),
        ("select_spec", select_spec),
        ("knobs", J::Obj(vec![])),
        ("drawn_rules", rules),
        ("given", J::Obj(given)),
        ("name_table", J::obj_of(vec![("labels", names), ("named", named)])),
        ("points", points),
        ("word_table", J::Obj(vec![])),
        ("page_spec", page),
    ]))
}

/// What a leaf of an external layer refuses before it draws anything (the declaration's leaf_stops, or its recipe's in
/// leaf_stops_by_recipe; each a rule named here, in the leaf's order: the panel's first, which refuse every layer at the
/// panel's first line, then the layer's own input): the layer's node is then not asked, and the page goes to the leaf as it
/// is and stops there with the leaf's own words, as before the layer was external, instead of at a check of the core that
/// would word it otherwise. A rule of the layer's own leaves the page's other layers asked. None when the leaf draws.
fn leaf_stops(layer: &str, page_in: &J, fill: &J, reg: &J) -> Option<String> {
    let d = declares(reg, layer, page_in).ok()?;
    let rules = page_in.g("recipe").s().and_then(|r| d.g("leaf_stops_by_recipe").get(r)).unwrap_or_else(|| d.g("leaf_stops"));
    let (shape, hero) = (page_in.g("shape"), fill.g("knobs").g("spec").g("hero"));
    let ranked: Vec<&J> = page_in.g("picks").g("ranked").arr().iter().collect();
    let value = |r: &J| match r.g("value") {
        J::Str(s) => s.trim().parse::<f64>().ok(),
        v => v.num(),
    };
    let at = |c: &J, t: &J| {
        page_in
            .g("rows")
            .arr()
            .iter()
            .filter(|r| r.g("table") == shape.g("main") && r.g("time") == t && r.g("dims").g(&st(shape.g("place"))) == c)
            .filter_map(value)
            .next_back()
    };
    let (year, t0) = (shape.g("year"), page_in.g("picks").g("t0"));
    let labels = fill.g("knobs").g("labels");
    let facts = fill.g("knobs").g("spec").g("facts");
    let leaves = hero.g("leaves");
    let circles = leaves.g("bubbles");
    let ext: Vec<f64> = circles.g("ext").arr().iter().filter_map(J::num).collect();
    let in_box = |e: &[f64]| e.len() == 4 && e[0] < e[2] && e[1] < e[3] && -180.0 <= e[0] && e[2] <= 180.0 && -90.0 <= e[1] && e[3] <= 90.0;
    let src_value = |src: &J| fill.g("rows").arr().iter().find(|r| r.g("src") == src).and_then(value);
    let fact_base = |t: &J| t.s().and_then(|t| t.strip_prefix("fact:")).map(|t| t.strip_suffix(".n").unwrap_or(t).rsplit_once('.').map_or(t, |x| x.0).to_string());
    let items = circles.g("items").arr();
    let point = |i: &J| {
        let p: Vec<f64> = i.g("lonlat").arr().iter().filter_map(J::num).collect();
        (p.len() == 2 && (-180.0..=180.0).contains(&p[0]) && (-90.0..=90.0).contains(&p[1])).then_some(p)
    };
    for rule in rules.arr().iter().filter_map(J::s) {
        let hit = match rule {
            "row_at_year" => ranked.iter().any(|c| at(c, year).is_none()),
            "row_at_both_ends" => ranked.iter().any(|c| at(c, t0).is_none() || at(c, year).is_none()),
            "value_domain" => {
                let v: Vec<f64> = ranked.iter().filter_map(|c| at(c, year)).collect();
                v.is_empty() || v.iter().any(|x| *x < 0.0) || !v.iter().any(|x| *x > 0.0)
            }
            "some_change" => ranked.iter().filter_map(|c| Some(at(c, year)? - at(c, t0)?)).all(|x| x == 0.0),
            // the largest change is 0 and the rest fall: the leaf prints that 0's value past the zero line at the frame's
            // right edge, with no room there, and layer 1 stops the page on it (the leaf draws it, leaf_draws)
            "zero_end_past_frame" => {
                let v: Vec<f64> = ranked.iter().filter_map(|c| Some(at(c, year)? - at(c, t0)?)).collect();
                v.iter().any(|x| *x < 0.0) && v.iter().copied().fold(f64::NEG_INFINITY, f64::max) == 0.0
            }
            "named" => ranked.iter().any(|c| !c.s().is_some_and(|c| labels.has(c))),
            "value_entry" => hero.g("data").g("family").s().is_some_and(|f| !facts.has(f)),
            "accent_ranked" => hero.g("data").g("accent").s().is_some_and(|a| !ranked.iter().any(|c| c.s() == Some(a))),
            "one_ext" => leaves.has("leader_notes") && leaves.g("leader_notes").g("ext") != circles.g("ext"),
            "view_ext" => circles.g("ext").arr().len() != 4 || !in_box(&ext),
            "has_items" => items.is_empty(),
            "series_of_request" => items.iter().any(|i| src_value(i.g("value")).is_none()),
            "named_item" => items.iter().any(|i| !i.g("code").s().is_some_and(|c| labels.has(c))),
            "ledger_entry" => items.iter().any(|i| !fact_base(i.g("value_text")).is_some_and(|b| facts.has(&b))),
            "not_negative" => items.iter().any(|i| src_value(i.g("value")).is_some_and(|v| v < 0.0)),
            "has_point" => items.iter().any(|i| point(i).is_none()),
            "inside_ext" => {
                in_box(&ext) && items.iter().filter_map(point).any(|p| !(ext[0] <= p[0] && p[0] <= ext[2] && ext[1] <= p[1] && p[1] <= ext[3]))
            }
            _ => false,
        };
        if hit {
            return Some(rule.to_string());
        }
    }
    None
}

/// The ground a layer's leaf gives its node (the registry's `ground`: the leaf's ground phase, run.py GROUND, over the
/// fill's hero and its map shapes): what the node weighs among places the core holds equally good (the map circles' land
/// rows), never checked and never a number on the page. Asked only for a layer whose node is asked. A reply that is no
/// {"land": {band: [[x0, x1], ...]}} refuses the page.
fn ground_of(layer: &str, g: &J, fill: &J, runtime: &std::path::Path) -> Result<J, String> {
    let knobs = fill.g("knobs");
    let req = J::obj_of(vec![
        ("phase", g.g("phase").clone()),
        ("layer", J::str(layer)),
        ("knobs", J::obj_of(vec![("spec", J::obj_of(vec![("hero", knobs.g("spec").g("hero").clone())])), ("shapes", knobs.g("shapes").clone())])),
    ]);
    let runner = crate::next_leaf::Runner::python(&runtime.join("leaves_py/run.py"));
    let no = |why: String| format!("node {layer}: ground: {why}");
    let (line, _) = crate::next_leaf::ask_once(&runner, &req.dump(), crate::next_leaf::LAYER_DEADLINE).map_err(no)?;
    let rep = core::parse(&line).map_err(no)?;
    if let Some(why) = rep.get("refused") {
        return Err(no(why.arr().iter().map(st).collect::<Vec<_>>().join("; ")));
    }
    let land = rep.g("land");
    let span = |x: &J| x.arr().len() == 2 && x.arr().iter().all(J::finite);
    if !land.is_obj() || !land.obj().iter().all(|(k, v)| k.parse::<i64>().is_ok() && v.is_arr() && v.arr().iter().all(span)) {
        return Err(no("the leaf's land rows are not {band: [[x0, x1], ...]}".into()));
    }
    Ok(J::obj_of(vec![("land", land.clone())]))
}

/// What NodeDraw gives back: the checked geometry by layer (none for a layer whose leaf refuses before it draws, which
/// then stops the page itself), and per layer the child's and the core's milliseconds or the leaf rule it left to.
#[derive(Debug, Clone)]
pub struct NodesDrawn {
    pub placed: Value,
    pub timing: Vec<(String, u64, u64, Option<String>)>,
}

/// Request::NodeDraw: the page tree over the finished fill, and each external layer asked through the core (next_tree
/// node_draw). Err lists every failure, one per line.
pub fn draw(fill: &Value, page_in: &Value, layers: &[String], runtime: &std::path::Path) -> Result<NodesDrawn, String> {
    let (reg, _) = core::registry_in_force();
    let (page_in, fill) = (J::from_value(page_in), J::from_value(fill));
    // a layer's style its declaration writes (hero_style: what the page's lead reads) is the registry's, not the page's
    let own = |l: &str| declares(&reg, l, &page_in).ok().and_then(|d| d.g("hero_style").get(l)).cloned();
    let style_of = |l: &str| fill.g("knobs").g("spec").g("hero").g("style").get(l).cloned();
    let mut style: Vec<String> = layers.iter().filter(|l| style_of(l).is_some() && style_of(l) != own(l)).cloned().collect();
    if let Some(l) = style.pop() {
        return Err(format!("node {l}: the page sets a knob of the external layer {l}; the core lays it out at the registry's"));
    }
    let mut out = NodesDrawn { placed: Value::Object(serde_json::Map::new()), timing: Vec::new() };
    let mut asked = Vec::new();
    for l in layers {
        match leaf_stops(l, &page_in, &fill, &reg) {
            Some(rule) => {
                // a stop layer 1 makes on what the leaf draws (declares.leaf_draws): the leaf draws it its own way to stop
                // there in its words; the drawn check refuses that layer should it ever not stop (no placed items)
                let draws = declares(&reg, l, &page_in).is_ok_and(|d| d.g("leaf_draws").arr().iter().any(|r| r.s() == Some(rule.as_str())));
                if draws {
                    out.placed[l.as_str()] = serde_json::json!({"leaf_stop": rule});
                }
                out.timing.push((l.clone(), 0, 0, Some(rule)))
            }
            None => asked.push(l.clone()),
        }
    }
    if asked.is_empty() {
        return Ok(out);
    }
    let mut tree = tree_j(&page_in, &fill, &reg, &asked).map_err(|e| format!("node {}: page tree: {e}", asked.join(",")))?;
    let mut ground = J::Obj(vec![]);
    for l in &asked {
        if let Some(g) = reg.g("nodes").g(l).get("ground") {
            ground.set(l, ground_of(l, g, &fill, runtime)?);
        }
    }
    if ground.truthy() {
        tree.set("ground", ground);
    }
    for l in &asked {
        let drawn = core::node_draw(l, &tree, runtime)?;
        out.placed[l.as_str()] = drawn.placed.to_value();
        out.timing.push((l.clone(), drawn.child_ms, drawn.recheck_ms, None));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/fixtures/p4a")
    }
    fn read(name: &str) -> J {
        core::parse(&std::fs::read_to_string(fixtures().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))).unwrap_or_else(|e| panic!("{name}: {e}"))
    }
    fn proto_reg() -> J {
        core::load_registry(&read("registry-p4a.json"))
    }

    /// The generator over the q1 page input (the prototype's, scripts/fixtures/p4a/q1-gen.json exported from
    /// tests/gen_tree.py of the design): the bars declaration and the P4a-1 page tree (bars external) equal the prototype's
    /// byte for byte, keys in order (p4a_todo 1: the tree is built on J, never on serde's reordered maps).
    #[test]
    fn next_tree_gen_q1_matches_prototype() {
        let gen = read("q1-gen.json");
        let reg = proto_reg();
        let (pi, fill) = (gen.g("page_in"), gen.g("fill"));
        assert_eq!(declared_j("bars", pi, &reg).unwrap().dump(), gen.g("declare_bars").dump());
        assert_eq!(tree_j(pi, fill, &reg, &["bars".to_string()]).unwrap().dump(), gen.g("tree_p4a1").dump());
    }

    /// G3 (P4a-1 group): page inputs the generator or the core must stop. A missing map point is not this tree's: the
    /// bars read none.
    #[test]
    fn next_tree_gen_stops_what_the_prototype_stops() {
        let gen = read("q1-gen.json");
        let reg = proto_reg();
        let ext = vec!["bars".to_string()];
        let check = |pi: &J, fill: &J| -> Vec<String> {
            let tree = match tree_j(pi, fill, &reg, &ext) {
                Ok(t) => t,
                Err(e) => return vec![format!("generator: {e}")],
            };
            let env = J::obj_of(vec![("input", tree), ("external", J::strs(&ext)), ("reply", J::Obj(vec![]))]);
            core::content_problems(env.g("input").g("page_spec"), env.g("input"), &ext, &reg).0
        };
        let (pi, fill) = (gen.g("page_in").clone(), gen.g("fill").clone());
        assert_eq!(check(&pi, &fill), Vec::<String>::new());
        let row_of = |p: &J, geo: &str| p.g("rows").arr().iter().position(|r| r.g("dims").g("geo").s() == Some(geo) && r.g("time").s() == Some("2025")).unwrap();
        let mut cases: Vec<(&str, J, J)> = Vec::new();
        let mut p = pi.clone();
        let mut twice = p.g("rows").at(row_of(&p, "DE")).clone();
        twice.set("src", J::str("series:sdg/DE2:2025:OBS_VALUE"));
        if let J::Obj(m) = &mut p {
            if let Some((_, J::Arr(rows))) = m.iter_mut().find(|(k, _)| k == "rows") {
                rows.push(twice);
            }
        }
        cases.push(("a row twice", p, fill.clone()));
        let mut f = fill.clone();
        assert!(f.set_path(&["knobs", "spec", "facts", "hi", "filter", "geo"].map(String::from), J::str("ZZ")));
        cases.push(("a fact names a code no select holds", pi.clone(), f));
        let mut p = pi.clone();
        let mut r: Vec<J> = p.g("picks").g("ranked").arr().to_vec();
        r.swap(0, 1);
        assert!(p.set_path(&["picks", "ranked"].map(String::from), J::Arr(r)));
        cases.push(("the flow's ranked is not the core's", p, fill.clone()));
        for (name, tail) in [("a page word types a number", "，约三成"), ("the q3 word 为零", "；核能为零的国家")] {
            let mut f = fill.clone();
            let t = format!("{}{tail}", st(f.g("knobs").g("spec").g("title")));
            assert!(f.set_path(&["knobs", "spec", "title"].map(String::from), J::Str(t)));
            cases.push((name, pi.clone(), f));
        }
        let mut p = pi.clone();
        assert!(p.set_path(&["picks", "rules"].map(String::from), J::strs(&["changed", "claim_marks"])));
        cases.push(("a pick rule the registry cannot recompute", p, fill.clone()));
        let mut p = pi.clone();
        let i = row_of(&p, "FR");
        assert!(p.set_path(&["rows".to_string(), i.to_string(), "value".to_string()], J::str("NaN")));
        cases.push(("a value that is no finite number", p, fill.clone()));
        for (name, p, f) in &cases {
            assert!(!check(p, f).is_empty(), "{name}: passed");
        }
        let mut p = pi.clone();
        let mut pts = p.g("points").clone();
        let mut at = pts.g("at").clone();
        at.remove("FR");
        pts.set("at", at);
        p.set("points", pts);
        assert_eq!(check(&p, &fill), Vec::<String>::new(), "a missing point is not the bars' tree's");
    }

    /// The page input and the finished fill a stop fixture (scripts/fixtures/p4a2/stops.json) stands for: its rows, its
    /// ranking and ends, its names, a declared fact per ledger family, its hero.
    fn stop_case(c: &J) -> (J, J) {
        let data = c.g("hero").g("data");
        let page_in = J::obj_of(vec![
            ("recipe", c.g("recipe").clone()),
            ("shape", J::obj_of(vec![("main", c.g("table").clone()), ("place", c.g("place").clone()), ("year", data.g("year").clone())])),
            ("picks", J::obj_of(vec![("ranked", data.g("ranked").clone()), ("t0", data.get("t0").cloned().unwrap_or(J::Null))])),
            ("rows", c.g("rows").clone()),
        ]);
        let mut facts = J::Obj(vec![]);
        for (k, _) in c.g("ledger").obj() {
            if let Some(f) = k.strip_prefix("fact:").and_then(|k| k.split('.').next()) {
                facts.set(f, J::Obj(vec![]));
            }
        }
        let spec = J::obj_of(vec![("facts", facts), ("hero", c.g("hero").clone())]);
        let fill = J::obj_of(vec![("rows", c.g("rows").clone()), ("knobs", J::obj_of(vec![("labels", c.g("names").clone()), ("spec", spec)]))]);
        (page_in, fill)
    }

    /// M8 (P4a-2): on every stop fixture the generator asks the external layers the prototype asked (a panel's stop asks no
    /// node; a stop of the circles' own input skips only the circles; the column page's bars keep their P4a-1 rules), so
    /// the leaf ends the page where it did (scripts/test_leaf_stops_p4a2.py). A panel rule hit leaves no layer asked, and
    /// draw then asks no node and no ground (a runtime with no leaf child at all: nothing is started) and keeps the leaf's
    /// stage; a circles-only hit leaves the bars asked.
    #[test]
    fn next_tree_gen_leaf_stops_ask_what_the_prototype_asked() {
        let fx = core::parse(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/fixtures/p4a2/stops.json")).unwrap()).unwrap();
        let (bindings, reg) = (core::bindings(), core::load_registry(&core::bindings()));
        let mut off = Vec::new();
        for c in fx.g("cases").arr() {
            let (page_in, fill) = stop_case(c);
            let layers: Vec<String> = bindings.g("recipes").g(&st(c.g("recipe"))).arr().iter().map(st).collect();
            let asked: Vec<String> = layers.iter().filter(|l| leaf_stops(l, &page_in, &fill, &reg).is_none()).cloned().collect();
            let want: Vec<String> = c.g("asked").arr().iter().map(st).collect();
            if asked != want {
                off.push(format!("{} {}: asked {asked:?}, the prototype {want:?}", st(c.g("id")), st(c.g("recipe"))));
            }
        }
        // P6 and B2 take one entry out of the ledger, which the flow prints from the facts it declares (unreachable, design
        // 11.2): the generator sees the declared family, so it asks; the leaf still stops on the missing entry as before, at
        // its panel (P6) or in the circles' input half, which runs before their placed geometry is read (B2)
        let ledger_only = ["P6 change: asked [\"bubbles\", \"bars\"], the prototype []", "B2 change: asked [\"bubbles\", \"bars\"], the prototype [\"bars\"]"];
        assert_eq!(off, ledger_only, "{off:#?}");
        // a panel stop: draw asks nothing, not even the ground, and leaves each layer to its leaf rule
        let p2 = fx.g("cases").arr().iter().find(|c| c.g("id").s() == Some("P2")).unwrap();
        let (page_in, fill) = stop_case(p2);
        let layers = ["bars".to_string(), "bubbles".to_string()];
        let out = draw(&fill.to_value(), &page_in.to_value(), &layers, Path::new("/nonexistent-runtime")).unwrap();
        assert_eq!(out.timing.iter().map(|t| t.3.clone()).collect::<Vec<_>>(), [Some("value_domain".into()), Some("value_domain".into())]);
        assert_eq!(out.placed, serde_json::json!({}));
    }

    /// Fill texts as runs: placeholders become fact runs (a final .n or .t a part), any other brace stays a word.
    #[test]
    fn next_tree_gen_runs_of_a_fill_text() {
        assert_eq!(
            runs_of("{lead1.t}年，{hi}比{val.SE.n}高{x}{Bad}").dump(),
            r#"[{"fact":"lead1","part":"t"},{"w":"年，"},{"fact":"hi"},{"w":"比"},{"fact":"val.SE","part":"n"},{"w":"高"},{"fact":"x"},{"w":"{Bad}"}]"#
        );
        assert_eq!(runs_of("").dump(), "[]");
    }
}
