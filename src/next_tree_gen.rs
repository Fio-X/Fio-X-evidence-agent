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
//! A declaration of shape parts_of_whole (P4b-1, the composition's stacked100) is expanded by parts_declared over the page
//! input's further fields {sum_rows, outside, top, short, composition{dim, total, groups}}; its layer lays itself out in its
//! leaf (geometry leaf), so draw asks no node for it.

use crate::next_tree::{self as core, st, Got, J};
use std::collections::BTreeSet;
use serde_json::Value;

/// The page input paths a declaration template may read (`$shape.main`, ...); nothing else is substituted.
const PAGE_IN_PATHS: [&str; 31] = [
    "shape.scale", "shape.main", "shape.source", "shape.target", "shape.place", "shape.year", "shape.fmt", "shape.suffix", "shape.countries", "shape.hub", "shape.second", "shape.months", "picks.marks", "picks.t0", "picks.t1", "picks.top",
    "picks.focus", "fill.accent", "fmt.change", "shape.members", "shape.point", "shape.extent", "outside", "hub_name",
    "shape.t0", "sum_rows", "composition.dim", "composition.total", "composition.first_group", "composition.first_codes",
    "fill.composition.bars",
];

/// A template with every `$path` (a string value or an object key) read from the page input by PAGE_IN_PATHS.
fn sub(v: &J, page_in: &J) -> Result<J, String> {
    Ok(match v {
        J::Str(s) if s.starts_with('$') => {
            let path = &s[1..];
            if !PAGE_IN_PATHS.contains(&path) && !path.starts_with("value.") {
                return Err(format!("template path {s} is not a page input path the generator reads"));
            }
            // a page printed at a magnitude (亿, 万亿) has its unit's formats scaled; a page input with none prints at 1
            if path == "shape.scale" {
                return Ok(page_scale(page_in));
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
    recompute_over(page_in, sels, given, &J::Obj(vec![]))
}

/// recompute with the page's formats beside its rows, which a take's printed tie reads.
fn recompute_over(page_in: &J, sels: &[J], given: &[(String, J)], fmts: &J) -> (Vec<String>, Got) {
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
                    ("fmts", fmts.clone()),
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
fn node_of(layer: &str, page_in: &J, reg: &J, got: &Got, sels: &[J], after: Option<&J>, knobs: Option<J>, facts: Option<&J>) -> Result<J, String> {
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
    // the declaration's own items (for_each spec): each where its conditions hold over the selects, less them
    if let Some(items) = d.get("items") {
        let mut kept = Vec::new();
        for it in items.arr() {
            let it = &sub(it, page_in)?;
            if core::conditions_hold(it.g("when"), &plain_holding(got, page_in))? {
                kept.push(J::Obj(it.obj().iter().filter(|(k, _)| k != "when").cloned().collect()));
            }
        }
        n.set("items", J::Arr(kept));
    }
    let mut entry = reg.g("nodes").g(layer).clone();
    let has_items = entry.has("items");
    // a first_holding field's candidates are the declaration's, over the page input, each chosen code a literal code
    if let Some(c) = d.get("candidates") {
        let c = codes_in(&sub(c, facts.and_then(|f| f.get("in")).unwrap_or(page_in))?, got);
        let with = |fd: &J| {
            let mut fd = fd.clone();
            if fd.g("kind").s() == Some("first_holding") {
                fd.set("candidates", c.clone());
            }
            fd
        };
        let fields = J::Obj(entry.g("items").g("fields").obj().iter().map(|(k, fd)| (k.clone(), with(fd))).collect());
        let mut items = entry.g("items").clone();
        items.set("fields", fields);
        entry.set("items", items);
    }
    if after.is_none() {
        let later: Vec<String> = d.g("binds_after_fill").obj().iter().map(|(k, _)| format!("binds.{k}")).collect();
        let fields: Vec<(String, J)> =
            entry.g("items").g("fields").obj().iter().filter(|(_, x)| !x.g("ref").s().is_some_and(|r| later.iter().any(|l| l == r))).cloned().collect();
        let mut items = entry.g("items").clone();
        items.set("fields", J::Obj(fields));
        entry.set("items", items);
    }
    let mut spec = J::obj_of(vec![(
        "selects",
        J::obj_of(vec![("items", J::Arr(sels.iter().map(|s| with_result(s, got.get(&st(s.g("id"))).cloned().unwrap_or(J::Null))).collect()))]),
    )]);
    // the declaration's facts and formats, which a first_holding field's conditions read
    if let Some(f) = facts {
        spec.set("facts", f.clone());
    }
    let items = if has_items { core::expand_items(&n, &entry, &spec, got, page_in)? } else { Vec::new() };
    n.set("items", J::Arr(items));
    if let Some(g) = d.get("geometry") {
        n.set("geometry", sub(g, page_in)?);
    }
    Ok(n)
}

/// What a condition over the selects and the page input alone reads (count_at_least, page_is): no facts, formats, name
/// or words, which such a condition does not read.
fn plain_holding<'a>(got: &'a Got, page: &'a J) -> core::Holding<'a> {
    fn no_fact(k: &str) -> Result<f64, String> {
        Err(format!("fact {k}: a condition here reads no fact"))
    }
    fn no_word(_: &str) -> Option<String> {
        None
    }
    static NONE: J = J::Null;
    core::Holding { facts: &no_fact, fmts: &NONE, got, page, code: "", name: None, word: &no_word }
}

/// `v` with each string that is a select reference to one code (a take's) written as that code.
fn codes_in(v: &J, got: &Got) -> J {
    match v {
        J::Str(s) => match core::ref_parts(s).and_then(|_| core::resolve_ref(s, got).ok()) {
            Some(J::Str(code)) => J::Str(code),
            _ => v.clone(),
        },
        J::Arr(a) => J::Arr(a.iter().map(|x| codes_in(x, got)).collect()),
        J::Obj(o) => J::Obj(o.iter().map(|(k, x)| (k.clone(), if k == "filter" { filter_codes(x, got) } else { codes_in(x, got) })).collect()),
        x => x.clone(),
    }
}

/// A fact's filter with each select ref its codes: one code, or a select's whole list (a mean over the ranked places).
fn filter_codes(v: &J, got: &Got) -> J {
    J::Obj(
        v.obj()
            .iter()
            .map(|(d, c)| match c {
                J::Str(s) => (d.clone(), core::ref_parts(s).and_then(|_| core::resolve_ref(s, got).ok()).unwrap_or_else(|| c.clone())),
                c => (d.clone(), codes_in(c, got)),
            })
            .collect(),
    )
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
    /// The rows the layer draws (true) or reads first among them (false), in its order: a rows-of-select layer's drawn rows
    /// in the page input's order; a parts_of_whole layer's each item's total (drawn) then its parts' rows, as it reads them.
    pub rows: Vec<(Value, bool)>,
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
    /// The names the layer prints, as requests the flow resolves through the knowledge group's name table: (name kind,
    /// codes, whether they are also the leaf's labels of codes that are no place).
    pub names: Vec<(String, Vec<String>, bool)>,
    /// Name rows of words the visual group holds (a frame's heading, the unit's short form): (src, text).
    pub fixed: Vec<(String, String)>,
    /// What a parts_of_whole layer drew, left out and named under it, for the run's record.
    pub record: Option<Value>,
    /// The layer writes the unit in its own picture.
    pub unit_drawn: bool,
    /// The notes after the unit the layer writes (declares.notes: what a share is of), in its order.
    pub notes: Vec<String>,
    /// The page's finding (the finding node): its dek's two wordings and its headline's, and the code it names first.
    pub finding: Option<(Value, String)>,
    /// Why the finding node gives the page no headline (none, or a finding without one), so its title is the label.
    pub fell_back: Option<String>,
}

/// fmt dec_rule over the page input: held_decimals (the only rule the generator computes), at most its cap.
fn dec_of(layer: &str, rule: &J, page_in: &J, got: &Got, scaled: bool) -> Result<i64, String> {
    // fixed: the decimals another layer's format of the same key fixes (the map's), so both declare one format
    if rule.g("rule").s() == Some("fixed") {
        return rule.g("dec").num().map(|d| d as i64).ok_or_else(|| format!("{layer}: fmt dec_rule fixed has no dec"));
    }
    if rule.g("rule").s() != Some("held_decimals") {
        return Err(format!("{layer}: fmt dec_rule {}: not one the generator computes", rule.g("rule").repr()));
    }
    let cap = rule.g("max").g("value").num().ok_or_else(|| format!("{layer}: dec_rule max has no value"))? as i64;
    // a number printed at the page's magnitude holds as many more decimals as the magnitude moves the point (12 for 万亿)
    let moved = if scaled { page_scale(page_in).num().filter(|f| *f > 0.0).map_or(0, |f| (-f.log10()).round() as i64) } else { 0 };
    Ok((held_decimals(page_in.g("rows").arr(), rule.g("rows"), got)? + moved).min(cap))
}

/// declares.fmt_change, rule points_if_percent: a change printed in points when the unit prints as the rule's percent sign
/// (its points key, suffix and at most max_dec decimals), else in the unit; its decimals by its dec_rule. (key, format)
fn change_fmt(layer: &str, fc: &J, page_in: &J, got: &Got) -> Result<(String, J), String> {
    if fc.g("rule").s() != Some("points_if_percent") {
        return Err(format!("{layer}: fmt_change rule {}: not one the generator computes", fc.g("rule").repr()));
    }
    let side = if page_in.g("shape").g("suffix") == fc.g("percent") { fc.g("points") } else { fc.g("else") };
    let scaled = side.g("suffix") == page_in.g("shape").g("suffix");
    let mut dec = dec_of(layer, fc.g("dec_rule"), page_in, got, scaled)?;
    if let Some(most) = side.g("max_dec").num() {
        dec = dec.min(most as i64);
    }
    let scale = if scaled { page_scale(page_in) } else { J::Int(1) };
    let fd = J::obj_of(vec![("scale", scale), ("dec", J::Int(dec)), ("suffix", side.g("suffix").clone())]);
    Ok((st(side.g("key")), fd))
}

/// The magnitude a page prints its unit's numbers at (shape.scale, 1e-8 for 亿 and 1e-12 for 万亿, chosen by the flow from the
/// main's largest value with the unit code that names it); 1 for a page input with none.
fn page_scale(page_in: &J) -> J {
    page_in.g("shape").get("scale").cloned().unwrap_or(J::Int(1))
}

/// Whether a first_holding candidate list (a list, or lists by key) has a candidate that carries facts.
fn carries_facts(c: &J) -> bool {
    match c {
        J::Arr(a) => a.iter().any(|x| x.has("facts")),
        J::Obj(o) => o.iter().any(|(_, x)| matches!(x, J::Arr(_)) && carries_facts(x)),
        _ => false,
    }
}

/// A node's number knob at the leaf registry's default, as Request::Knob reads it.
fn knob_default(layer: &str, knob: &str) -> Result<f64, String> {
    let leaf = crate::next_leaf::leaves().nodes.get(layer).ok_or_else(|| format!("the leaf registry has no node {layer}"))?;
    match leaf.info.knobs.iter().find(|k| k.name == knob).map(|k| &k.kind) {
        Some(crate::next_nodes::Kind::Range { default, .. }) => Ok(*default),
        _ => Err(format!("no number knob {knob}")),
    }
}

/// A declaration of shape PAIRS: pairs of two dimensions of the main at its year (shape.source x shape.target), each row
/// above or below zero a link, its zero rows only read. What it declares, every word and key from the registry
/// (declares: stops, sides, keys, words), every choice of codes a select the core recomputes (held_codes, group_sum,
/// share_merge, set_op, registry_list), its names requested from the knowledge group's name table (source side, then
/// target), its accounting left to the flow:
/// - the rows: each must hold a number (stop no_number) and their sum be above 0 (stop no_flow);
/// - the format: the decimals the non-zero rows hold, at most dec_max;
/// - per side: a fact per drawn code (summed less merged), the merged codes' one fact and words, the codes held, the
///   codes zero on every row (named in the zero line), the registered codes the rows hold none of (empty);
/// - lines: the zero rows' count (and the all-zero codes' names), the unrowed pairs' count, each excluded code's words.
fn pairs_declared(layer: &str, d: &J, page_in: &J, reg: &J) -> Result<J, String> {
    let (mut sels, mut given) = selects_of(page_in, reg)?;
    for s in d.g("selects").arr() {
        let mut x = sub(&J::Obj(s.obj().iter().filter(|(k, _)| k != "given").cloned().collect()), page_in)?;
        if let Some(k) = x.g("share").g("knob").s().map(str::to_string) {
            x.set("share", J::Num(knob_default(layer, &k)?));
        }
        if let Some(g) = s.get("given") {
            given.push((st(s.g("id")), sub(g, page_in)?));
        }
        sels.push(x);
    }
    // what the flow's registry asks for on each side and leaves out (the page input's pairs, a run fact): each a
    // registry_list select the core reads again from the registry, so a list that is not the registry's refuses the page
    let (pairs_in, sh) = (page_in.g("pairs"), page_in.g("shape"));
    let table = st(pairs_in.g("table"));
    let lists = [
        ("pairs_asked_source", format!("flow_asked:{table}:{}", st(sh.g("source"))), pairs_in.g("asked").at(0).clone()),
        ("pairs_asked_target", format!("flow_asked:{table}:{}", st(sh.g("target"))), pairs_in.g("asked").at(1).clone()),
        ("pairs_excluded", format!("flow_excluded:{table}"), pairs_in.g("excluded").clone()),
    ];
    for (id, registry, result) in lists {
        sels.push(J::obj_of(vec![("id", J::str(id)), ("kind", J::str("registry_list")), ("registry", J::Str(registry))]));
        given.push((id.to_string(), result));
    }
    let (bad, got) = recompute(page_in, &sels, &given);
    if !bad.is_empty() {
        return Err(format!("{layer}: its selects do not recompute: {}", bad.iter().take(3).cloned().collect::<Vec<_>>().join("; ")));
    }
    let codes = |id: &J| -> Vec<String> { got.get(&st(id)).map(|c| c.arr().iter().map(st).collect()).unwrap_or_default() };
    let listed = |id: &str| codes(&J::str(id));
    let (main, year, fmt, unit) = (st(sh.g("main")), st(sh.g("year")), st(sh.g("fmt")), st(sh.g("unit")));
    let (source, target) = (st(sh.g("source")), st(sh.g("target")));
    let words = |k: &str, ctx: &[(&str, &str)]| -> String {
        d.g("stops").g(k).arr().iter().map(|w| ctx.iter().fold(st(w), |t, (a, b)| t.replace(&format!("{{{a}}}"), b))).collect()
    };
    let num = |r: &J| r.g("value").s().and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite());
    let rows: Vec<&J> = page_in
        .g("rows")
        .arr()
        .iter()
        .filter(|r| st(r.g("time")) == year && r.g("dims").g(&source).s().is_some() && r.g("dims").g(&target).s().is_some())
        .collect();
    let mut total = 0.0;
    for r in &rows {
        total += num(r).ok_or_else(|| format!("not this shape: {}", words("no_number", &[("src", &r.g("src").to_value().to_string())])))?;
    }
    if total <= 0.0 {
        return Err(format!("not this shape: {}", words("no_flow", &[("main", &main), ("year", &year)])));
    }
    let (zeros, flows): (Vec<&J>, Vec<&J>) = rows.iter().copied().partition(|r| num(r) == Some(0.0));
    let ordered: Vec<J> = flows.iter().map(|r| J::Arr(vec![(*r).clone(), J::Bool(true)])).chain(zeros.iter().map(|r| J::Arr(vec![(*r).clone(), J::Bool(false)]))).collect();
    let dec = flows.iter().filter_map(|r| r.g("value").s()).map(|v| v.split_once('.').map_or(0, |(_, x)| x.len())).max().unwrap_or(0);
    let moved = page_scale(page_in).num().filter(|x| *x > 0.0).map_or(0, |x| (-x.log10()).round() as usize);
    let dec = (dec + moved).min(d.g("dec_max").num().unwrap_or(0.0) as usize);
    let fmts = J::obj_of(vec![(fmt.as_str(), J::obj_of(vec![("scale", page_scale(page_in)), ("dec", J::Int(dec as i64)), ("suffix", sh.g("suffix").clone())]))]);
    let fixed = vec![
        (format!("name:{}", st(d.g("title").g("fixed"))), frame_words(&st(d.g("title").g("frame")))?),
        (format!("name:{}{unit}", st(d.g("unit").g("fixed_prefix"))), st(page_in.g("short"))),
    ];
    let q = |filter: J| J::obj_of(vec![("op", J::str("value")), ("table", J::str(&main)), ("filter", filter), ("time", J::str(&year)), ("fmt", J::str(&fmt))]);
    let mut facts = J::Obj(vec![]);
    let mut leaf = J::obj_of(vec![
        ("title", J::Arr(vec![J::obj_of(vec![("src", J::Str(fixed[0].0.clone()))])])),
        ("unit", J::Arr(vec![J::obj_of(vec![("src", J::Str(fixed[1].0.clone()))]), J::obj_of(vec![("w", d.g("unit").g("words").clone())])])),
        ("source_kind", J::str(&source)),
        ("target_kind", J::str(&target)),
    ]);
    let link = |r: &&J| J::obj_of(vec![("source", r.g("dims").g(&source).clone()), ("target", r.g("dims").g(&target).clone()), ("value", r.g("src").clone())]);
    leaf.set("flows", J::Arr(flows.iter().map(link).collect()));
    let (mut node_text, mut empty, mut all_zero, mut names, mut held) = (J::Obj(vec![]), J::Obj(vec![]), Vec::new(), Vec::new(), Vec::new());
    let (mut node_share, mut side_total) = (J::Obj(vec![]), J::Obj(vec![]));
    let excluded: Vec<String> = listed("pairs_excluded");
    for (i, (sd, dim)) in d.g("sides").arr().iter().zip([&source, &target]).enumerate() {
        let (summed, merged, side_held) = (codes(sd.g("summed")), codes(sd.g("merged")), codes(sd.g("held")));
        let drawn: Vec<&String> = summed.iter().filter(|c| !merged.contains(c)).collect();
        let node = st(sd.g("node"));
        for c in &drawn {
            let key = format!("{node}.{c}");
            facts.set(&key, q(J::obj_of(vec![(dim.as_str(), J::str(c))])));
            node_text.set(c, J::Str(format!("fact:{key}.n")));
        }
        if !merged.is_empty() {
            let key = format!("{node}_other");
            facts.set(&key, q(J::obj_of(vec![(dim.as_str(), J::strs(&merged))])));
            leaf.set(&format!("other_{}", st(sd.g("side"))), J::obj_of(vec![
                ("name", J::Arr(vec![J::obj_of(vec![("w", sd.g("other").clone())])])),
                ("members", J::strs(&merged)),
                ("value_text", J::Str(format!("fact:{key}.n"))),
                ("members_head", J::Arr(vec![J::obj_of(vec![("w", sd.g("head").clone())])])),
            ]));
        }
        let zero_only: Vec<&String> = side_held.iter().filter(|c| !summed.contains(c)).collect();
        // the codes the registry asks for on this side (the flow's run fact) the rows hold none of
        let none: Vec<String> = listed(["pairs_asked_source", "pairs_asked_target"][i]).into_iter().filter(|c| !side_held.contains(c)).collect();
        if !none.is_empty() {
            empty.set(&st(sd.g("side")), J::strs(&none));
        }
        let left_out: &[String] = if i == 0 { &excluded } else { &[] };
        // B1 (owner 11-04): the side's whole (every code it sums, the merged ones too), printed as any value is, and each
        // drawn node's share of it, so the leaf's note at a side's largest node says how much of the side it holds; only
        // when the side is the whole the registry asks for (no code it asks for missing from the rows, none left out),
        // else nothing is said. The whole sums the side's codes, a total the nodes' comparison set leaves out by its row
        // type (the core's rule, line 1)
        if none.is_empty() && left_out.is_empty() {
            let whole = format!("{node}_total");
            facts.set(&whole, q(J::obj_of(vec![(dim.as_str(), J::strs(&summed))])));
            side_total.set(&st(sd.g("side")), J::Str(format!("fact:{whole}.n")));
            for c in &drawn {
                let key = format!("{node}_share.{c}");
                facts.set(&key, J::obj_of(vec![("op", J::str("share")), ("a", J::Str(format!("{node}.{c}"))), ("b", J::Str(whole.clone())), ("fmt", J::str("pct"))]));
                // the share's whole text (its percent sign), as every share on a page prints
                node_share.set(c, J::Str(format!("fact:{key}")));
            }
        }
        let named: Vec<String> = drawn.iter().map(|c| c.to_string()).chain(merged.iter().cloned()).chain(zero_only.iter().map(|c| c.to_string())).chain(left_out.iter().cloned()).collect();
        names.push(J::obj_of(vec![("kind", J::str(dim)), ("codes", J::strs(&named)), ("labels", J::Bool(true))]));
        all_zero.extend(zero_only.iter().map(|c| J::obj_of(vec![("src", J::Str(format!("name:zh_names:{dim}:{c}")))])));
        held.push(side_held);
    }
    let k = |name: &str| st(d.g("keys").g(name));
    let w = |name: &str| d.g("words").g(name).clone();
    let piece = |x: &J| J::obj_of(vec![("w", x.clone())]);
    let fact_ref = |key: &str| J::obj_of(vec![("src", J::Str(format!("fact:{key}.n")))]);
    let mut lines: Vec<J> = Vec::new();
    if !zeros.is_empty() {
        facts.set(&k("zeros"), J::obj_of(vec![("op", J::str("zeros")), ("table", J::str(&main)), ("time", J::str(&year)), ("fmt", J::str("n"))]));
        let z = w("zero");
        let mut line = vec![piece(z.at(0)), fact_ref(&k("zeros")), piece(z.at(1))];
        if !all_zero.is_empty() {
            let a = w("all_zero");
            line.push(piece(a.at(0)));
            for (n, name) in all_zero.into_iter().enumerate() {
                if n > 0 {
                    line.push(piece(a.at(1)));
                }
                line.push(name);
            }
            line.push(piece(a.at(2)));
        }
        lines.push(J::Arr(line));
    }
    let has_row = |a: &str, b: &str| rows.iter().any(|r| r.g("dims").g(&source).s() == Some(a) && r.g("dims").g(&target).s() == Some(b));
    if held[0].iter().any(|a| held[1].iter().any(|b| !has_row(a, b))) {
        let by = J::strs(&[source.clone(), target.clone()]);
        facts.set(&k("unrowed"), J::obj_of(vec![("op", J::str("unrowed")), ("table", J::str(&main)), ("time", J::str(&year)), ("by", by),
            ("codes", J::Arr(vec![J::strs(&held[0]), J::strs(&held[1])])), ("fmt", J::str("n"))]));
        let u = w("unrowed");
        lines.push(J::Arr(vec![piece(u.at(0)), fact_ref(&k("unrowed")), piece(u.at(1))]));
    }
    if !excluded.is_empty() {
        let targets: Vec<String> = page_in.g("pairs").g("target_parts").arr().iter().map(st).collect();
        let pairs: Vec<J> = excluded.iter().flat_map(|x| targets.iter().map(move |t| J::strs(&[x.clone(), t.clone()]))).collect();
        facts.set(&k("excluded"), J::obj_of(vec![("op", J::str("excluded")), ("table", J::str(&main)), ("time", J::str(&year)),
            ("by", J::strs(&[source.clone(), target.clone()])), ("pairs", J::Arr(pairs)), ("fmt", J::str("n"))]));
        for c in &excluded {
            lines.push(J::Arr(vec![J::obj_of(vec![("src", J::Str(format!("name:zh_names:{source}:{c}")))]), piece(&w("excluded"))]));
        }
    }
    leaf.set("node_text", node_text);
    leaf.set("node_share", node_share);
    leaf.set("side_total", side_total);
    if empty.truthy() {
        leaf.set("empty", empty);
    }
    if !lines.is_empty() {
        leaf.set("lines", J::Arr(lines));
    }
    Ok(J::obj_of(vec![
        ("ordered", J::Arr(ordered)),
        ("facts", facts),
        ("fmts", fmts),
        ("data", J::obj_of(vec![("table", J::str(&main)), ("year", J::str(&year))])),
        ("leaves", J::Obj(vec![(layer.to_string(), leaf)])),
        ("names", J::Arr(names)),
        ("fixed", J::Arr(fixed.into_iter().map(|(s, t)| J::Arr(vec![J::Str(s), J::Str(t)])).collect())),
        ("unit_drawn", J::Bool(true)),
    ]))
}

/// declares.values: each a value the declaration's templates read as `$value.<name>`, by its rule over the page input.
/// months_back: the month `span` - 1 months before the last of `months` (the layer's own knob `span.knob`, the leaf
/// registry's default, as Request::Knob reads it), no earlier than the first. last_month: the last of `months`. With
/// `within: [year a, year b]` the months are first kept to b's December, the last of those being last_month's, then to
/// a's January for months_back. No month refuses: in the registry's words when the rule gives them (`stop`: the page
/// is not this shape, "not this shape: <words>", which declare passes on as the page's own stop), else the generator's.
pub(crate) fn value_of(layer: &str, name: &str, r: &J) -> Result<J, String> {
    let none = || match r.get("stop") {
        Some(w) => format!("not this shape: {}", w.arr().iter().map(st).collect::<String>()),
        None => format!("{layer}: value {name}: no month"),
    };
    let mut months: Vec<String> = r.g("months").arr().iter().map(st).collect();
    let mut kept_last = months.last().cloned();
    if let [a, b] = r.g("within").arr() {
        let (a, b) = (format!("{}-01", st(a)), format!("{}-12", st(b)));
        months.retain(|t| *t <= b);
        kept_last = months.last().cloned();
        months.retain(|t| *t >= a);
    }
    match r.g("rule").s() {
        Some("last_month") => Ok(J::Str(kept_last.ok_or_else(none)?)),
        Some("months_back") => {
            let span = knob_default(layer, &st(r.g("span").g("knob"))).map_err(|e| format!("{layer}: value {name}: {e}"))? as i64;
            kept_last.as_ref().ok_or_else(none)?;
            let (first, last) = (months.first().ok_or_else(none)?, months.last().ok_or_else(none)?);
            let (y, m): (i64, i64) = (last.get(..4).and_then(|y| y.parse().ok()).ok_or_else(none)?, last.get(5..).and_then(|m| m.parse().ok()).ok_or_else(none)?);
            let i = y * 12 + m - 1 - (span - 1);
            let from = format!("{}-{:02}", i.div_euclid(12), i.rem_euclid(12) + 1);
            Ok(J::Str(if from < *first { first.clone() } else { from }))
        }
        r => Err(format!("{layer}: value {name}: rule {} is not one the generator computes", r.unwrap_or("none"))),
    }
}

/// A layer's page input with its declaration's values (declares.values) under `value`, each by its rule (value_of, or
/// extent_of for rule extent); None when the declaration has none. declared_j and tree_j both read a layer's templates over
/// it, so the leaf's data and the tree's node hold one value.
fn with_values(layer: &str, page_in: &J, reg: &J) -> Result<Option<J>, String> {
    let d = declares(reg, layer, page_in)?;
    let Some(vs) = d.get("values") else { return Ok(None) };
    let mut vals = J::Obj(vec![]);
    for (k, r) in vs.obj() {
        let r = sub(r, page_in)?;
        let v = match r.g("rule").s() {
            Some("extent") => extent_of(layer, k, &r, page_in, reg)?,
            _ => value_of(layer, k, &r)?,
        };
        vals.set(k, v);
    }
    let mut v = page_in.clone();
    v.set("value", vals);
    Ok(Some(v))
}

/// A label's rough width at `size` px, as the second layer measures it (prod.tw): a CJK character the size, any other about
/// half.
fn label_px(s: &str, size: f64) -> f64 {
    s.chars().map(|c| if c as u32 > 0x2e7f { size } else { 0.58 * size }).sum()
}

/// A value as the circles print it bare (fact .n): `dec` places, a comma between thousands.
fn printed_len(v: f64, dec: usize) -> usize {
    let s = format!("{:.*}", dec, v.abs());
    let int = s.split('.').next().map_or(0, str::len);
    s.len() + int.saturating_sub(1) / 3 + usize::from(v < 0.0)
}

/// Rule extent: the view frame's extent (lon0, lat0, lon1, lat1) over the page input's map points (`points.at`, a flow
/// fact): the points' box, past each side as far as the circle nearest it needs for its label there, and the frame's `pad`
/// at least, clamped to the globe. A circle's label: its name (the page input's names, else its code) or its number (the
/// main's row at the year for each ranked code, printed with the decimals those rows hold, at most `dec_max`), the wider;
/// its room beside the circle its radius (by its value's area, the `circles` node's knobs r_max and r_min), the knob
/// label_gap and 1, the label's width and the frame's inset and 2 (the leaf's own margins); above or below the same with
/// 2.45 label lines (the node's text size) for the width. A point without a row is measured at r_max by its code. The px
/// become degrees through the frame the leaves project it in (W = the frame's w px over the span; a degree of latitude that
/// over the cosine of the middle latitude + 2), which the padding itself changes, so the padding grows until it holds (at
/// most 64 rounds; it only grows, the globe bounds it). Moved from the flow (P6 step 8), every operation in its order.
pub(crate) fn extent_of(layer: &str, name: &str, r: &J, page_in: &J, reg: &J) -> Result<J, String> {
    let no = |what: String| format!("{layer}: value {name}: {what}");
    let (frame, circles) = (st(r.g("frame")), st(r.g("circles")));
    let fr = reg.g("frames").g(&frame);
    let node = reg.g("nodes").g(&circles);
    let num = |v: &J, what: &str| v.num().ok_or_else(|| no(format!("no {what}")));
    let (w_px, inset, pad) = (num(fr.g("w"), "frame w")?, num(fr.g("inset"), "frame inset")?, num(fr.g("pad"), "frame pad")?);
    let knobs = node.g("knobs");
    let (r_max, r_min, gap) = (num(knobs.g("r_max"), "knob r_max")?, num(knobs.g("r_min"), "knob r_min")?, num(knobs.g("label_gap"), "knob label_gap")?);
    let size = num(node.g("texts").g("size"), "text size")?;
    let dec_max = num(r.g("dec_max"), "dec_max")? as usize;
    let mut points: Vec<(String, [f64; 2])> = Vec::new();
    for (code, p) in page_in.g("points").g("at").obj() {
        match p.arr() {
            [lon, lat] => points.push((code.clone(), [num(lon, "point")?, num(lat, "point")?])),
            _ => return Err(no(format!("point {code} is no [lon, lat]"))),
        }
    }
    if points.is_empty() {
        return Err(no("no map point".into()));
    }
    let shape = page_in.g("shape");
    let (place, year) = (st(shape.g("place")), shape.g("year"));
    let ranked = page_in.g("picks").g("ranked").arr();
    let kept: Vec<&J> = page_in
        .g("rows")
        .arr()
        .iter()
        .filter(|r| r.g("time") == year && r.g("dims").g(&place).s().is_some() && ranked.contains(r.g("dims").g(&place)))
        .collect();
    let dec = kept.iter().filter_map(|r| r.g("value").s()).map(|v| v.split_once('.').map_or(0, |(_, d)| d.len())).max().unwrap_or(0).min(dec_max);
    let names = page_in.g("names");
    let mut labels: std::collections::BTreeMap<String, (f64, String)> = std::collections::BTreeMap::new();
    for r in &kept {
        let code = st(r.g("dims").g(&place));
        let Some(v) = r.g("value").s().and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite()) else { continue };
        let named = names.g(&code).s().map_or_else(|| code.clone(), str::to_string);
        labels.insert(code, (v, named));
    }
    // a circle's area is its value's size: a value below 0 is drawn by its size, outlined (bubbles.py, 11-07)
    let vmax = labels.values().map(|(v, _)| v.abs()).fold(0.0, f64::max);
    let edge = inset + 2.0;
    let room: Vec<([f64; 2], (f64, f64))> = points
        .iter()
        .map(|(code, p)| {
            let (r, w) = match labels.get(code) {
                Some((v, name)) => {
                    let r = match vmax > 0.0 {
                        true => (r_max * (v.abs() / vmax).sqrt()).max(r_min),
                        false => r_min,
                    };
                    (r, label_px(name, size).max(printed_len(*v, dec) as f64 * label_px("0", size)))
                }
                None => (r_max, label_px(code, size)),
            };
            let side = r + gap + 1.0 + w + edge;
            (*p, (side, r + gap + 1.0 + 2.45 * size + edge))
        })
        .collect();
    let least = |i: usize| points.iter().map(|(_, p)| p[i]).fold(f64::INFINITY, f64::min);
    let most = |i: usize| points.iter().map(|(_, p)| p[i]).fold(f64::NEG_INFINITY, f64::max);
    let (lon0, lat0, lon1, lat1) = (least(0), least(1), most(0), most(1));
    let clamp = |e: [f64; 4]| [e[0].max(-180.0), e[1].max(-90.0), e[2].min(180.0), e[3].min(90.0)];
    let mut ext = clamp([lon0 - pad, lat0 - pad, lon1 + pad, lat1 + pad]);
    for _ in 0..64 {
        let x_px = w_px / (ext[2] - ext[0]);
        let y_px = x_px / ((ext[1] + ext[3]) / 2.0 + 2.0).to_radians().cos().max(0.05);
        // the degrees each side needs: the room of each point there, less how far inside the box's edge it already is
        let side = |far: &dyn Fn(&[f64; 2]) -> f64, px: f64, beside: bool| {
            room.iter().map(|(p, (h, v))| (if beside { *h } else { *v }) / px - far(p)).fold(pad, f64::max)
        };
        let next = clamp([
            ext[0].min(lon0 - side(&|p| p[0] - lon0, x_px, true)),
            ext[1].min(lat0 - side(&|p| p[1] - lat0, y_px, false)),
            ext[2].max(lon1 + side(&|p| lon1 - p[0], x_px, true)),
            ext[3].max(lat1 + side(&|p| lat1 - p[1], y_px, false)),
        ]);
        let moved = next.iter().zip(ext).any(|(a, b)| (a - b).abs() > 1e-9);
        ext = next;
        if !moved {
            break;
        }
    }
    Ok(J::Arr(ext.iter().map(|x| J::Num(*x)).collect()))
}

/// The declaration shape of a page's finding (finding_declared).
const FINDING: &str = "finding";

/// The page's finding (node finding, declared for the page's recipe): the first case whose `if` holds over the core's
/// recomputed selects (a rank's key at its first or last code above or below a bound) is the page's, and no other is tried;
/// its subject (and other) are the codes the core's take selects hold, with no finding when either is none (a tie), its
/// key is not above `key_above`, the subject's key is not above the other's (`higher`), a code it names is one the page's
/// labels name none of (`named`), or a fact it needs is not the page's (`facts_have`). Then its facts (templates over the
/// subject's code, the other's and the first group's), the rows it reads (the subject's at `reads.times`), and its dek and
/// headline in shape_registry's words (DEK_FINDINGS, HEADLINES) with each token the case's template. Every input but the
/// rows is the page's own fill: `fill` {facts: keys, fmts, named: codes, composition: {bars}}, which the flow gives when it
/// asks and the draw recheck reads from the finished fill. {facts, reads, finding, subject}; a page with none: no finding.
fn finding_declared(d: &J, page_in: &J, reg: &J) -> Result<J, String> {
    // no finding, and why (`fell_back`: the page's title falls back to the text step's label, which the run records)
    let none = |why: &str| J::obj_of(vec![("facts", J::Obj(vec![])), ("reads", J::Arr(vec![])), ("finding", J::Null), ("subject", J::Null), ("fell_back", J::Str(why.to_string()))]);
    let fill = page_in.g("fill");
    let has_fact = |k: &str| fill.g("facts").arr().iter().any(|x| x.s() == Some(k));
    if d.g("rule").s() == Some("none") {
        return Ok(none("the recipe declares no finding"));
    }
    if !d.g("needs_facts").arr().iter().all(|k| has_fact(&st(k))) {
        return Ok(none("a fact the finding needs is not the page's"));
    }
    // each page input value the finding needs, there and not empty (a path the page input lacks is none)
    for path in d.g("requires").arr() {
        let held = st(path).strip_prefix('$').map(|p| p.split('.').try_fold(page_in, |x, k| x.get(k))).ok_or_else(|| format!("finding: requires {}: no path", path.repr()))?;
        if !held.is_some_and(J::truthy) {
            return Ok(none("a page input value the finding needs is empty"));
        }
    }
    // the format a change prints in: the registry's by the unit's short form (a gap of percentages in points)
    let mut view = page_in.clone();
    if let Some(cf) = d.get("change_fmt") {
        let pick = if page_in.g("short").s() == cf.g("short").s() { cf.g("then") } else { cf.g("else") };
        // a key or a page input path ($shape.fmt: a level's own format, a column's gap in its unit)
        view.set("fmt", J::obj_of(vec![("change", sub(pick, page_in)?)]));
    }
    let view = &view;
    let (mut sels, mut given) = selects_of(view, reg)?;
    for s in d.g("selects").arr() {
        // a select only a case's when_scoped part reads is made on a narrowed page only
        if s.g("scoped_only").truthy() && !view.g("scoped").truthy() {
            continue;
        }
        if let (Some("given"), Some(g)) = (s.g("kind").s(), s.get("given")) {
            given.push((st(s.g("id")), sub(g, view)?));
        }
        sels.push(sub(&J::Obj(s.obj().iter().filter(|(k, _)| k != "given" && k != "scoped_only").cloned().collect()), view)?);
    }
    let (bad, got) = recompute_over(view, &sels, &given, fill.g("fmts"));
    if !bad.is_empty() {
        return Err(format!("finding: its selects do not recompute: {}", bad.iter().take(3).cloned().collect::<Vec<_>>().join("; ")));
    }
    let refs: Vec<(String, &J)> = sels.iter().map(|s| (st(s.g("id")), s)).collect();
    let rows = view.g("rows").arr();
    let key = |sid: &str, code: &J| core::take_value(&refs, sid, code, rows);
    // the first case whose bound holds over its select's first or last code
    let mut case = None;
    for c in d.g("cases").arr() {
        let cond = c.g("if");
        let holds = match cond.get("key_of") {
            None => true,
            Some(sid) => {
                let codes = got.get(&st(sid)).map(|x| x.arr().to_vec()).unwrap_or_default();
                let at = if cond.g("at").s() == Some("last") { codes.last() } else { codes.first() };
                match at {
                    None => false,
                    Some(code) => {
                        let v = key(&st(sid), code)?;
                        cond.g("above").num().is_none_or(|b| v > b) && cond.g("below").num().is_none_or(|b| v < b)
                    }
                }
            }
        };
        if holds {
            case = Some(c);
            break;
        }
    }
    let Some(c) = case else { return Ok(none("no case of the finding holds")) };
    // on a page the program narrowed, the last kept place is where the cut fell, not the lowest of all: a case's
    // when_scoped part (each key replacing the case's, an object merged key by key) holds there, so the finding compares
    // with a place the cut does not decide
    let merged;
    let c = match (view.g("scoped").truthy(), c.get("when_scoped")) {
        (true, Some(o)) => {
            let mut m = c.clone();
            for (k, v) in o.obj() {
                let mut put = v.clone();
                if let (Some(J::Obj(base)), J::Obj(over)) = (c.get(k), v) {
                    let mut b = J::Obj(base.clone());
                    for (kk, vv) in over {
                        b.set(kk, vv.clone());
                    }
                    put = b;
                }
                m.set(k, put);
            }
            merged = m;
            &merged
        }
        _ => c,
    };
    let pick = |k: &str| -> Option<J> { c.get(k).and_then(|sid| got.get(&st(sid))).filter(|x| !x.is_null()).cloned() };
    let Some(subject) = pick("subject") else { return Ok(none("no single subject (a tie)")) };
    let other = pick("other");
    if c.has("other") && other.is_none() {
        return Ok(none("no single other (a tie)"));
    }
    let sid = st(c.g("subject"));
    if let Some(b) = c.g("key_above").num() {
        if key(&sid, &subject)? <= b {
            return Ok(none("the subject's key is not above the bound"));
        }
    }
    if let (true, Some(o)) = (c.g("higher").truthy(), &other) {
        if key(&sid, &subject)? <= key(&st(c.g("other")), o)? {
            return Ok(none("the subject is not above the other"));
        }
    }
    // a change whose start is zero has no share of that start (the ring's lead, its gap over lead0): no finding, and the
    // fall back says why, never a page stop at the core's share; the start is the subject's value at the change rank's
    // earlier time (its key {"change": [t0, t1]}), read as the rank reads it
    if c.g("start_above_zero").truthy() {
        let root = core::root_rank(&refs, &sid)?;
        let Some(t0) = core::change_from(root) else {
            return Err(format!("finding: start_above_zero on a select whose rank is not a change: {sid}"));
        };
        let mut over = root.g("over").clone();
        over.set("time", t0.clone());
        let mut at_start = root.clone();
        at_start.set("over", over);
        at_start.set("key", J::str("value"));
        if core::take_value(&[("start".to_string(), &at_start)], "start", &subject, rows)? == 0.0 {
            return Ok(none("the change starts at zero: no share of its start"));
        }
    }
    // a template over the case's codes: its paths, then the subject's code ({code}, {code_lc}, the years), the other's
    // ({other}) and the first group's ({group})
    let code = st(&subject);
    let group = st(view.g("composition").g("first_group"));
    let other_code = other.as_ref().map(st).unwrap_or_default();
    let put = |v: &J| -> Result<J, String> {
        fn walk(v: &J, ctx: &[(&str, &str)]) -> J {
            let put = |s: &str| ctx.iter().fold(s.to_string(), |s, (k, v)| s.replace(k, v));
            match v {
                J::Str(s) => J::Str(put(s)),
                J::Arr(a) => J::Arr(a.iter().map(|x| walk(x, ctx)).collect()),
                J::Obj(o) => J::Obj(o.iter().map(|(k, x)| (put(k), walk(x, ctx))).collect()),
                x => x.clone(),
            }
        }
        let v = core::with_code(&sub(v, view)?, &code, view);
        Ok(walk(&v, &[("{other}", other_code.as_str()), ("{group}", group.as_str())]))
    };
    let named = |x: &J| fill.g("named").arr().contains(x);
    for n in c.g("named").arr() {
        if !named(&put(n)?) {
            return Ok(none("a code it names is one the labels name none of"));
        }
    }
    for k in c.g("facts_have").arr() {
        if !has_fact(&st(&put(k)?)) {
            return Ok(none("a fact the case needs is not the page's"));
        }
    }
    let facts = put(c.g("facts"))?;
    let reads = match c.get("reads") {
        Some(r) => {
            let times = sub(r.g("times"), view)?;
            let place = st(view.g("shape").g("place"));
            rows.iter().filter(|x| times.arr().contains(x.g("time")) && x.g("dims").g(&place) == &subject).cloned().collect()
        }
        None => Vec::new(),
    };
    // the words: shape_registry's sentence of the case's finding, each token its template over the codes
    let name = st(c.g("finding"));
    let of = |table: &[(crate::shape_registry::Finding, &'static str, &'static str)]| table.iter().find(|(f, _, _)| format!("{f:?}") == name).map(|&(_, a, b)| (a, b));
    let Some((plain, scoped)) = of(&crate::shape_registry::DEK_FINDINGS) else {
        return Err(format!("not this shape: no DEK_FINDINGS words for {name}"));
    };
    // each token as written (never read as a template), its text the case's template over the codes
    let mut tokens: Vec<(String, String)> = c.g("words").obj().iter().map(|(k, v)| Ok((k.clone(), st(&put(v)?)))).collect::<Result<_, String>>()?;
    // the compared set the scoped wording names ({set}): the declaration's own words (a composition cut's), or the narrow
    // record's registered scope words the flow passes (page input set: {words with {n}, members}) with {n} the fact of the
    // places drawn (set_count, which the core recomputes from the rows of the select set_of). The record's members must be
    // the places the page compares (the core's recomputed set_of select), else the words would name a set the page does not
    // show (a member with no value at the page's year) and the page has no finding; a page the program narrowed with no set
    // words has none either. The subject must be one of those places (the set_of select's codes), else the set words would
    // place it among places it is not: a declaration whose plain words claim nothing of the set (outside_set "plain", the
    // ring's own rise or fall) then says them in its scoped wording too, and any other has no finding.
    let set = match (d.g("set_words").s(), view.g("set").g("words").s()) {
        (Some(w), _) => Some(w.to_string()),
        (None, Some(w)) => {
            let count = st(d.g("set_count"));
            let compared = got.get(&st(d.g("set_of")));
            if count.is_empty() || !has_fact(&count) {
                return Ok(none("a narrowed page whose recipe declares no count of its set"));
            }
            if compared.is_none() || view.g("set").g("members").num() != compared.map(|x| x.arr().len() as f64) {
                return Ok(none("the narrow record's member count is not the places compared"));
            }
            match compared.is_some_and(|x| x.arr().contains(&subject)) {
                true => Some(w.replace("{n}", &format!("{{{count}}}"))),
                false if d.g("outside_set").s() == Some("plain") => None,
                false => return Ok(none("the subject is not among the places the set names")),
            }
        }
        (None, None) if view.g("scoped").truthy() => return Ok(none("a narrowed page whose recipe names no set")),
        (None, None) => None,
    };
    tokens.push(("{set}".to_string(), set.clone().unwrap_or_default()));
    let worded = |t: &str| J::Str(tokens.iter().fold(t.to_string(), |t, (k, v)| t.replace(k.as_str(), v)));
    let mut said = J::obj_of(vec![("dek", worded(plain)), ("scoped", worded(scoped))]);
    if let Some(set) = set {
        said.set("set", J::Str(set));
    }
    let headline = of(&crate::shape_registry::HEADLINES).filter(|_| c.g("headline_needs_facts").arr().iter().all(|k| has_fact(&st(k))));
    // a headline that says how many times the other the subject is reads only over an other above 0 (11-07: a level page with
    // a value below 0 draws now; "是最低者的 -3.2 倍" would say nothing true): else the title stays the text step's label
    let ratio_holds = match (c.g("headline_needs_other_above_0").truthy(), &other) {
        (false, _) => true,
        (true, Some(o)) => key(&st(c.g("other")), o)? > 0.0,
        (true, None) => false,
    };
    let mut out = J::obj_of(vec![("facts", facts), ("reads", J::Arr(reads)), ("finding", J::Null), ("subject", subject)]);
    // with the ratio not holding, a level finding keeps a headline without it (LEVEL_PLAIN_HEADLINE)
    let headline = match (headline, ratio_holds) {
        (Some(_), false) if name == "Level" => Some(crate::shape_registry::LEVEL_PLAIN_HEADLINE),
        (h, true) => h,
        (_, false) => None,
    };
    match headline {
        Some((plain, scoped)) => said.set("headline", J::obj_of(vec![("title", worded(plain)), ("scoped", worded(scoped))])),
        None if !ratio_holds => out.set("fell_back", J::str("the finding has no headline: its ratio's other is not above 0")),
        None => out.set("fell_back", J::str("the finding has no headline: a fact it needs is not the page's")),
    }
    out.set("finding", said);
    Ok(out)
}

/// The mean a note compares with ("图中平均", the leader notes' mean_n, or mean_n0 and mean_n1 at a change's two ends: a
/// count of the places averaged) is over exactly the places the page draws, at each end: the places its averaged rows hold at their time are as many as the page's drawn
/// count (its `drawn` fact, a plain count over the rows the page keeps), else the page stops. A page with no such mean
/// passes.
fn mean_recheck(fill: &J) -> Result<(), String> {
    let facts = fill.g("knobs").g("spec").g("facts");
    // every count of a mean the page holds: a column's (mean_n), a change's at both ends (mean_n0 at t0, mean_n1 at the year)
    let counts: Vec<(&str, &J)> = ["mean_n", "mean_n0", "mean_n1"].iter().filter_map(|k| facts.get(k).map(|q| (*k, q))).collect();
    if counts.is_empty() {
        return Ok(());
    }
    let rows = fill.g("rows").arr();
    // the distinct codes of `by` among the kept rows of the count's table at its time, its filter's codes only when it has one
    let places = |q: &J| -> Vec<J> {
        let by = st(q.g("by"));
        let mut out: Vec<J> = Vec::new();
        for r in rows.iter().filter(|r| r.g("table") == q.g("table") && r.g("time") == q.g("time")) {
            let held = q.g("filter").obj().iter().all(|(d, c)| match c {
                J::Arr(codes) => codes.contains(r.g("dims").g(d)),
                c => r.g("dims").g(d) == c,
            });
            if held && !out.contains(r.g("dims").g(&by)) {
                out.push(r.g("dims").g(&by).clone());
            }
        }
        out
    };
    let drawn = facts.g("drawn");
    let shown = places(drawn).len();
    for (key, q) in counts {
        if drawn.g("op").s() != Some("n") || drawn.get("filter").is_some() || q.g("op").s() != Some("n") {
            return Err(format!("node leader_notes: the mean's count {key} and the page's drawn count must both be plain counts"));
        }
        let averaged = places(q).len();
        if averaged != shown {
            return Err(format!("node leader_notes: the mean is over {averaged} places ({key}), the page draws {shown} (drawn)"));
        }
    }
    Ok(())
}

/// The page's finding declared again over the finished fill (its facts' keys and formats, its labels' codes and its
/// composition's bars, never what the flow handed in), and held to the page: each fact it declares, each row it reads among
/// the page's, its dek's and its headline's words, and the accent (the subject when ranked, else none).
fn finding_recheck(page_in: &J, fill: &J, reg: &J) -> Result<(), String> {
    let Some(d) = declares(reg, FINDING, page_in).ok().filter(|d| d.g("shape").s() == Some(FINDING)) else { return Ok(()) };
    let spec = fill.g("knobs").g("spec");
    let keys = |o: &J| J::Arr(o.obj().iter().map(|(k, _)| J::Str(k.clone())).collect());
    let mut own = J::obj_of(vec![("facts", keys(spec.g("facts"))), ("fmts", spec.g("fmts").clone()), ("named", keys(fill.g("knobs").g("labels")))]);
    if fill.g("composition").is_obj() {
        own.set("composition", J::obj_of(vec![("bars", fill.g("composition").g("bars").clone())]));
    }
    let mut view = page_in.clone();
    view.set("fill", own);
    let again = finding_declared(d, &view, reg).map_err(|e| format!("node finding: recheck over the finished fill: {e}"))?;
    for (k, q) in again.g("facts").obj() {
        if spec.g("facts").g(k) != q {
            return Err(format!("node finding: fact {k} is not its declaration: {}", q.repr()));
        }
    }
    let kept: Vec<&J> = fill.g("rows").arr().iter().map(|r| r.g("src")).collect();
    for r in again.g("reads").arr() {
        if !kept.contains(&r.g("src")) {
            return Err(format!("node finding: it reads row {}, which the page does not keep", r.g("src").repr()));
        }
    }
    let mut said = again.g("finding").clone();
    let headline = said.remove("headline").unwrap_or(J::Null);
    if fill.g("finding") != &said {
        return Err(format!("node finding: the dek's finding is not its declaration: {} != {}", fill.g("finding").repr(), said.repr()));
    }
    if fill.g("headline") != &headline {
        return Err(format!("node finding: the headline is not its declaration: {} != {}", fill.g("headline").repr(), headline.repr()));
    }
    // a set named with its count (set_count, a count of places over the page's kept rows, those its filter names when it
    // has one: the ring page keeps its members' rows beside the origins it compares): the count printed is the places the
    // finding compares (the record's members, held to the compared select at declaration), never one more for a total or
    // an aggregate row the page keeps
    if let (Some(_), Some(key)) = (said.get("set"), d.g("set_count").s()) {
        let q = spec.g("facts").g(key);
        let (by, table, time) = (st(q.g("by")), st(q.g("table")), st(q.g("time")));
        let passes = |r: &J| {
            q.g("filter").obj().iter().all(|(dim, codes)| match codes {
                J::Str(_) => r.g("dims").g(dim) == codes,
                J::Arr(a) => a.contains(r.g("dims").g(dim)),
                _ => false,
            })
        };
        let mut codes: Vec<&J> = Vec::new();
        for r in fill.g("rows").arr().iter().filter(|r| st(r.g("table")) == table && st(r.g("time")) == time && passes(r)) {
            if !codes.contains(&r.g("dims").g(&by)) {
                codes.push(r.g("dims").g(&by));
            }
        }
        let compared = page_in.g("set").g("members").num();
        if q.g("op").s() != Some("n") || compared != Some(codes.len() as f64) {
            return Err(format!(
                "node finding: the set's count {key} counts {} places over the page's rows, the finding compares {}",
                codes.len(),
                page_in.g("set").g("members").repr()
            ));
        }
    }
    let subject = again.g("subject");
    let accent = if page_in.g("picks").g("ranked").arr().contains(subject) { subject.clone() } else { J::Null };
    if spec.g("hero").g("data").g("accent") != &accent {
        return Err(format!("node finding: the accent is {}, its subject ranked is {}", spec.g("hero").g("data").g("accent").repr(), accent.repr()));
    }
    Ok(())
}

/// The declaration as JSON in the generator's own order (the prototype's), for the fixtures.

fn declared_j(layer: &str, page_in: &J, reg: &J) -> Result<J, String> {
    let d = declares(reg, layer, page_in)?;
    // a page input value the declaration cannot do without (declares.needs: its path, and the registry's words for the
    // page's stop when it is null): a stop in the registry's own words, as the rust fill's was
    for nd in d.g("needs").arr() {
        if sub(nd.g("path"), page_in)? == J::Null {
            let words = nd.g("stop").arr().iter().map(|w| sub(w, page_in).map(|x| st(&x))).collect::<Result<Vec<_>, _>>()?;
            return Err(format!("not this shape: {}", words.concat()));
        }
    }
    // the declaration's own values (declares.values), which its templates read beside the page input
    let view = with_values(layer, page_in, reg)?;
    let page_in = view.as_ref().unwrap_or(page_in);
    let (mut sels, mut given) = selects_of(page_in, reg)?;
    let (bad, mut got) = recompute(page_in, &sels, &given);
    if !bad.is_empty() {
        return Err(format!("{layer}: the core's selects do not recompute: {}", bad.iter().take(3).cloned().collect::<Vec<_>>().join("; ")));
    }
    // the layer's own selects (declares.selects), each only where its conditions hold over the page's selects
    let mut own = Vec::new();
    for s in d.g("selects").arr() {
        if core::conditions_hold(s.g("when"), &plain_holding(&got, page_in))? {
            // a given select's result is the flow's pick, as a pick rule's (selects_of)
            if let (Some("given"), Some(g)) = (s.g("kind").s(), s.get("given")) {
                given.push((st(s.g("id")), sub(g, page_in)?));
            }
            own.push(sub(&J::Obj(s.obj().iter().filter(|(k, _)| k != "when" && k != "given").cloned().collect()), page_in)?);
        }
    }
    if !own.is_empty() {
        sels.extend(own);
        let (bad, again) = recompute(page_in, &sels, &given);
        if !bad.is_empty() {
            return Err(format!("{layer}: its selects do not recompute: {}", bad.iter().take(3).cloned().collect::<Vec<_>>().join("; ")));
        }
        got = again;
    }
    // a declaration with no fmt declares no format and no fact of its own (the facts it prints are another layer's, which
    // owns their formats): one that declares facts, a change format, formats or a candidate's facts with no fmt refuses
    let mut fmts = J::Obj(vec![]);
    if d.has("fmt") {
        let mut fd = sub(d.g("fmt"), page_in)?;
        let rule = fd.remove("dec_rule").ok_or_else(|| format!("{layer}: declares.fmt has no dec_rule"))?;
        let dec = dec_of(layer, &rule, page_in, &got, fd.g("suffix") == page_in.g("shape").g("suffix"))?;
        let fd = J::obj_of(vec![("scale", fd.g("scale").clone()), ("dec", J::Int(dec)), ("suffix", fd.g("suffix").clone())]);
        fmts.set(&st(page_in.g("shape").g("fmt")), fd);
    } else if let Some(k) = ["facts", "fmt_change", "formats"].into_iter().find(|k| d.has(k)).or(carries_facts(d.g("candidates")).then_some("candidates' facts")) {
        return Err(format!("{layer}: declares {k} and no fmt; a declaration with no fmt declares no fact of its own"));
    }
    // a change's format, its key read by the facts that print in it ($fmt.change)
    let mut facts_in = page_in.clone();
    if let Some(fc) = d.get("fmt_change") {
        let (key, cfd) = change_fmt(layer, &sub(fc, page_in)?, page_in, &got)?;
        fmts.set(&key, cfd);
        facts_in.set("fmt", J::obj_of(vec![("change", J::Str(key))]));
    }
    // the facts, each code a select chose written as the code; the formats the declaration fixes (declares.formats)
    let mut facts = codes_in(&sub(d.g("facts"), &facts_in)?, &got);
    // for_code: the facts and hero keys of one code a select holds, `{code}` / `{code_lc}` read as it
    let for_code = match d.get("for_code") {
        Some(r) => Some(st(&core::resolve_ref(&st(r), &got)?)),
        None => None,
    };
    match &for_code {
        Some(c) => facts = core::with_code(&facts, c, page_in),
        // with no code, only the page's two years (`{y0}` / `{y1}`) are read; a code template with no code refuses
        None if facts.repr().contains("{code") => return Err(format!("{layer}: declares facts of a code and names no for_code")),
        None => facts = core::with_code(&facts, "", page_in),
    }
    // for_each: the facts of every code a select holds (declares.facts_each), in its order, `{code}` / `{code_lc}` read as
    // each; a fact with conditions (when) only for a code they hold for
    if let Some(r) = d.get("for_each") {
        let each = sub(d.g("facts_each"), &facts_in)?;
        for c in core::resolve_ref(&st(r), &got)?.arr() {
            for (k, q) in each.obj() {
                let (k, mut q) = (st(&core::with_code(&J::Str(k.clone()), &st(c), page_in)), core::with_code(q, &st(c), page_in));
                if let Some(w) = q.remove("when") {
                    if !core::conditions_hold(&w, &plain_holding(&got, page_in))? {
                        continue;
                    }
                }
                if facts.get(&k).is_some_and(|w| *w != q) {
                    return Err(format!("{layer}: fact {k} is declared two ways"));
                }
                facts.set(&k, q);
            }
        }
    }
    for (k, v) in d.g("formats").obj() {
        fmts.set(k, sub(v, page_in)?);
    }
    let held = J::obj_of(vec![("facts", facts.clone()), ("fmts", fmts.clone()), ("in", facts_in.clone())]);
    let n = node_of(layer, page_in, reg, &got, &sels, None, None, Some(&held))?;
    // the facts of each item's chosen candidate (a first_holding field's): one key two items declare apart refuses
    for it in n.g("items").arr() {
        for (_, v) in it.obj() {
            for (k, q) in v.g("facts").obj() {
                if facts.get(k).is_some_and(|w| w != q) {
                    return Err(format!("{layer}: fact {k} is declared two ways"));
                }
                facts.set(k, q.clone());
            }
        }
    }
    let (drawn, reads) = if d.g("rows").g("rule").s() == Some("rows_of_code") {
        // rows_of_code: the page input's rows (its main's, then its other rows: a second table's) at the table and every
        // filter dimension, a select reference read as its code; all drawn, in the input's order
        let q = codes_in(&sub(d.g("rows"), page_in)?, &got);
        let hit = |r: &&J| r.g("table") == q.g("table") && q.g("filter").obj().iter().all(|(k, v)| r.g("dims").g(k) == v);
        (page_in.g("rows").arr().iter().chain(page_in.g("sum_rows").arr()).filter(hit).cloned().collect(), Vec::new())
    } else if d.g("rows").g("rule").s() == Some("rows_in") {
        // rows_in: the page input's main rows at the table and every filter dimension whose `by` code is in any of the
        // lists `in` names, at every time; all drawn, in the input's order
        let q = sub(d.g("rows"), page_in)?;
        let by = st(q.g("by"));
        let codes: Vec<&J> = q.g("in").arr().iter().flat_map(|l| l.arr()).collect();
        let hit = |r: &&J| {
            r.g("table") == q.g("table") && q.g("filter").obj().iter().all(|(k, v)| r.g("dims").g(k) == v) && codes.contains(&r.g("dims").g(&by))
        };
        (page_in.g("rows").arr().iter().filter(hit).cloned().collect(), Vec::new())
    } else if d.has("rows") || d.has("reads") {
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
        (rows_by(d.g("rows"))?, rows_by(d.g("reads"))?)
    } else {
        (Vec::new(), Vec::new())
    };
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
    // the hero's data keys the declaration writes itself (declares.data), each template read over the page input
    for (k, v) in d.g("data").obj() {
        data.set(k, sub(v, page_in)?);
    }
    // the facts a printed difference needs printed with more decimals (printed_raise: page_in.dec_raise, a fact key or a
    // family member's, the decimals it prints with), each in its own format: its format at those decimals
    let (mut facts, mut fmts) = (facts, fmts);
    for (k, d) in page_in.g("dec_raise").obj() {
        let Some(dec) = d.num().map(|d| d as i64) else { continue };
        let (fact, code) = match facts.get(k) {
            Some(_) => (k.clone(), None),
            None => match k.rsplit_once('.') {
                Some((f, c)) if facts.get(f).is_some_and(|q| q.has("each")) => (f.to_string(), Some(c.to_string())),
                _ => continue,
            },
        };
        let base = st(facts.g(&fact).g("fmt"));
        let key = format!("{base}_d{dec}");
        if let Some(fd) = fmts.get(&base).cloned() {
            let mut fd = fd;
            fd.set("dec", J::Int(dec));
            fmts.set(&key, fd);
        }
        let mut q = facts.g(&fact).clone();
        match code {
            None => q.set("fmt", J::Str(key)),
            Some(c) => {
                let mut each = q.get("fmt_each").cloned().unwrap_or(J::Obj(vec![]));
                each.set(&c, J::Str(key));
                q.set("fmt_each", each);
            }
        }
        facts.set(&fact, q);
    }
    let mut out = J::obj_of(vec![("rows", J::Arr(drawn)), ("facts", facts), ("fmts", fmts)]);
    // the notes after the unit the declaration writes (declares.notes), each the registry's words with every template read
    let mut notes = Vec::new();
    for words in d.g("notes").arr() {
        notes.push(J::Str(words.arr().iter().map(|w| sub(w, page_in).map(|x| st(&x))).collect::<Result<Vec<_>, _>>()?.concat()));
    }
    if !notes.is_empty() {
        out.set("notes", J::Arr(notes));
    }
    if !reads.is_empty() {
        out.set("reads", J::Arr(reads));
    }
    let mut hero = J::Obj(vec![]);
    if let Some(hs) = d.get("hero_style") {
        hero.set("style", sub(hs, page_in)?);
    }
    // hero keys the declaration writes (declares.hero), for its code when it names one
    for (k, v) in d.g("hero").obj() {
        let v = codes_in(&sub(v, page_in)?, &got);
        hero.set(k, for_code.as_ref().map_or(v.clone(), |c| core::with_code(&v, c, page_in)));
    }
    if hero.truthy() {
        out.set("hero", hero);
    }
    // a leaf's data: the node's items, each field the leaf reads from the item field the registry names (a select
    // reference resolved to its code), and the leaf's other keys from the page input
    if let Some(lf) = d.get("leaf") {
        let mut items = Vec::new();
        for it in n.g("items").arr() {
            let mut x = J::Obj(vec![]);
            for (k, from) in lf.g("items").obj() {
                // a dotted path reads into an item field (a first_holding field's chosen candidate: note.text) and must be
                // there; a path ending in `?` is a field the leaf reads as optional, left out when the item has none (a
                // gap note naming the other place prints no number)
                let from = st(from);
                let (path, optional) = from.strip_suffix('?').map_or((from.as_str(), false), |p| (p, true));
                let Some(v) = path.split('.').try_fold(it, |x, p| x.get(p)) else {
                    if optional {
                        continue;
                    }
                    return Err(format!("{layer}: leaf item field {k}: the items have no {path}"));
                };
                x.set(k, if v.s().is_some_and(|s| core::ref_parts(s).is_some()) { core::resolve_ref(&st(v), &got)? } else { v.clone() });
            }
            items.push(x);
        }
        // the leaf's fixed items after the node's (items_after: a total's), `{y0}` / `{y1}` read as the page's two years
        items.extend(lf.g("items_after").arr().iter().map(|x| core::with_code(x, "", page_in)));
        // the items under the key the leaf reads them by (items_as; items when the declaration names none)
        let items_as = lf.g("items_as").s().unwrap_or("items").to_string();
        let mut leaf = J::obj_of(vec![(items_as.as_str(), J::Arr(items))]);
        for (k, v) in lf.obj().iter().filter(|(k, _)| !["key", "items", "items_as", "items_after", "fact_fields", "into"].contains(&k.as_str())) {
            leaf.set(k, sub(v, page_in)?);
        }
        // into data: the items are a key of the hero's data the leaf reads there (the big numbers), no leaf of their own
        if lf.g("into").s() == Some("data") {
            for (k, v) in leaf.obj() {
                data.set(k, v.clone());
            }
        } else {
            out.set("leaves", J::Obj(vec![(st(lf.g("key")), leaf)]));
        }
    }
    if data.truthy() {
        out.set("data", data);
    }
    Ok(out)
}

/// Request::NodeDeclare: what fill_of takes from the external layer `layer` over the flow's page input. A declaration of
/// shape parts_of_whole (parts_declared) stops in its own words; any other failure is the generator's.
/// How the page prints its differences (owner 11-06, superseding J2 of 11-04): a difference is computed from its two raw
/// values and rounded last, so it is never the difference of its two values as printed (`printed_of` stays empty for old
/// readers). The page's layers in its order (those declared_j declares) are declared together; a printed difference more
/// than half a unit of its last place off its true difference (core printed_differences) gets one decimal more, it and
/// its two values each in their own formats, to at most DIFF_MOST_DEC (and the most a row of the page input holds);
/// still off there, the page prints no such difference (`gap_order`: a note's case asks gap_printable, so its words say
/// only which is higher). Every other number keeps its format. A layer that does not declare leaves it as it is (its own
/// declaration says why). {dec_raise: {fact key or family member: decimals}, printed_of: {}, gap_order: [difference]}
fn printed_raise(page_in: &J, reg: &J) -> J {
    let held = page_in.g("rows").arr().iter().filter_map(|r| r.g("value").s()).map(|v| v.split_once('.').map_or(0, |(_, f)| f.len())).max().unwrap_or(0);
    let most = core::DIFF_MOST_DEC.min(held);
    let (mut raise, of, mut order) = (J::Obj(vec![]), J::Obj(vec![]), Vec::<J>::new());
    let done = |raise: &J, of: &J, order: &[J]| J::obj_of(vec![("dec_raise", raise.clone()), ("printed_of", of.clone()), ("gap_order", J::Arr(order.to_vec()))]);
    loop {
        let mut view = page_in.clone();
        view.set("dec_raise", raise.clone());
        view.set("printed_of", of.clone());
        view.set("gap_order", J::Arr(order.clone()));
        let (mut facts, mut fmts, mut shown) = (J::Obj(vec![]), J::Obj(vec![]), Vec::new());
        for layer in page_in.g("order").arr().iter().map(st) {
            if declares(reg, &layer, page_in).map_or(true, |d| d.has("shape")) {
                continue;
            }
            let Ok(out) = declared_j(&layer, &view, reg) else { return done(&raise, &of, &order) };
            for (k, v) in out.g("facts").obj() {
                facts.set(k, v.clone());
            }
            for (k, v) in out.g("fmts").obj() {
                fmts.set(k, v.clone());
            }
            // what the layer prints: its leaf data, hero keys and data (the facts it declares are no print of them)
            shown.push(J::Obj(out.obj().iter().filter(|(k, _)| !matches!(k.as_str(), "facts" | "fmts" | "rows" | "reads" | "ordered")).cloned().collect()));
        }
        let printed = core::printed_keys(&J::Arr(shown), &facts);
        let mut moved = false;
        for d in core::printed_differences(&facts, &fmts, page_in.g("rows").arr(), &printed) {
            if d.close {
                continue;
            }
            // off the true difference: one decimal more each, to the most
            let next = d.forms[0].1.max(d.forms[1].1).max(d.dec) + 1;
            if next <= most {
                for k in [&d.key, &d.pa, &d.pb] {
                    raise.set(k, J::Int(next as i64));
                }
                moved = true;
            } else if !order.iter().any(|o| o.s() == Some(d.key.as_str())) {
                order.push(J::Str(d.key.clone()));
                moved = true;
            }
        }
        if !moved {
            return done(&raise, &of, &order);
        }
    }
}

pub fn declare(layer: &str, page_in: &Value) -> Result<NodeDeclared, String> {
    let (reg, _) = core::registry_in_force();
    let pi = J::from_value(page_in);
    let parts = declares(&reg, layer, &pi).is_ok_and(|d| d.g("shape").s() == Some(PARTS_OF_WHOLE));
    let pairs = declares(&reg, layer, &pi).ok().filter(|d| d.g("shape").s() == Some(PAIRS));
    let finding = declares(&reg, layer, &pi).ok().filter(|d| d.g("shape").s() == Some(FINDING));
    let out = if let Some(d) = finding {
        finding_declared(d, &pi, &reg).map_err(|e| if e.starts_with("not this shape: ") { e } else { format!("node {layer}: declare: {e}") })?
    } else if let Some(d) = pairs {
        // a stop in the registry's own words is the page's, as the rust fill's was
        pairs_declared(layer, d, &pi, &reg).map_err(|e| if e.starts_with("not this shape: ") { e } else { format!("node {layer}: declare: {e}") })?
    } else if parts {
        parts_declared(layer, &pi, &reg).map_err(|h| match h {
            Halt::Stop(words) => words,
            Halt::Bad(e) => format!("node {layer}: declare: {e}"),
        })?
    } else {
        // the facts raised so the page's printed differences agree (printed_raise), the same for every layer
        let mut pi = pi;
        if !pi.has("dec_raise") {
            let raise = printed_raise(&pi, &reg);
            for k in ["dec_raise", "printed_of", "gap_order"] {
                pi.set(k, raise.g(k).clone());
            }
        }
        // a stop in the registry's own words (a value rule's `stop`) is the page's, as the rust fill's was
        declared_j(layer, &pi, &reg).map_err(|e| if e.starts_with("not this shape: ") { e } else { format!("node {layer}: declare: {e}") })?
    };
    let pairs = |k: &str| out.g(k).obj().iter().map(|(k, v)| (k.clone(), v.to_value())).collect();
    let mut rows: Vec<(Value, bool)> = out.g("rows").arr().iter().map(|r| (r.to_value(), true)).collect();
    if let Some(ordered) = out.get("ordered") {
        rows = ordered.arr().iter().map(|x| (x.at(0).to_value(), x.at(1) == &J::Bool(true))).collect();
    }
    Ok(NodeDeclared {
        node: layer.to_string(),
        rows,
        reads: out.g("reads").arr().iter().map(J::to_value).collect(),
        facts: pairs("facts"),
        fmts: pairs("fmts"),
        data: pairs("data"),
        hero: pairs("hero"),
        leaves: pairs("leaves"),
        names: out
            .g("names")
            .arr()
            .iter()
            .map(|n| (st(n.g("kind")), n.g("codes").arr().iter().map(st).collect(), n.g("labels").truthy()))
            .collect(),
        fixed: out.g("fixed").arr().iter().map(|f| (st(f.at(0)), st(f.at(1)))).collect(),
        record: out.get("record").map(J::to_value),
        unit_drawn: out.g("unit_drawn").truthy(),
        notes: out.g("notes").arr().iter().map(st).collect(),
        finding: out.get("finding").filter(|f| !f.is_null()).map(|f| (f.to_value(), st(out.g("subject")))),
        fell_back: out.g("fell_back").s().map(str::to_string),
    })
}

// ================================================================================================================
// parts_of_whole (P4b-1): a layer whose items are wholes split into registered parts (one bar per place, one segment per
// group of codes). Every pick is a select the core recomputes (given, rank, drop_replace, zero_parts, empty_parts,
// set_op); the cut's stop lines are the registry's words over the core's own results; the facts, formats, leaf data,
// lines, name requests and the record are the registry's templates expanded over the page input. No chart, table or
// part name is written here.
// ================================================================================================================

/// The declaration shape this section expands.
const PARTS_OF_WHOLE: &str = "parts_of_whole";
/// The declaration shape of pairs of two dimensions (pairs_declared).
const PAIRS: &str = "pairs_of_two";

/// The select kinds the core recomputes (next_tree recheck_one); a declaration naming another is refused (lint).
const CORE_SELECT_KINDS: [&str; 14] =
    ["given", "rank", "top_n", "take", "drop_replace", "exclude_codes", "zero_parts", "empty_parts", "set_op", "named_rule", "registry_list", "held_codes", "group_sum", "share_merge"];

/// Why a parts_of_whole declaration ends: a stop in the registry's own words (the page is not this shape, as a rust fill
/// said it), or the generator's or the core's failure.
enum Halt {
    Stop(String),
    Bad(String),
}

impl From<String> for Halt {
    fn from(e: String) -> Self {
        Halt::Bad(e)
    }
}

/// A row's value as the flow reads it (a finite number written as text), else none.
fn row_num(r: &J) -> Option<f64> {
    r.g("value").s().and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite())
}

/// The value at a dotted path of the declaration's page view: the page input, the target, the composition's groups as a
/// map, and `knob.<node>.<knob>`, a number knob's default from the visual group's leaf registry.
fn view_path(view: &J, path: &str) -> Result<J, String> {
    if let Some(rest) = path.strip_prefix("knob.") {
        let (node, knob) = rest.split_once('.').ok_or_else(|| format!("template path ${path}: knob.<node>.<knob>"))?;
        let leaf = crate::next_leaf::leaves().nodes.get(node).ok_or_else(|| format!("template path ${path}: no node {node}"))?;
        return match leaf.info.knobs.iter().find(|k| k.name == knob).map(|k| &k.kind) {
            Some(crate::next_nodes::Kind::Range { default, .. }) => Ok(J::Num(*default)),
            _ => Err(format!("template path ${path}: no number knob {knob}")),
        };
    }
    if path == "shape.scale" {
        return Ok(page_scale(view));
    }
    let mut x = view;
    for p in path.split('.') {
        x = x.get(p).ok_or_else(|| format!("template path ${path}: the page input has no {p}"))?;
    }
    Ok(x.clone())
}

/// A template over the page view and the expansion context: `$path` (a whole string or an object key) from the view; a
/// whole string `{name}` the context's value itself; inside a string each `{name}` the context's word and each `{a.b}` the
/// view's.
fn subx(v: &J, view: &J, ctx: &[(&str, J)]) -> Result<J, String> {
    Ok(match v {
        J::Str(s) if s.starts_with('$') => view_path(view, &s[1..])?,
        J::Str(s) => {
            let whole = s.strip_prefix('{').and_then(|x| x.strip_suffix('}')).filter(|x| !x.contains('{'));
            if let Some((_, x)) = whole.and_then(|w| ctx.iter().find(|(k, _)| *k == w)) {
                return Ok(x.clone());
            }
            let mut out = String::new();
            let mut rest = s.as_str();
            while let Some(i) = rest.find('{') {
                let Some(j) = rest[i..].find('}') else { break };
                let name = &rest[i + 1..i + j];
                out.push_str(&rest[..i]);
                match ctx.iter().find(|(k, _)| *k == name) {
                    Some((_, x)) => out.push_str(&st(x)),
                    None if name.contains('.') => out.push_str(&st(&view_path(view, name)?)),
                    None => out.push_str(&rest[i..=i + j]),
                }
                rest = &rest[i + j + 1..];
            }
            out.push_str(rest);
            J::Str(out)
        }
        J::Obj(m) => J::Obj(
            m.iter()
                .map(|(k, x)| Ok((match k.strip_prefix('$') { Some(p) => st(&view_path(view, p)?), None => k.clone() }, subx(x, view, ctx)?)))
                .collect::<Result<_, String>>()?,
        ),
        J::Arr(a) => J::Arr(a.iter().map(|x| subx(x, view, ctx)).collect::<Result<_, String>>()?),
        v => v.clone(),
    })
}

/// A number of the declaration: a `$path`, {"min": [...]}, {"len": a list template}, or a literal.
fn number_of(v: &J, view: &J) -> Result<i64, String> {
    Ok(match v {
        J::Str(s) if s.starts_with('$') => view_path(view, &s[1..])?.num().ok_or_else(|| format!("{s}: no number"))? as i64,
        J::Obj(_) if v.has("min") => v.g("min").arr().iter().map(|x| number_of(x, view)).collect::<Result<Vec<_>, _>>()?.into_iter().min().unwrap_or(0),
        J::Obj(_) if v.has("len") => subx(v.g("len"), view, &[])?.arr().len() as i64,
        v => v.num().ok_or_else(|| format!("{}: no number", v.repr()))? as i64,
    })
}

/// What the generator refuses in a parts_of_whole declaration (each declare, and the bindings' test): a select kind the
/// core cannot compute, a tolerance that is no knob reference, a stop line of the cut other than the one the node
/// registry pins for the node (max_dropped num/den, fill_after_drop), a word with a digit.
fn parts_lint(layer: &str, d: &J, reg: &J) -> Vec<String> {
    let mut bad = Vec::new();
    for s in d.g("selects").arr() {
        let kind = s.g("kind").s().unwrap_or("");
        if !CORE_SELECT_KINDS.contains(&kind) {
            bad.push(format!("select {}: kind {kind} the core cannot compute", st(s.g("id"))));
        }
        if kind == "drop_replace" {
            let tol = s.g("check").g("sum_within").g("tol");
            let knob = tol.g("knob").s().unwrap_or("");
            if !(tol.obj().len() == 2 && !knob.is_empty() && tol.g("value").s() == Some(&format!("$knob.{knob}"))) {
                bad.push(format!("select {}: tol {} is no knob reference", st(s.g("id")), tol.repr()));
            }
        }
    }
    let pinned: Vec<&J> = reg.g("nodes").g(layer).g("checks").arr().iter().collect();
    for rule in ["max_dropped", "fill_after_drop"] {
        let pin = pinned.iter().find(|c| c.g("kind").s() == Some(rule));
        let stop = d.g("stops").arr().iter().find(|s| s.g("rule").s() == Some(rule));
        match (pin, stop) {
            (Some(p), Some(s)) if rule == "max_dropped" && (s.g("num") != p.g("num") || s.g("den") != p.g("den")) => {
                bad.push(format!("stop max_dropped {}/{}: the node registry pins {}/{}", st(s.g("num")), st(s.g("den")), st(p.g("num")), st(p.g("den"))))
            }
            (Some(_), None) => bad.push(format!("stop {rule}: pinned by the node registry, missing")),
            (None, Some(_)) => bad.push(format!("stop {rule}: the node registry pins no such check for {layer}")),
            _ => {}
        }
    }
    let digit = |s: &str| s.chars().any(|c| c.is_ascii_digit() || ('０'..='９').contains(&c));
    for (at, v) in [("lines", d.g("lines")), ("leaf", d.g("leaf"))] {
        for (path, w) in core::walk(v, "") {
            if path.ends_with(".w") && w.s().is_some_and(digit) {
                bad.push(format!("{at}{path}: the word {} holds a digit", w.repr()));
            }
        }
    }
    bad
}

/// The selects as written, each result given or empty, with the core's results put in (with_results: the second pass,
/// and the third with the zero parts declared).
fn with_results_of(s: &J, got: &Got, zero: Option<&J>) -> J {
    let mut s = s.clone();
    match s.g("kind").s() {
        Some("given") => {}
        Some("zero_parts") => {
            if let Some(z) = zero {
                s.set("declared", z.clone());
            }
        }
        _ => {
            let id = st(s.g("id"));
            s.set("result", got.get(&id).cloned().unwrap_or(J::Null));
            if s.g("kind").s() == Some("drop_replace") {
                let dropped = got.get(&format!("{id}#dropped")).map(|d| d.arr().to_vec()).unwrap_or_default();
                s.set("dropped", J::Arr(dropped.into_iter().map(|c| J::obj_of(vec![("code", c)])).collect()));
            }
        }
    }
    s
}

/// The core's recheck of selects over rows alone (no facts, no checks): (failures, results).
fn recheck_selects(rows: &[J], sels: &[J]) -> (Vec<String>, Got) {
    let page = J::obj_of(vec![
        ("kind", J::str("Page")),
        ("selects", J::obj_of(vec![("kind", J::str("Selects")), ("items", J::Arr(sels.to_vec()))])),
        (
            "facts",
            J::obj_of(vec![
                ("kind", J::str("Facts")),
                ("tables", J::Obj(vec![])),
                ("rows", J::Arr(rows.to_vec())),
                ("facts", J::Obj(vec![])),
                ("fmts", J::Obj(vec![])),
            ]),
        ),
        ("checks", J::obj_of(vec![("kind", J::str("Checks")), ("items", J::Arr(vec![]))])),
    ]);
    let (bad, got, _) = core::recheck(&page);
    (bad, got)
}

/// The rows a drop_replace reads, place by place in its order until its target is drawn (each place's total rows, then
/// its parts' rows): the first that holds no number, or none. The core's own walk, so a row past the cut is never read.
fn first_row_of_no_number<'a>(cands: &[J], target: i64, rows: &'a [J], c: &J) -> Option<&'a J> {
    let every: Vec<&J> = c.g("parts").obj().iter().flat_map(|(_, cs)| cs.arr().iter()).collect();
    let (place, dim) = (st(c.g("place")), st(c.g("dim")));
    let mut drawn = 0;
    for code in cands {
        if drawn == target {
            return None;
        }
        let at: Vec<&J> = rows.iter().filter(|r| r.g("table") == c.g("table") && r.g("time") == c.g("time") && r.g("dims").g(&place) == code).collect();
        let tot: Vec<&J> = at.iter().copied().filter(|r| r.g("dims").g(&dim) == c.g("total")).collect();
        let parts: Vec<&J> = at.iter().copied().filter(|r| every.contains(&r.g("dims").g(&dim))).collect();
        if let Some(r) = tot.iter().chain(parts.iter()).find(|r| row_num(r).is_none()) {
            return Some(r);
        }
        let whole: f64 = tot.iter().filter_map(|r| row_num(r)).sum();
        let sum: f64 = parts.iter().filter_map(|r| row_num(r)).sum();
        if (sum - whole).abs() <= c.g("tol").g("value").num().unwrap_or(0.0) * whole.abs() {
            drawn += 1;
        }
    }
    None
}

/// A place's name row: its reviewed name by the code's scheme (two letters iso2, else iso3), as the flow names places.
fn place_src(code: &str) -> J {
    J::obj_of(vec![("src", J::Str(format!("name:zh_names:{}:{code}", if code.len() == 2 { "iso2" } else { "iso3" })))])
}

/// A line of the declaration (its `segs`) over the expansion context: words and sources as written, a place by its name
/// row, a coded name by its name row, a list of places by their name rows between the separator.
fn segments(segs: &J, view: &J, ctx: &[(&str, J)]) -> Result<J, String> {
    let mut out = Vec::new();
    for s in segs.arr() {
        if s.has("w") || s.has("src") {
            out.push(subx(s, view, ctx)?);
        } else if let Some(p) = s.get("place_name") {
            out.push(place_src(&st(&subx(p, view, ctx)?)));
        } else if s.has("name") {
            let (kind, code) = (st(&subx(s.g("name"), view, ctx)?), st(&subx(s.g("code"), view, ctx)?));
            out.push(J::obj_of(vec![("src", J::Str(format!("name:zh_names:{kind}:{code}")))]));
        } else if let Some(l) = s.get("list_places") {
            for (k, c) in subx(l, view, ctx)?.arr().iter().enumerate() {
                if k > 0 {
                    out.push(J::obj_of(vec![("w", s.g("sep").clone())]));
                }
                out.push(place_src(&st(c)));
            }
        } else {
            return Err(format!("line segment {}: not one the generator expands", s.repr()));
        }
    }
    Ok(J::Arr(out))
}

/// The heading of a relation at one period from the visual group's frames (shape_registry FRAMES), by its name.
fn frame_words(name: &str) -> Result<String, String> {
    crate::shape_registry::FRAMES
        .iter()
        .find(|(r, v, _)| format!("{r:?}") == name && *v == crate::shape_registry::View::Slice)
        .map(|(_, _, w)| w[2].to_string())
        .ok_or_else(|| format!("frame {name}: the registry has no heading of it"))
}

/// A parts_of_whole declaration's page view (the page input, its target, the composition's groups as a map: group -> its
/// codes), the rows its selects run over (the main's and the sum inputs'), and its selects as written over the view, each
/// result given or empty: the core's first pass.
fn parts_selects(d: &J, page_in: &J) -> Result<(J, Vec<J>, Vec<J>), String> {
    let mut view = page_in.clone();
    let mut comp = page_in.g("composition").clone();
    comp.set("groups_map", J::Obj(comp.g("groups").arr().iter().map(|g| (st(g.at(0)), g.at(1).clone())).collect()));
    view.set("composition", comp);
    let target = number_of(d.g("target"), &view)?;
    view.set("target", J::Int(target));
    let mut rows: Vec<J> = page_in.g("rows").arr().to_vec();
    rows.extend(page_in.g("sum_rows").arr().iter().cloned());
    let mut sels = Vec::new();
    for s in d.g("selects").arr() {
        let mut x = subx(&J::Obj(s.obj().iter().filter(|(k, _)| k != "given").cloned().collect()), &view, &[])?;
        match s.get("given") {
            Some(g) => x.set("result", subx(g, &view, &[])?),
            None => {
                x.set("result", J::Arr(vec![]));
                match x.g("kind").s() {
                    Some("drop_replace") => x.set("dropped", J::Arr(vec![])),
                    Some("zero_parts") => x.set("declared", J::Arr(vec![])),
                    _ => {}
                }
            }
        }
        sels.push(x);
    }
    Ok((view, rows, sels))
}

/// A parts_of_whole layer's declaration over the page input: what the flow's fill takes from it (its rows in order, each
/// drawn or only read, facts, formats, hero data, leaf data, name requests, fixed names, the record), or the stop the
/// registry words.
fn parts_declared(layer: &str, page_in: &J, reg: &J) -> Result<J, Halt> {
    let d = declares(reg, layer, page_in)?;
    let lint = parts_lint(layer, d, reg);
    if !lint.is_empty() {
        return Err(Halt::Bad(format!("the registry's declaration: {}", lint.join("; "))));
    }
    let pre = st(d.g("stop_prefix"));
    let stop = |w: String| Halt::Stop(format!("{pre}{w}"));
    if !page_in.g(&st(d.g("needs").g("path"))).truthy() {
        return Err(stop(st(&subx(d.g("needs").g("words"), page_in, &[])?)));
    }
    let (view, rows, sels) = parts_selects(d, page_in)?;
    let target = view.g("target").num().unwrap_or(0.0) as i64;
    let shape = page_in.g("shape").clone();
    let (place, dim, year) = (st(shape.g("place")), st(view.g("composition").g("dim")), shape.g("year").clone());
    let total = view.g("composition").g("total").clone();
    let by_id = |id: &str| sels.iter().find(|s| s.g("id").s() == Some(id)).cloned();
    let items = st(d.g("items"));
    let dr = by_id(&items).filter(|s| s.g("kind").s() == Some("drop_replace")).ok_or_else(|| format!("items {items}: no drop_replace select"))?;
    // a row the cut reads that holds no number stops in the registry's words, before the core would fail on it
    let ranked: Vec<J> = sels.iter().filter(|s| matches!(s.g("kind").s(), Some("given" | "rank"))).cloned().collect();
    let (_, rk) = recheck_selects(&rows, &ranked);
    let c = core::resolved(dr.g("check").g("sum_within"), &rk)?;
    let cands = rk.get(&st(dr.g("from"))).cloned().unwrap_or(J::Arr(vec![]));
    for s in d.g("stops").arr().iter().filter(|s| s.g("rule").s() == Some("number_in_rows_read")) {
        if let Some(r) = first_row_of_no_number(cands.arr(), target, &rows, &c) {
            let w = st(s.g("words")).replace("{src_json}", &r.g("src").dump());
            return Err(stop(w));
        }
    }
    // two passes over the core: the first computes, the second holds every declared result to the first's
    let (_, got) = recheck_selects(&rows, &sels);
    let second: Vec<J> = sels.iter().map(|s| with_results_of(s, &got, None)).collect();
    let (bad, got) = recheck_selects(&rows, &second);
    // the zero declaration is expanded below and held in the third pass
    let bad: Vec<String> = bad.into_iter().filter(|b| !b.contains("(zero_parts)")).collect();
    if !bad.is_empty() {
        return Err(Halt::Bad(format!("the core's selects do not recompute: {}", bad.iter().take(3).cloned().collect::<Vec<_>>().join("; "))));
    }
    let res = |k: &str| got.get(k).cloned().unwrap_or(J::Arr(vec![]));
    let (drawn, dropped) = (res(&items), res(&st(d.g("dropped"))));
    // the cut's stop lines, from the core's own results
    let tol = c.g("tol").g("value").num().unwrap_or(f64::NAN);
    let codes = |x: &J| x.arr().iter().map(st).collect::<Vec<_>>();
    let words = |s: &J| -> Result<String, String> {
        let w = st(s.g("words"))
            .replace("{target}", &target.to_string())
            .replace("{dropped_n}", &dropped.arr().len().to_string())
            .replace("{drawn_n}", &drawn.arr().len().to_string())
            .replace("{dropped_codes}", &codes(&dropped).join(", "))
            .replace("{tol}", &format!("{tol}"));
        Ok(st(&subx(&J::Str(w), &view, &[])?))
    };
    for s in d.g("stops").arr() {
        let (nd, nt) = (dropped.arr().len() as i64, target);
        let hit = match s.g("rule").s() {
            Some("max_dropped") => nd * s.g("den").num().unwrap_or(0.0) as i64 > nt * s.g("num").num().unwrap_or(0.0) as i64,
            Some("fill_after_drop") => nd > 0 && (drawn.arr().len() as i64) < nt,
            _ => false,
        };
        if hit {
            return Err(stop(words(s)?));
        }
    }
    parts_expand(layer, d, &view, (&rows, &second), &got, (place, dim, year, total))
}

/// The parts_of_whole expansion over the core's results (parts_declared): per item its total (drawn) and per part its
/// rows (read): none is empty, all 0 with every code a row is zero (declared, held by the core's third pass), else its
/// cells, sum and share; the places left out for their parts with their gap; the zero parts' lines; the others; the
/// formats, leaf data, lines, name requests, fixed names and the record.
fn parts_expand(layer: &str, d: &J, view: &J, (rows, sels): (&[J], &[J]), got: &Got, (place, dim, year, total): (String, String, J, J)) -> Result<J, Halt> {
    let shape = view.g("shape");
    let res = |k: &str| got.get(k).cloned().unwrap_or(J::Arr(vec![]));
    let groups = res(&st(d.g("parts")));
    let sums = view.g("sum_rows").arr();
    let fdecl = d.g("facts");
    let fact = |name: &str, ctx: &[(&str, J)]| -> Result<(String, J), String> {
        let f = fdecl.get(name).ok_or_else(|| format!("facts.{name}: the declaration has none"))?;
        Ok((st(&subx(f.g("key"), view, ctx)?), subx(f.g("q"), view, ctx)?))
    };
    let total_row = |code: &J| {
        view.g("rows").arr().iter().find(|r| r.g("time") == &year && r.g("dims").g(&place) == code && r.g("dims").g(&dim) == &total).cloned()
    };
    let (mut ordered, mut facts, mut fmts, mut lines) = (Vec::new(), J::Obj(vec![]), J::Obj(vec![]), Vec::new());
    let set_fact = |facts: &mut J, (k, q): (String, J)| facts.set(&k, q);
    let take = |ordered: &mut Vec<J>, rs: Vec<J>, drawn: bool| ordered.extend(rs.into_iter().map(|r| J::Arr(vec![r, J::Bool(drawn)])));
    let empty = res(&st(d.g("empty")));
    let leaf_d = d.g("leaf");
    let (mut bars, mut zero_decl) = (Vec::new(), Vec::new());
    let mut zero_parts: Vec<(String, Vec<J>)> = Vec::new();
    for item in res(&st(d.g("items"))).arr() {
        let tot = total_row(item).ok_or_else(|| format!("item {}: no total row at the year", st(item)))?;
        take(&mut ordered, vec![tot.clone()], true);
        set_fact(&mut facts, fact("item_total", &[("item", item.clone())])?);
        let (mut cells, mut share) = (J::Obj(vec![]), J::Obj(vec![]));
        for (part, pcodes) in groups.obj() {
            let held: Vec<J> = sums
                .iter()
                .filter(|r| r.g("time") == &year && r.g("dims").g(&place) == item && pcodes.arr().contains(r.g("dims").g(&dim)))
                .cloned()
                .collect();
            let is_empty = empty.arr().iter().any(|e| e.g("bar") == item && e.g("part").s() == Some(part.as_str()));
            take(&mut ordered, held.clone(), false);
            if is_empty {
                continue;
            }
            // every code has a row (else empty_parts holds it): all 0 is a zero part, declared with its rows
            if held.iter().all(|r| row_num(r) == Some(0.0)) {
                zero_decl.push(J::obj_of(vec![("bar", item.clone()), ("part", J::str(part)), ("cells", J::Arr(held.iter().map(|r| r.g("src").clone()).collect()))]));
                match zero_parts.iter_mut().find(|(p, _)| p == part) {
                    Some((_, its)) => its.push(item.clone()),
                    None => zero_parts.push((part.clone(), vec![item.clone()])),
                }
                continue;
            }
            cells.set(part, J::Arr(held.iter().map(|r| r.g("src").clone()).collect()));
            let ctx = [("item", item.clone()), ("part", J::str(part)), ("part_codes", pcodes.clone())];
            set_fact(&mut facts, fact("part_sum", &ctx)?);
            set_fact(&mut facts, fact("part_share", &ctx)?);
            share.set(part, subx(leaf_d.g("share_text"), view, &ctx)?);
        }
        bars.push(J::obj_of(vec![
            ("code", item.clone()),
            ("total", tot.g("src").clone()),
            ("total_text", subx(leaf_d.g("total_text"), view, &[("item", item.clone())])?),
            ("cells", cells),
            ("share_text", share),
        ]));
    }
    // the third pass: the zero declaration held to the core's zero_parts
    let third: Vec<J> = sels.iter().map(|s| with_results_of(s, got, Some(&J::Arr(zero_decl.clone())))).collect();
    if let Some(b) = recheck_selects(rows, &third).0.into_iter().find(|b| b.contains("(zero_parts)")) {
        return Err(Halt::Bad(b));
    }
    let fmt_d = d.g("fmts");
    let fmt_key = st(shape.g("fmt"));
    fmts.set(&fmt_key, subx(fmt_d.g("$shape.fmt"), view, &[])?);
    let items = res(&st(d.g("items")));
    set_fact(&mut facts, fact("items_n", &[("items", items.clone())])?);
    let line_d = |each: &'static str| d.g("lines").arr().iter().filter(move |l| l.g("each").s() == Some(each));
    for l in line_d("once") {
        lines.push(segments(l.g("segs"), view, &[])?);
    }
    let dropped = res(&st(d.g("dropped")));
    let all_codes = J::Arr(groups.obj().iter().flat_map(|(_, cs)| cs.arr().iter().cloned()).collect());
    for item in dropped.arr() {
        let tot = total_row(item).ok_or_else(|| format!("item {}: no total row at the year", st(item)))?;
        let inputs: Vec<J> = sums.iter().filter(|r| r.g("time") == &year && r.g("dims").g(&place) == item).cloned().collect();
        take(&mut ordered, std::iter::once(tot.clone()).chain(inputs.iter().cloned()).collect(), false);
        let s: f64 = inputs.iter().filter_map(row_num).sum();
        let whole = row_num(&tot).unwrap_or(f64::NAN);
        let (k_sum, q_sum) = fact("dropped_sum", &[("item", item.clone()), ("all_codes", all_codes.clone())])?;
        let (k_tot, q_tot) = fact("item_total", &[("item", item.clone())])?;
        let (big, small) = if s > whole { (&k_sum, &k_tot) } else { (&k_tot, &k_sum) };
        let gap = fact("dropped_gap", &[("item", item.clone()), ("larger", J::str(big)), ("smaller", J::str(small))])?;
        set_fact(&mut facts, (k_sum.clone(), q_sum));
        set_fact(&mut facts, (k_tot.clone(), q_tot));
        set_fact(&mut facts, gap);
        for l in line_d("dropped") {
            lines.push(segments(l.g("segs"), view, &[("item", item.clone())])?);
        }
    }
    for (part, its) in &zero_parts {
        let ctx = [("part", J::str(part)), ("items", J::Arr(its.clone())), ("part_codes", groups.g(part).clone())];
        set_fact(&mut facts, fact("zero_n", &ctx)?);
        for l in line_d("zero_part") {
            lines.push(segments(l.g("segs"), view, &ctx)?);
        }
    }
    // the gap's format, while a place is left out: the most decimals its rows hold as the data gave them, at most the cap
    for (key, f) in fmt_d.obj().iter().filter(|(k, f)| !k.starts_with('$') && f.g("when").s() == Some("dropped")) {
        if dropped.arr().is_empty() {
            continue;
        }
        let rule = f.g("dec_rule");
        if rule.g("rule").s() != Some("held_decimals_read") {
            return Err(Halt::Bad(format!("fmts.{key} dec_rule {}: not one the generator computes", rule.g("rule").repr())));
        }
        let read: Vec<J> = dropped.arr().iter().filter_map(total_row).chain(sums.iter().cloned()).collect();
        let dec = read.iter().filter_map(|r| r.g("value").s()).map(|v| v.split_once('.').map_or(0, |(_, x)| x.len() as i64)).max().unwrap_or(0);
        let cap = rule.g("max").g("value").num().ok_or_else(|| format!("fmts.{key}: dec_rule max has no value"))? as i64;
        let scale = subx(f.g("scale"), view, &[])?;
        let moved = if f.g("scale") == &J::str("$shape.scale") { scale.num().filter(|x| *x > 0.0).map_or(0, |x| (-x.log10()).round() as i64) } else { 0 };
        fmts.set(key, J::obj_of(vec![("scale", scale), ("dec", J::Int((dec + moved).min(cap))), ("suffix", subx(f.g("suffix"), view, &[])?)]));
    }
    let parts: Vec<J> = groups.obj().iter().map(|(g, _)| J::str(g)).collect();
    let mut leaf = subx(leaf_d.g("head"), view, &[])?;
    leaf.set("parts", J::Arr(parts.clone()));
    let th = subx(leaf_d.g("total_head"), view, &[])?;
    leaf.set("total_head", J::Arr(vec![J::obj_of(vec![("src", J::Str(format!("name:zh_names:{}:{}", st(th.g("name")), st(th.g("code")))))])]));
    let others = res(&st(d.g("others")));
    if !others.arr().is_empty() {
        take(&mut ordered, others.arr().iter().filter_map(total_row).collect(), false);
        set_fact(&mut facts, fact("others_n", &[("items", others.clone())])?);
        leaf.set("others", J::obj_of(vec![("head", leaf_d.g("others_head").clone()), ("codes", others.clone())]));
    }
    let record = J::Obj(
        d.g("record")
            .obj()
            .iter()
            .map(|(k, role)| {
                // each the result of the select the declaration's role names, the zero parts as declared, or the registry's
                // own value ({"value": ..}: what the record says the page is, never a fill)
                let v = match (role.get("value"), role.s()) {
                    (Some(x), _) => x.clone(),
                    (None, Some("zero_declared")) => J::Arr(zero_decl.clone()),
                    _ => res(&st(d.g(&st(role)))),
                };
                (k.clone(), v)
            })
            .collect(),
    );
    let (t, u) = (subx(leaf_d.g("title"), view, &[])?, subx(leaf_d.g("unit"), view, &[])?);
    let fixed = vec![
        (format!("name:{}", st(t.g("fixed"))), frame_words(&st(t.g("frame")))?),
        (format!("name:{}", st(u.g("fixed"))), st(u.g("text"))),
    ];
    leaf.set("title", J::Arr(vec![J::obj_of(vec![("src", J::Str(fixed[0].0.clone()))])]));
    leaf.set("unit", J::Arr(vec![J::obj_of(vec![("src", J::Str(fixed[1].0.clone()))])]));
    leaf.set("bars", J::Arr(bars));
    if !empty.arr().is_empty() {
        leaf.set("empty", empty.clone());
    }
    if !zero_decl.is_empty() {
        leaf.set("zero", J::Arr(zero_decl));
    }
    leaf.set("lines", J::Arr(lines));
    let names = J::Arr(
        d.g("names")
            .arr()
            .iter()
            .map(|n| {
                let codes = if n.g("codes").s() == Some("{parts}") { J::Arr(parts.clone()) } else { subx(n.g("codes"), view, &[])? };
                Ok(J::obj_of(vec![("kind", subx(n.g("kind"), view, &[])?), ("codes", codes), ("labels", J::Bool(n.g("labels").truthy()))]))
            })
            .collect::<Result<_, String>>()?,
    );
    let layer_key = layer.to_string();
    Ok(J::obj_of(vec![
        ("ordered", J::Arr(ordered)),
        ("facts", facts),
        ("fmts", fmts),
        ("data", subx(d.g("hero_data"), view, &[])?),
        ("leaves", J::Obj(vec![(layer_key, leaf)])),
        ("names", names),
        ("fixed", J::Arr(fixed.into_iter().map(|(s, t)| J::Arr(vec![J::Str(s), J::Str(t)])).collect())),
        ("record", record),
        ("unit_drawn", J::Bool(d.g("unit_drawn").truthy())),
    ]))
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
                    // a list of chosen codes (a mean over the ranked places) is the select whose result it is, whole
                    if let (true, J::Arr(codes)) = (k == "filter" && x.is_obj(), x.g(place)) {
                        let sid = order.iter().find(|sid| got.get(*sid).is_some_and(|r| r.arr() == codes.as_slice()));
                        let sid = sid.ok_or_else(|| format!("fact filter {place}: no select holds just the codes {}", x.g(place).repr()))?;
                        let mut f = x.clone();
                        f.set(place, J::Str(format!("select:{sid}")));
                        return Ok((k.clone(), f));
                    }
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
    // each layer's decimals rule on the page's format; a layer with no fmt declares no format (declared_j)
    for layer in external.iter().filter(|l| declares(reg, l, page_in).is_ok_and(|d| d.has("fmt"))) {
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
        // the layer's values as its declaration reads them (with_values, as declared_j): the node's geometry is the declared one
        let view = with_values(&layer, page_in, reg)?;
        body.push(node_of(&layer, view.as_ref().unwrap_or(page_in), reg, &got, &sels, Some(&after), frame_knobs(&layer, reg, fill), None)?);
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
    let mut envelope = J::obj_of(vec![
        ("rows", page_in.g("rows").clone()),
        ("select_spec", select_spec),
        ("knobs", J::Obj(vec![])),
        ("drawn_rules", rules),
        ("given", J::Obj(given)),
        ("name_table", J::obj_of(vec![("labels", names), ("named", named)])),
        ("points", points),
        ("word_table", J::Obj(vec![])),
        ("page_spec", page),
    ]);
    // the quantities the question asks for, as the flow copied them (the page input's and the leaf's spec's), passed on
    // as given for the core's C6 (next_tree asked_problems); a page with neither keeps its tree as before
    for (k, v) in [("asked", page_in.get("asked")), ("leaf_asked", spec.get("asked"))] {
        if let Some(v) = v {
            envelope.set(k, v.clone());
        }
    }
    Ok(envelope)
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
            // a level page needs one value above 0; a value below 0 is a bar left of the zero line (11-07, the bars node signed)
            "value_domain" => {
                let v: Vec<f64> = ranked.iter().filter_map(|c| at(c, year)).collect();
                v.is_empty() || !v.iter().any(|x| *x > 0.0)
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
    // the page's finding, declared again over the finished fill (a page every layer of which stops at its leaf publishes
    // none, so it is not read there)
    finding_recheck(&page_in, &fill, &reg)?;
    mean_recheck(&fill)?;
    // a layer whose leaf lays itself out (geometry leaf) asks no node and is given no placed geometry; one whose items
    // choose by conditions (declares.candidates) is declared again over the finished fill's name rows, and the leaf data
    // the fill holds must be that declaration's (a name the conditions measured otherwise refuses)
    for l in asked.iter().filter(|l| reg.g("nodes").g(l).g("geometry").s() == Some("leaf")) {
        let Ok(d) = declares(&reg, l, &page_in) else { continue };
        if !d.has("candidates") && !d.has("hero") && !d.has("data") {
            continue;
        }
        let mut named = page_in.clone();
        named.set("names", fill.g("knobs").g("labels").clone());
        // the decimals the page's printed differences need, as declare gave every layer (printed_raise)
        if !named.has("dec_raise") {
            let raise = printed_raise(&named, &reg);
            for k in ["dec_raise", "printed_of", "gap_order"] {
                named.set(k, raise.g(k).clone());
            }
        }
        let again = declared_j(l, &named, &reg).map_err(|e| format!("node {l}: recheck over the name rows: {e}"))?;
        let key = st(d.g("leaf").g("key"));
        let items_as = d.g("leaf").g("items_as").s().unwrap_or("items").to_string();
        let hero = fill.g("knobs").g("spec").g("hero");
        // a leaf into the hero's data holds its items there (leaf.into), any other under the hero's leaves
        let (held, mine) = if d.g("leaf").g("into").s() == Some("data") {
            let of = |data: &J| J::obj_of(vec![(items_as.as_str(), data.g(&items_as).clone())]);
            (of(hero.g("data")), of(again.g("data")))
        } else {
            (hero.g("leaves").g(&key).clone(), again.g("leaves").g(&key).clone())
        };
        let held = &held;
        if mine != *held {
            return Err(format!("node {l}: the leaf data is not its declaration over the page's name rows: {} != {}", held.repr(), mine.repr()));
        }
        // the hero keys it writes and the facts it declares are the page's, as declared again
        for (k, v) in d.g("hero").obj().iter().map(|(k, _)| (k, again.g("hero").g(k))) {
            if hero.g(k) != v {
                return Err(format!("node {l}: hero {k} is not its declaration: {} != {}", hero.g(k).repr(), v.repr()));
            }
        }
        for (k, q) in again.g("facts").obj() {
            if fill.g("knobs").g("spec").g("facts").g(k) != q {
                return Err(format!("node {l}: fact {k} is not its declaration: {}", q.repr()));
            }
        }
        // the hero's data keys it writes itself (declares.data) are the page's, and each that names a fact (data_facts)
        // names one the page declares
        for k in d.g("data").obj().iter().map(|(k, _)| k) {
            if hero.g("data").g(k) != again.g("data").g(k) {
                return Err(format!("node {l}: hero data {k} is not its declaration: {} != {}", hero.g("data").g(k).repr(), again.g("data").g(k).repr()));
            }
        }
        for k in d.g("data_facts").arr().iter().map(st) {
            if let Some(f) = hero.g("data").g(&k).s().filter(|f| !fill.g("knobs").g("spec").g("facts").has(f)) {
                return Err(format!("node {l}: its data field {k} prints fact {f}, which the page does not declare"));
            }
        }
        // the item fields the leaf prints as facts by key (leaf.fact_fields): each a fact the page declares (another
        // layer's, the map's, when the declaration declares none of its own)
        let facts = fill.g("knobs").g("spec").g("facts");
        for it in held.g(&items_as).arr() {
            for f in d.g("leaf").g("fact_fields").arr().iter().map(st) {
                if let Some(k) = it.g(&f).s().filter(|k| !facts.has(k)) {
                    return Err(format!("node {l}: its {items_as} field {f} prints fact {k}, which the page does not declare"));
                }
            }
        }
    }
    asked.retain(|l| reg.g("nodes").g(l).g("geometry").s() != Some("leaf"));
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

    /// C6 through the core's content check (content_problems) on the q1 page tree, with asked records the flow would copy for
    /// a two-quantity question written here ("各国可再生能源占比和碳排放分别怎样？"): the renewables are drawn (the bars' rows of
    /// the main); carbon emissions, with no offered table and the leaf's line, passes; offered a table and not drawn, it is
    /// refused, the leaf's line not standing; and the page with no asked record checks as before.
    #[test]
    fn the_q1_tree_passes_c6_with_the_unanswered_half_lined_and_is_refused_without() {
        let gen = read("q1-gen.json");
        let reg = proto_reg();
        let ext = vec!["bars".to_string()];
        let rec = |id: &str, tables: &[&str], offered: &[&str]| {
            J::obj_of(vec![("id", J::str(id)), ("zh", J::str(id)), ("tables", J::strs(tables)), ("offered", J::strs(offered))])
        };
        let check = |asked: &[J], leaf: &[J]| -> Vec<String> {
            let (mut pi, mut fill) = (gen.g("page_in").clone(), gen.g("fill").clone());
            if !asked.is_empty() {
                pi.set("asked", J::Arr(asked.to_vec()));
            }
            if !leaf.is_empty() {
                assert!(fill.set_path(&["knobs", "spec", "asked"].map(String::from), J::Arr(leaf.to_vec())));
            }
            let tree = tree_j(&pi, &fill, &reg, &ext).unwrap();
            core::content_problems(tree.g("page_spec"), &tree, &ext, &reg).0
        };
        // the fixture's main is the table "sdg" (its rows series:sdg/...), so the record's prefix here is that id
        let ren = rec("renewable_share", &["sdg", "nrg_ind_ren"], &["sdg"]);
        let lined = rec("co2", &["EN.GHG.", "env_air_gge"], &[]);
        let offered = rec("co2", &["EN.GHG.", "env_air_gge"], &["env_air_gge"]);
        assert_eq!(check(&[], &[]), Vec::<String>::new());
        assert_eq!(check(&[ren.clone()], &[ren.clone()]), Vec::<String>::new());
        assert_eq!(check(&[ren.clone(), lined.clone()], &[ren.clone(), lined.clone()]), Vec::<String>::new());
        let off = check(&[ren.clone(), offered.clone()], &[ren.clone(), offered.clone()]);
        assert_eq!(off, vec!["C6: the question asks for co2 but the page draws no row from EN.GHG., env_air_gge".to_string()]);
        let off = check(&[ren.clone(), offered], &[ren.clone(), lined.clone()]);
        assert!(off.iter().any(|e| e.contains("its unanswered line does not stand, as env_air_gge was offered for it")), "{off:?}");
        // two asked quantities, both drawn on the page (each record's prefixes start the drawn table): passes
        let share = rec("renewable_level", &["sdg"], &["sdg"]);
        assert_eq!(check(&[ren.clone(), share.clone()], &[ren.clone(), share]), Vec::<String>::new());
        // one drawn and the other with no offered table, but the leaf's spec carries no line for it (none printed): refused
        let off = check(&[ren.clone(), lined.clone()], &[ren]);
        assert!(off.len() == 1 && off[0].contains("co2") && off[0].ends_with("and carries no unanswered line for it"), "{off:?}");
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
            // the layers the prototype asked: not the leader notes, which lay themselves out in their leaf and stop nowhere here
            let layers: Vec<String> = bindings.g("recipes").g(&st(c.g("recipe"))).arr().iter().map(st).filter(|l| l != "leader_notes").collect();
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
        let p3 = fx.g("cases").arr().iter().find(|c| c.g("id").s() == Some("P3")).unwrap();
        let (page_in, fill) = stop_case(p3);
        let layers = ["bars".to_string(), "bubbles".to_string()];
        let out = draw(&fill.to_value(), &page_in.to_value(), &layers, Path::new("/nonexistent-runtime")).unwrap();
        assert_eq!(out.timing.iter().map(|t| t.3.clone()).collect::<Vec<_>>(), [Some("value_domain".into()), Some("value_domain".into())]);
        assert_eq!(out.placed, serde_json::json!({}));
    }

    /// The composition page inputs (scripts/fixtures/p4b/page-inputs.json, next_run composition_page_inputs over the
    /// design's input sets: q3 run 195240's two fetches and the next_run q3 test shapes), by set name.
    fn parts_input(name: &str) -> J {
        let all = core::parse(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/fixtures/p4b/page-inputs.json")).unwrap()).unwrap();
        all.g(name).clone()
    }

    /// The production registry, its stacked100 declaration, and that declaration's selects over a page input with the
    /// core's results written in as the generator declares them (the second pass, the zero parts as the leaf declares them).
    fn parts_declared_selects(name: &str) -> (Vec<J>, Vec<J>) {
        let reg = core::load_registry(&core::bindings());
        let pi = parts_input(name);
        let d = declares(&reg, "stacked100", &pi).unwrap();
        let (_, rows, sels) = parts_selects(d, &pi).unwrap();
        let (_, got) = recheck_selects(&rows, &sels);
        let out = match parts_declared("stacked100", &pi, &reg) {
            Ok(o) => o,
            Err(Halt::Stop(w) | Halt::Bad(w)) => panic!("{name}: {w}"),
        };
        let zero = out.g("leaves").g("stacked100").get("zero").cloned().unwrap_or(J::Arr(vec![]));
        (rows, sels.iter().map(|s| with_results_of(s, &got, Some(&zero))).collect())
    }

    /// P4b-1 (design 2, M1-M12, P1-P3): the core recomputes every select the stacked100 declaration writes, so a declared
    /// result that is not the core's own is refused: two bars swapped, the place left out declared drawn, a place that adds
    /// up declared left out, a part above 0 declared zero, a zero part's cells cut short, a zero part left undeclared, an
    /// empty part left out or added, the others with a place left out among them or one never fetched missing, the
    /// candidates not in total order, the tolerance raised in the select. The honest declarations pass.
    #[test]
    fn next_tree_gen_parts_of_whole_core_refuses_what_it_does_not_recompute() {
        let fails = |name: &str, change: &dyn Fn(&mut Vec<J>)| {
            let (rows, mut sels) = parts_declared_selects(name);
            change(&mut sels);
            recheck_selects(&rows, &sels).0
        };
        for name in ["real", "synth_at_zero_empty", "synth_base", "synth_fr_nuclear_it_none"] {
            assert_eq!(fails(name, &|_| {}), Vec::<String>::new(), "{name}");
        }
        let edit = |id: &'static str, f: fn(&mut J)| {
            move |sels: &mut Vec<J>| {
                let i = sels.iter().position(|s| s.g("id").s() == Some(id)).unwrap();
                f(&mut sels[i]);
            }
        };
        fn arr(s: &J, k: &str) -> Vec<J> {
            s.g(k).arr().to_vec()
        }
        type Change = Box<dyn Fn(&mut Vec<J>)>;
        let cases: Vec<(&str, &str, Change)> = vec![
            ("M1 two bars swapped", "real", Box::new(edit("bars", |s| {
                let mut b = arr(s, "result");
                b.swap(0, 1);
                s.set("result", J::Arr(b));
            }))),
            ("M2 the place left out declared drawn", "real", Box::new(edit("bars", |s| {
                let mut b = arr(s, "result");
                b.pop();
                b.push(J::str("PT"));
                s.set("result", J::Arr(b));
                s.set("dropped", J::Arr(vec![]));
            }))),
            ("M3 a place that adds up declared left out", "real", Box::new(edit("bars", |s| {
                let mut d = arr(s, "dropped");
                d.push(J::obj_of(vec![("code", J::str("DE"))]));
                s.set("dropped", J::Arr(d));
            }))),
            ("M4 a part above 0 declared zero", "real", Box::new(edit("zero", |s| {
                let mut d = arr(s, "declared");
                d.push(J::obj_of(vec![("bar", J::str("FR")), ("part", J::str("fossil")), ("cells", J::strs(&["series:nrg_bal_peh/A.GEP.G3000.GWH.FR:2024:OBS_VALUE"]))]));
                s.set("declared", J::Arr(d));
            }))),
            ("M5 a zero part's cells cut short", "synth_at_zero_empty", Box::new(edit("zero", |s| {
                let mut d = arr(s, "declared");
                let mut first = d[0].clone();
                let mut cells = arr(&first, "cells");
                cells.pop();
                first.set("cells", J::Arr(cells));
                d[0] = first;
                s.set("declared", J::Arr(d));
            }))),
            ("M6 a zero part left undeclared", "synth_base", Box::new(edit("zero", |s| {
                let d = arr(s, "declared");
                s.set("declared", J::Arr(d[1..].to_vec()));
            }))),
            ("M7 an empty part left out", "synth_fr_nuclear_it_none", Box::new(edit("empty", |s| {
                let d = arr(s, "result");
                s.set("result", J::Arr(d[1..].to_vec()));
            }))),
            ("M8 an empty part added", "real", Box::new(edit("empty", |s| {
                let mut d = arr(s, "result");
                d.push(J::obj_of(vec![("bar", J::str("FR")), ("part", J::str("fossil"))]));
                s.set("result", J::Arr(d));
            }))),
            ("M9 others with the place left out among them", "real", Box::new(edit("others", |s| {
                let mut d = arr(s, "result");
                d.insert(0, J::str("PT"));
                s.set("result", J::Arr(d));
            }))),
            ("M10 others missing a country never fetched", "real", Box::new(edit("others", |s| {
                let mut d = arr(s, "result");
                d.pop();
                s.set("result", J::Arr(d));
            }))),
            ("M11 candidates not in total order", "real", Box::new(edit("candidates", |s| {
                let mut d = arr(s, "result");
                d.reverse();
                s.set("result", J::Arr(d));
            }))),
            ("M12 the tolerance raised in the select", "real", Box::new(edit("bars", |s| {
                let mut c = s.g("check").clone();
                let mut w = c.g("sum_within").clone();
                w.set("tol", J::obj_of(vec![("knob", J::str("stacked100.tol")), ("value", J::Num(1e-3))]));
                c.set("sum_within", w);
                s.set("check", c);
            }))),
        ];
        for (tag, name, change) in &cases {
            assert!(!fails(name, change.as_ref()).is_empty(), "{tag}: passed");
        }
        assert_eq!(cases.len(), 12);
    }

    /// P4b-1 (design 2, P4, L1-L5): the production stacked100 declaration lints clean; a tolerance that is no knob
    /// reference, the quarter loosened, the fill_after_drop stop removed, a word with a digit, a select kind the core
    /// cannot compute each refuse, and the generator then declares nothing (the page stops as the generator's failure).
    #[test]
    fn next_tree_gen_parts_of_whole_lint_refuses_a_loosened_declaration() {
        let reg = core::load_registry(&core::bindings());
        let d = reg.g("nodes").g("stacked100").g("declares").clone();
        assert_eq!(parts_lint("stacked100", &d, &reg), Vec::<String>::new());
        let with = |f: &dyn Fn(&mut J)| {
            let mut x = d.clone();
            f(&mut x);
            parts_lint("stacked100", &x, &reg)
        };
        let set_at = |x: &mut J, path: &[&str], v: J| assert!(x.set_path(&path.iter().map(|s| s.to_string()).collect::<Vec<_>>(), v), "{path:?}");
        type Edit = Box<dyn Fn(&mut J)>;
        let cases: Vec<(&str, Edit)> = vec![
            ("L1 tolerance a literal", Box::new(move |x: &mut J| set_at(x, &["selects", "4", "check", "sum_within", "tol", "value"], J::Num(1e-3)))),
            ("L2 max_dropped loosened to 1/2", Box::new(move |x: &mut J| set_at(x, &["stops", "1", "den"], J::Int(2)))),
            ("L3 fill_after_drop removed", Box::new(|x: &mut J| {
                let stops = x.g("stops").arr()[..2].to_vec();
                x.set("stops", J::Arr(stops));
            })),
            ("L4 a word with a digit", Box::new(move |x: &mut J| set_at(x, &["lines", "0", "segs", "0", "w"], J::str("图中为合计最大的 20 ")))),
            ("L5 a select kind the core cannot compute", Box::new(|x: &mut J| {
                let mut s = x.g("selects").arr().to_vec();
                s.push(J::obj_of(vec![("id", J::str("x")), ("kind", J::str("largest_gap"))]));
                x.set("selects", J::Arr(s));
            })),
        ];
        for (tag, f) in &cases {
            assert!(!with(f.as_ref()).is_empty(), "{tag}: passed");
        }
    }

    /// P4b-1: the stacked100 layer is declared by its generator (never a rust fill) and lays itself out in its leaf
    /// (geometry leaf): draw asks no node for it and gives it no placed geometry, and a stop of its cut is the registry's
    /// words, not the generator's failure.
    #[test]
    fn next_tree_gen_parts_of_whole_draws_in_its_leaf_and_stops_in_its_words() {
        let pi = parts_input("real");
        let out = draw(&serde_json::json!({"knobs": {"spec": {"hero": {}}}}), &pi.to_value(), &["stacked100".to_string()], Path::new("/nonexistent-runtime")).unwrap();
        assert_eq!((out.placed, out.timing.len()), (serde_json::json!({}), 0));
        let declared = declare("stacked100", &pi.to_value()).unwrap();
        assert_eq!(declared.leaves.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["stacked100"]);
        assert!(declared.rows.iter().filter(|(_, d)| *d).count() == 20 && declared.record.is_some() && declared.unit_drawn);
        // six more places whose parts miss their totals (their sum inputs gone): the registry's words with its prefix, never
        // "node stacked100: declare:"
        let mut short = pi.clone();
        let keep: Vec<J> = short.g("sum_rows").arr().iter().filter(|r| !matches!(r.g("dims").g("geo").s(), Some("RO" | "EL" | "HU" | "BG" | "DK" | "SK"))).cloned().collect();
        short.set("sum_rows", J::Arr(keep));
        let why = declare("stacked100", &short.to_value()).unwrap_err();
        assert!(why.starts_with("not this shape: stacked100: ") && why.contains("more than a quarter"), "{why}");
    }

    /// Only the stacked100 node, the leader notes and the scmp notes and big numbers lay themselves out in their leaf: draw
    /// asks no node and checks no placed geometry for such a layer, so another node declaring it in node-bindings.json
    /// would leave the core's geometry check unasked. Both notes placed themselves in their leaf before they were external
    /// too (P6 steps 1 and 2); what they say is the declaration's, declared again over the name rows (draw).
    #[test]
    fn next_tree_gen_only_stacked100_declares_geometry_leaf() {
        let bound = core::bindings();
        let leaf: Vec<&str> = bound.g("nodes").obj().iter().filter(|(_, n)| n.g("geometry").s() == Some("leaf")).map(|(k, _)| k.as_str()).collect();
        assert_eq!(leaf, ["map", "bignums", "leader_notes", "notes", "ring", "strip", "sankey", "stacked100"]);
    }

    /// The ring's finding over a hand page input narrowed to the origins it compares: its set phrase only when the core finds
    /// the focus among those origins (the set_of select); a focus outside them says its own change in the plain wording on
    /// the scoped line too (outside_set "plain"), and a declaration with no such word has no finding then, saying why; a
    /// focus whose change starts at zero (no share of its start) has no finding, saying why, scoped or not, and no stop.
    #[test]
    fn next_tree_gen_ring_finding_names_its_set_only_around_the_focus() {
        let row = |p: &str, t: &str, v: &str| {
            serde_json::json!({"src": format!("series:imp/{p}:{t}:OBS_VALUE"), "table": "imp", "dims": {"partner": p, "geo": "EU27_2020"}, "time": t, "value": v})
        };
        let rows = [row("RU", "2021", "8"), row("RU", "2024", "2"), row("NO", "2021", "5"), row("NO", "2024", "6"),
            row("US", "2021", "0"), row("US", "2024", "3"), row("DE", "2021", "4"), row("DE", "2024", "1")];
        let (reg, _) = core::registry_in_force();
        let d = declares(&reg, FINDING, &J::from_value(&serde_json::json!({"recipe": "ring"}))).unwrap().clone();
        let pi = |focus: &str, set: Option<serde_json::Value>| {
            let mut v = serde_json::json!({"recipe": "ring",
                "shape": {"main": "imp", "place": "partner", "hub": "EU27_2020", "fmt": "mio_m3", "countries": ["DE", "NO", "RU", "US"]},
                "picks": {"rules": [], "ranked": [], "marks": [], "t0": "2021", "t1": "2024", "top": ["NO", "US", "RU"], "focus": focus},
                "outside": ["NO", "RU", "US"], "rows": rows,
                "fill": {"facts": ["drawn", "lead0", "lead1", "gap", "lead"], "fmts": {}, "named": ["DE", "NO", "RU", "US"]}});
            if let Some(set) = set {
                v["set"] = set;
            }
            J::from_value(&v)
        };
        let set = || Some(serde_json::json!({"words": "在本指标最高的{n}项中", "members": 3}));
        let said = |d: &J, focus: &str, set: Option<serde_json::Value>| finding_declared(d, &pi(focus, set), &reg).unwrap().to_value();
        // the focus among the three origins: the set phrase, on the scoped line only
        let ru = said(&d, "RU", set());
        assert_eq!(ru["finding"]["set"], serde_json::json!("在本指标最高的{drawn}项中"), "{ru}");
        assert_eq!(ru["finding"]["headline"]["scoped"], serde_json::json!("{name.RU}在本指标最高的{drawn}项中下降{lead}"));
        assert!(ru.get("fell_back").is_none());
        // a member focus (DE, no origin of the map's): no set phrase, the scoped line is the plain one
        let de = said(&d, "DE", set());
        assert!(de["finding"].get("set").is_none(), "{de}");
        assert_eq!(de["finding"]["headline"]["scoped"], de["finding"]["headline"]["title"]);
        assert_eq!(de["finding"]["scoped"], de["finding"]["dek"]);
        assert_eq!(de["finding"]["headline"]["title"], serde_json::json!("{name.DE}下降{lead}"));
        assert!(de.get("fell_back").is_none());
        // must fail: the same declaration with no outside_set has no finding for that focus, and says why
        let mut strict = d.clone();
        strict.remove("outside_set");
        let off = said(&strict, "DE", set());
        assert!(off["finding"].is_null(), "{off}");
        assert_eq!(off["fell_back"], serde_json::json!("the subject is not among the places the set names"));
        assert!(said(&strict, "RU", set())["finding"]["set"].is_string());
        // a change from zero (US: 0 to 3): no finding, its reason, narrowed or not
        for set in [None, set()] {
            let us = said(&d, "US", set);
            assert!(us["finding"].is_null(), "{us}");
            assert_eq!(us["fell_back"], serde_json::json!("the change starts at zero: no share of its start"));
        }
    }

    /// A leaf mapping path ending in `?` is a field the leaf reads as optional (a gap note naming the other place prints
    /// no number); the registry marks the notes' number optional and nothing else.
    #[test]
    fn next_tree_gen_leaf_item_field_optional_only_when_marked() {
        let (reg, _) = core::registry_in_force();
        let mut marked = Vec::new();
        for (path, v) in core::walk(&reg, "") {
            if path.contains(".leaf.items.") && v.s().is_some_and(|s| s.ends_with('?')) {
                marked.push(st(v));
            }
        }
        assert!(!marked.is_empty() && marked.iter().all(|m| m == "note.value_text?"), "{marked:?}");
    }

    /// The scmp notes declared over a hand page input: one note per top origin in its order, the focus's marked, its change
    /// only where the map's rule holds (row_above: a text value above 0 at t0; a 0, no row or an unparsed value has none),
    /// the hub's note after them, no fact and no format of its own (the map's are the page's). A declaration with no fmt
    /// that declares facts (its own, a change format, formats, or a candidate's) is refused.
    #[test]
    fn next_tree_gen_scmp_notes_follow_the_map_rule_and_declare_no_fact() {
        let row = |p: &str, t: &str, v: &str| {
            serde_json::json!({"src": format!("series:imp/{p}:{t}:OBS_VALUE"), "table": "imp", "dims": {"partner": p, "geo": "EU27_2020"}, "time": t, "value": v})
        };
        let rows = [row("RU", "2021", "5"), row("RU", "2024", "3"), row("NO", "2021", "0"), row("NO", "2024", "4"), row("US", "2024", "2"), row("QA", "2021", ":"), row("QA", "2024", "1")];
        let pi = J::from_value(&serde_json::json!({"recipe": "scmp",
            "shape": {"main": "imp", "place": "partner", "hub": "EU27_2020", "fmt": "mio_m3", "countries": ["NO", "QA", "RU", "US"]},
            "picks": {"rules": ["change_focus"], "ranked": [], "marks": [], "t0": "2021", "t1": "2024", "top": ["RU", "NO", "US", "QA"], "focus": "RU", "y0": "21", "y1": "24"},
            "rows": rows}));
        let (reg, _) = core::registry_in_force();
        let d = declared_j("notes", &pi, &reg).unwrap();
        let note = |c: &str, ch: bool, f: bool| {
            let l = c.to_lowercase();
            serde_json::json!({"code": c, "a": format!("{l}21"), "b": format!("{l}24"), "ch": ch.then(|| format!("{l}_ch")), "share": format!("{l}24_share"), "f": f})
        };
        assert_eq!(
            d.g("leaves").g("notes").to_value(),
            serde_json::json!({"notes": [note("RU", true, true), note("NO", false, false), note("US", false, false), note("QA", false, false),
                {"hub": true, "a": "tot21", "b": "tot24", "ch": "tot_ch"}]})
        );
        assert_eq!((d.g("facts").truthy(), d.g("fmts").truthy(), d.g("data").truthy()), (false, false, false), "no fact, format or data of its own");
        let with = |k: &str, v: J| {
            let mut r = reg.clone();
            let n = r.get_mut("nodes").and_then(|n| n.get_mut("notes")).and_then(|n| n.get_mut("declares_by_recipe")).and_then(|n| n.get_mut("scmp")).unwrap();
            match k {
                "candidate" => match n.get_mut("candidates") {
                    Some(J::Arr(c)) => c[1].set("facts", v),
                    _ => unreachable!("the scmp notes' candidates are a list"),
                },
                k => n.set(k, v),
            }
            declared_j("notes", &pi, &r).unwrap_err()
        };
        let obj = || J::obj_of(vec![("x", J::obj_of(vec![("op", J::str("n"))]))]);
        for (k, said) in [("facts", "facts"), ("fmt_change", "fmt_change"), ("formats", "formats"), ("candidate", "candidates' facts")] {
            assert_eq!(with(k, obj()), format!("notes: declares {said} and no fmt; a declaration with no fmt declares no fact of its own"));
        }
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
