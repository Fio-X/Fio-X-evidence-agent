//! New route, visual group: its one group command. Another group reaches the chart matcher only through `call`, with a
//! `Request` and back a `Reply` (both shared types under rule one); the matcher itself (shape_registry.rs) stays this group's.
//! It holds no state, writes nothing and runs no host tool. A page it draws by its recipe (next_render) and checks against
//! the ledger it came back with before handing it out; a page that passes has passed the visual gate only, which says
//! nothing about whether a number is verified. A leaf page it draws and bakes; the flow writes it (group_guard, inside this
//! group's door) and asks here whether the browser check passed those bytes.

use crate::next_facts::{compute, leaf_ledger, leaf_refs, stored_request, Fact, Row, Spec};
use crate::next_leaf::{bake_leaf_page, draw_page_given, leaves, Layer, Recipe, Record, Runner, Strip};
use crate::next_ledger::{check_numbers, dropped_entry, name_src, point_entry};
use crate::next_nodes::{Kind, Style};
use crate::next_render::{render, PageSpec, Rendered};
use crate::shape_registry::{Matched, PagePlan, Relation, Shape, View};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub enum Request<'a> {
    /// Every relation ranked for one data slice: `registered` lists the templates the registry has, `used_before` the
    /// relations earlier panels on the page already picked.
    Rank {
        shape: &'a Shape,
        registered: &'a [&'a str],
        used_before: &'a [Relation],
    },
    /// The same, in the first-to-last view only and whatever the slice's size: for a series of each entity's first and last
    /// value.
    RankFirstToLast {
        shape: &'a Shape,
        registered: &'a [&'a str],
        used_before: &'a [Relation],
    },
    /// The page plan row (PAGE_PLANS) of each chart's relation and view, in chart order.
    PagePlan { forms: &'a [(Relation, View)] },
    /// The page for this spec by the column recipe, its knobs at their defaults.
    #[allow(dead_code)]
    // to be wired: the flow asks for its page here when the recipe opens (a user nod)
    Page { spec: &'a PageSpec },
    /// The leaf page for these layers: drawn by the leaf child (the layers byte for byte as Rust took them, draw_page), then
    /// baked and checked (bake_leaf_page). Nothing is written.
    LeafPage { page: &'a LeafPage<'a> },
    /// A leaf page's pieces from a filled request (plain JSON: the series rows, the knobs with the spec, and the layer names
    /// in order) by a page recipe, a composite node of the leaf registry (runtime/leaves_py/knobs.json groups): the facts
    /// computed from the rows, their ledger, the refs, and one layer of the recipe's node per name, each a layer the
    /// recipe groups, with the rows, the ledger as {src, text} rows and the knobs; and the children that draw, bake and
    /// check it, from the second layer under `runtime` (the run's materialized runtime/). Nothing is drawn or written.
    LeafFill {
        recipe: &'a str,
        rows: &'a [Value],
        knobs: &'a Value,
        order: &'a [String],
        runtime: &'a Path,
    },
    /// One run of the browser check (runtime/pi/browser_qa.py as the run materialized it, or a twin) on the page file at
    /// `html`, with `QA_SPEC` written beside its report in `out`: whether its report is a PASS for the bytes `html_sha256`.
    BrowserCheck {
        qa: &'a Runner,
        html: &'a Path,
        out: &'a Path,
        html_sha256: &'a str,
    },
    /// A number knob of a leaf node as the registry states it (runtime/leaves_py/knobs.json, next_leaf::leaves): its default
    /// and range. A word knob, or one the node does not have, is no number.
    Knob { node: &'a str, knob: &'a str },
    /// The page recipes of the leaf registry (runtime/leaves_py/knobs.json recipes), in the order the flow tries them.
    Recipes,
    /// A page recipe's layers, each group among them expanded into its own layers (the group's name kept), in the
    /// registry's order; none when the registry has no such recipe.
    RecipeLayers { recipe: &'a str },
    /// A published leaf page checked again at completion: the recipe is one of the registry's, the bake's own check
    /// (check_leaf_page) passes on these bytes with what it was checked against, and every `series:` entry of the ledger
    /// prints the value of the row it names. Nothing is drawn or written.
    LeafRecheck {
        recipe: &'a str,
        html: &'a str,
        ledger: &'a BTreeMap<String, String>,
        refs: &'a [String],
        facts: (&'a Spec, &'a [Row], &'a [Fact]),
    },
    /// The label point [lon, lat] of each iso3 code in the Natural Earth attributes table this group embeds (NE_ATTRIBUTES),
    /// with the table's bytes (the caller hashes and pins them). A country's point is its own feature's (adm0_a3 is its iso3:
    /// Australia, not the Indian Ocean territories filed under AUS); a code the table has no point for is listed as missing,
    /// never guessed. Which iso3 a data code is, is the knowledge group's to say.
    PlacePoints { iso3: &'a [String] },
    /// The illustration strip for a page of these tables (its refs), `width` wide: by the first piece set of PIECE_SETS that
    /// names one of them, drawn by the strip child under `runtime` (the run's materialized runtime/) in the page's ink and
    /// accent and taken only as line art in those (next_leaf::strip); none when no set names them. Nothing is written.
    IllusStrip { tables: &'a [String], width: f64, runtime: &'a Path },
    /// What the flow's fill takes from a layer its recipe binds external (next_tree_gen::declare, P4a): the rows it draws,
    /// the facts and the format it declares and its hero data, from the registry's declaration over the flow's page input
    /// (plain data: shape, picks, rows), every select recomputed by the core.
    NodeDeclare { layer: &'a str, page_in: &'a Value },
    /// The recipe's external layers over the finished fill (next_tree_gen::draw, P4a): the page tree written from the fill
    /// and the page input, each layer's node asked for its geometry by its registered runner under `runtime`, every select,
    /// fact, check, item and word the core's own and checked before the child starts (C1-C5), the reply's geometry checked
    /// against the core's recomputation (B0-B7); the checked geometry by layer, which the leaves draw.
    NodeDraw { fill: &'a Value, page_in: &'a Value, layers: &'a [String], runtime: &'a Path },
}

/// The illustration piece sets the second layer describes (runtime/leaves_js/pieces-<set>.json: its pieces, knobs and the
/// tables it illustrates), in the order a page's tables are matched against them.
const PIECE_SETS: &[&str] = &[include_str!("../runtime/leaves_js/pieces-energy.json")];

/// The leaf pages' palette (scmp.shell puts it on every page): a strip strokes in its ink and second pen by name, so the page
/// colours it and no second copy of a colour is kept. The second pen (the request's "accent", each piece's one marked part)
/// is a grey of the page's: the page's accent marks its focus alone (bubbles.py, column.py), never a drawing.
const PAGE_TOKENS: &str = include_str!("../runtime/leaves_py/tokens.css");
const STRIP_INK: &str = "--t-title";
const STRIP_SECOND: &str = "--t-sec";

/// The strip of a page of `tables` and why: none when no piece set names one of them; Err when the set does not parse, the
/// palette lacks a colour, or the strip is refused or not taken.
fn illus_strip(tables: &[String], width: f64, runtime: &Path) -> Result<(Option<Strip>, String), String> {
    let mut picked = None;
    for text in PIECE_SETS {
        let set: Value = serde_json::from_str(text).map_err(|e| format!("illus: a piece set does not parse: {e}"))?;
        let named = set["tables"].as_array().into_iter().flatten().any(|t| t.as_str().is_some_and(|t| tables.iter().any(|x| x == t)));
        if named {
            picked = Some(set);
            break;
        }
    }
    let Some(set) = picked else {
        return Ok((None, format!("illus: no piece set illustrates {}", tables.join(", "))));
    };
    let name = set["set"].as_str().unwrap_or_default().to_string();
    let colours = [STRIP_INK, STRIP_SECOND].map(|c| format!("var({c})"));
    if let Some(c) = [STRIP_INK, STRIP_SECOND].iter().find(|c| !PAGE_TOKENS.contains(&format!("{c}:"))) {
        return Err(format!("illus: the page palette defines no {c}"));
    }
    let request = json!({"set": set, "width": width, "ink": colours[0], "accent": colours[1], "knobs": {}});
    let runner = Runner::node(&runtime.join("leaves_js/illus_strip.cjs"));
    let strip = crate::next_leaf::strip(&runner, &request, &colours.each_ref().map(String::as_str))
        .map_err(|why| format!("illus: the {name} strip was not taken: {why}"))?;
    let note = format!("illus: {name} drawn {}x{} in {} ms, left out {}: {}", strip.w, strip.h, strip.ms, strip.dropped.len(), strip.dropped.join("; "));
    Ok((Some(strip), note))
}

/// The vendored Natural Earth admin-0 attributes (scripts/build_ne_attributes.mjs): each country's label point
/// (features[].label, [lon, lat]) by iso3. The bytes the binary embeds are the table PlacePoints answers from and hashes.
const NE_ATTRIBUTES: &str = include_str!("../runtime/pi/assets/naturalearth-admin0-50m-attributes.json");

/// The label points by iso3: the NE_ATTRIBUTES features with an iso3 and a finite [lon, lat] on the globe, a country's own
/// feature only (adm0_a3 its iso3, or the one feature filed under it); an iso3 with no such feature, or with two, has none.
fn label_points() -> Result<&'static BTreeMap<String, [f64; 2]>, String> {
    static POINTS: OnceLock<Result<BTreeMap<String, [f64; 2]>, String>> = OnceLock::new();
    POINTS
        .get_or_init(|| {
            let ne: Value = serde_json::from_str(NE_ATTRIBUTES).map_err(|e| format!("naturalearth attributes: {e}"))?;
            let features = ne["features"].as_array().map_or(&[][..], Vec::as_slice);
            let mut own: BTreeMap<String, Vec<[f64; 2]>> = BTreeMap::new();
            for f in features {
                let (Some(iso3), Some(lon), Some(lat)) = (f["iso3"].as_str(), f["label"][0].as_f64(), f["label"][1].as_f64()) else { continue };
                if !((-180.0..=180.0).contains(&lon) && (-90.0..=90.0).contains(&lat)) {
                    return Err(format!("naturalearth attributes: {iso3} has its label off the globe"));
                }
                let mine = own.entry(iso3.to_string()).or_default();
                if f["adm0_a3"].as_str() == Some(iso3) || features.iter().filter(|g| g["iso3"] == iso3).count() == 1 {
                    mine.push([lon, lat]);
                }
            }
            Ok(own.into_iter().filter_map(|(c, p)| (p.len() == 1).then(|| (c, p[0]))).collect())
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// What a leaf page is drawn from: the leaf child and the bake, the panel, its layers, and the ledger with the refs, spec,
/// rows and facts the baked page is checked against.
pub struct LeafPage<'a> {
    pub draw: &'a Runner,
    pub bake: &'a Runner,
    pub w: f64,
    pub h: f64,
    pub frame: Value,
    pub layers: &'a [Layer<'a>],
    pub ledger: &'a BTreeMap<String, String>,
    pub refs: &'a [String],
    pub facts: (&'a Spec, &'a [Row], &'a [Fact]),
    /// The page's illustration strip (Request::IllusStrip), placed by the page as its layer illus_strip; none, no strip.
    pub strip: Option<&'a Strip>,
}

/// A leaf page drawn and baked: the baked page, the one the browser check and the manifest are to name, the leaf child's
/// records, a ledger entry (src, text; next_ledger::dropped_entry, never printed) for each thing a layer dropped, which
/// the flow keeps with the page's request, and what the bake measured of its type (next_leaf::Baked).
pub struct LeafDrawn {
    pub html: String,
    pub records: Vec<Record>,
    pub dropped: Vec<(String, String)>,
    pub type_measured: Option<Value>,
    /// The radius scales the layers said they drew at (next_leaf Panel::scales), for the page's event.
    pub scales: Vec<Value>,
    /// What the drawn check compared on each external layer ({layer, compared, failed}, drawn_checked), for the page's event.
    pub drawn_checked: Vec<Value>,
}

/// A leaf page as LeafFill built it, owned but for the layer names: the flow lends it as a LeafPage with its draw and bake
/// children, and its browser check child to the publication.
pub struct LeafFill<'a> {
    pub layers: Vec<Layer<'a>>,
    pub ledger: BTreeMap<String, String>,
    pub refs: Vec<String>,
    pub spec: Spec,
    pub rows: Vec<Row>,
    pub facts: Vec<Fact>,
    pub frame: Value,
    pub w: f64,
    pub h: f64,
    pub draw: Runner,
    pub bake: Runner,
    pub qa: Runner,
}

/// The value of attribute `name` in one start tag's text (its first occurrence), as written.
fn attr<'t>(tag: &'t str, name: &str) -> Option<&'t str> {
    let key = format!(" {name}=\"");
    let at = tag.find(&key)? + key.len();
    tag[at..].find('"').map(|e| &tag[at..at + e])
}

/// The drawn check: on each layer its recipe binds external (knobs.external), the page as drawn (`html`, before the bake)
/// prints the geometry the core placed and checked (knobs.placed[layer]), number for number. The layer's group (its one
/// data-layer element, no group nested in it) holds one rect per placed item, in item order, at the item's mark (x, y,
/// width, height), and one text per placed text, in item order and the core's text order, at the text's x, y with its
/// anchor; each number is compared as the leaf prints it (one decimal), each anchor as a word. One more or one fewer, a
/// layer that is missing or cannot be read, or any number that differs refuses the page; the leaf's other marks (an axis
/// line) are no placed geometry and are not compared. Ok is {layer, compared, failed} per external layer.
fn drawn_checked(html: &str, layers: &[Layer<'_>]) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for layer in layers {
        let (name, knobs) = (layer.name(), layer.knobs());
        if !knobs["external"].as_array().is_some_and(|e| e.iter().any(|x| x == name)) {
            continue;
        }
        let refuse = |why: String| format!("drawn: layer {name}: {why}");
        let marker = format!("data-layer=\"{name}\"");
        if html.matches(&marker).count() != 1 {
            return Err(refuse(format!("the page has {} elements tagged {marker}, not one", html.matches(&marker).count())));
        }
        let start = html.find(&marker).expect("counted once");
        let body = &html[start..];
        let body = &body[..body.find("</g>").ok_or_else(|| refuse("its group is not closed".into()))?];
        if body.contains("<g") {
            return Err(refuse("a group nested in it, which the check cannot read".into()));
        }
        let tags = |el: &str| -> Vec<&str> {
            let open = format!("<{el} ");
            body.match_indices(&open).map(|(i, _)| &body[i..i + body[i..].find('>').unwrap_or(body.len() - i)]).collect()
        };
        let (rects, texts) = (tags("rect"), tags("text"));
        let items = knobs["placed"][name]["items"].as_array().cloned().unwrap_or_default();
        let want_texts: Vec<&Value> = items.iter().flat_map(|it| it["texts"].as_array().into_iter().flatten()).collect();
        let (mut compared, mut failed, mut first) = (0usize, 0usize, None::<String>);
        let mut miss = |what: String, ok: bool, first: &mut Option<String>| {
            compared += 1;
            if !ok {
                failed += 1;
                first.get_or_insert(what);
            }
        };
        let printed = |v: Option<f64>| v.map(|v| format!("{v:.1}"));
        for (i, it) in items.iter().enumerate() {
            let rect = rects.get(i).copied().unwrap_or("");
            for (a, k) in [("x", "x"), ("y", "y"), ("width", "w"), ("height", "h")] {
                let page = printed(attr(rect, a).and_then(|v| v.parse().ok()));
                let placed = printed(it["mark"][k].as_f64());
                miss(format!("item {i} rect {a}: drawn {page:?}, placed {placed:?}"), page.is_some() && page == placed, &mut first);
            }
        }
        for (j, t) in want_texts.iter().enumerate() {
            let text = texts.get(j).copied().unwrap_or("");
            for a in ["x", "y"] {
                let page = printed(attr(text, a).and_then(|v| v.parse().ok()));
                let placed = printed(t[a].as_f64());
                miss(format!("text {j} {a}: drawn {page:?}, placed {placed:?}"), page.is_some() && page == placed, &mut first);
            }
            let anchor = if text.is_empty() { None } else { Some(attr(text, "text-anchor").unwrap_or("start")) };
            miss(format!("text {j} anchor: drawn {anchor:?}, placed {}", t["anchor"]), anchor.is_some() && anchor == t["anchor"].as_str(), &mut first);
        }
        miss(format!("{} rects drawn, {} placed", rects.len(), items.len()), rects.len() == items.len(), &mut first);
        miss(format!("{} texts drawn, {} placed", texts.len(), want_texts.len()), texts.len() == want_texts.len(), &mut first);
        if items.is_empty() {
            return Err(refuse("the request gives no placed items for it".into()));
        }
        if failed > 0 {
            return Err(refuse(format!("{failed} of {compared} drawn numbers are not the placed ones, first {}", first.unwrap_or_default())));
        }
        out.push(json!({"layer": name, "compared": compared, "failed": failed}));
    }
    Ok(out)
}

/// The panel a filled page is drawn in: the page's width, its height left to the child (0; it says the panel before any layer,
/// next_leaf drawn), no frame.
const FILL_W: f64 = 1140.0;
const FILL_H: f64 = 0.0;

/// The pieces of a filled leaf page (Request::LeafFill). Err lists what does not compute or register, one per line; a
/// recipe the registry does not group, or a layer it does not hold, names what it holds and one example.
fn fill<'a>(
    recipe: &'a str,
    rows: &[Value],
    knobs: &Value,
    order: &'a [String],
    runtime: &Path,
) -> Result<LeafFill<'a>, String> {
    let groups = &leaves().groups;
    let Some(holds) = groups.get(recipe) else {
        let names: Vec<_> = groups.keys().map(String::as_str).collect();
        return Err(format!("fill: no recipe {recipe}; e.g. one of {}", names.join("|")));
    };
    let stray: Vec<String> = order
        .iter()
        .filter(|n| !holds.contains(n))
        .map(|n| format!("fill: the recipe {recipe} holds no layer {n}; e.g. one of {}", holds.join("|")))
        .collect();
    if !stray.is_empty() {
        return Err(stray.join("\n"));
    }
    let (spec, table_rows, _) = stored_request(&json!({"knobs": knobs, "rows": rows}));
    let facts = compute(&spec, &table_rows)?;
    let mut ledger = leaf_ledger(&spec, &table_rows, &facts)?;
    // the names the leaves mark (name_src), each the request's label for its code as the knowledge group gave it; the page
    // check holds every marked name to its entry
    for (code, name) in knobs["labels"].as_object().into_iter().flatten() {
        if let Some(name) = name.as_str() {
            ledger.insert(name_src(code), name.to_string());
        }
    }
    // the names of the page's own data that are no place (knobs.named, name row -> text: a table's reviewed title, which the
    // map's key prints), marked and held to their entry the same way; anything but a name row with a text refuses
    for (src, name) in knobs["named"].as_object().into_iter().flatten() {
        match name.as_str() {
            Some(name) if src.starts_with(crate::next_ledger::LABEL_SRC) => {
                ledger.insert(src.clone(), name.to_string());
            }
            _ => return Err(format!("fill: knobs.named {src} is no name row ({}...) with a text", crate::next_ledger::LABEL_SRC)),
        }
    }
    // the map points the leaves draw places at (knobs.points, the flow's from the pinned table), kept as ledger entries
    // with the page's request: never printed, there for a replay of that table
    let points = &knobs["points"];
    for (code, at) in points["at"].as_object().into_iter().flatten() {
        let (Some(table), Some(sha), Some(lon), Some(lat)) = (points["table"].as_str(), points["sha256"].as_str(), at[0].as_f64(), at[1].as_f64()) else {
            return Err(format!("fill: the map point of {code} names no table, sha256 or [lon, lat]"));
        };
        let (src, text) = point_entry(table, sha, code, [lon, lat]);
        ledger.insert(src, text);
    }
    let refs = leaf_refs(&knobs["spec"]["tables"])?;
    let mut knobs = knobs.clone();
    // the recipe's external layers (knobs.json, from the registry's recipes), which the leaf draws from their placed geometry
    // only (run.py layer_fn); the leaf reads it here, never from the flow
    let external = leaves().recipes.iter().find(|r| r.name == recipe).map(|r| r.external.clone()).unwrap_or_default();
    knobs["external"] = json!(external);
    // the footer marks these ids in the source line (scmp.footer), the same the page check reads; a request's own kept
    if knobs["spec"].get("refs").is_none() {
        knobs["spec"]["refs"] = json!(refs);
    }
    one_mark_per_period(&mut knobs, &facts);
    let mut all = rows.to_vec();
    all.extend(ledger.iter().map(|(src, text)| json!({"src": src, "text": text})));
    let all = Value::Array(all);
    let (mut layers, mut off) = (Vec::new(), Vec::new());
    for name in order {
        match Layer::registered(recipe, name, all.clone(), knobs.clone()) {
            Ok(layer) => layers.push(layer),
            Err(e) => off.extend(e),
        }
    }
    if !off.is_empty() {
        return Err(off.join("\n"));
    }
    Ok(LeafFill {
        layers,
        ledger,
        refs,
        spec,
        rows: table_rows,
        facts,
        frame: Value::Null,
        w: FILL_W,
        h: FILL_H,
        draw: Runner::python(&runtime.join("leaves_py/run.py")),
        bake: Runner::python(&runtime.join("leaves_py/bake.py")),
        qa: Runner::python(&runtime.join("browser_qa.py")),
    })
}

/// The ring's marks (hero.ring.marks, each {key: <fact>}) keep one per period: a mark whose fact was read at the period of
/// a mark before it (a peak in the last month) is dropped, so two marks never sit on one month.
fn one_mark_per_period(knobs: &mut Value, facts: &[Fact]) {
    let Some(marks) = knobs.pointer_mut("/spec/hero/ring/marks").and_then(Value::as_array_mut) else {
        return;
    };
    let mut seen: Vec<String> = Vec::new();
    marks.retain(|m| match facts.iter().find(|f| m["key"] == f.key.as_str()).and_then(|f| f.t.clone()) {
        Some(t) if seen.contains(&t) => false,
        Some(t) => {
            seen.push(t);
            true
        }
        None => true,
    });
}

/// The program's browser check for a leaf page: the desktop width the bake lays the page out at, as an archive page.
pub const QA_SPEC: &str = r#"{"delivery":{"breakpoints":[1440],"packaging":"archive"}}"#;
/// How long the browser check may take before it is stopped and the page left unpublished.
const QA_DEADLINE: Duration = Duration::from_secs(90);

pub enum Reply<'a> {
    /// Best first; no candidate means narrow the filter.
    Matched(Matched),
    /// One row per relation asked, in the same order.
    Plans(Vec<&'static PagePlan>),
    /// The drawn page and its ledger; every digit on it was found printing its ledger entry or naming a table the spec names.
    Page(Rendered),
    /// The leaf page, baked and checked.
    Leaf(LeafDrawn),
    /// The filled page's pieces, for the flow to lend as a LeafPage.
    Filled(LeafFill<'a>),
    /// The browser check's PASS report for the bytes asked about.
    Checked(Value),
    /// A number knob's default and range.
    Knob { default: f64, min: f64, max: f64 },
    /// The page recipes, in registry order.
    Recipes(&'static [Recipe]),
    /// A recipe's layers with its groups expanded; none for a recipe the registry does not have.
    Layers(Option<Vec<String>>),
    /// What a published leaf page fails, one line each; empty when it passes.
    Rechecked(Vec<String>),
    /// The page's illustration strip, none when no piece set names its tables, and what was drawn or why none.
    Strip { strip: Option<Strip>, note: String },
    /// What the flow's fill takes from an external layer, derived by the generator (drawn rows, facts, formats, hero data).
    NodeDeclared(Box<crate::next_tree_gen::NodeDeclared>),
    /// The external layers' checked geometry by layer, and per layer the child's and the core's milliseconds.
    NodesDrawn(Box<crate::next_tree_gen::NodesDrawn>),
    /// The label point of each iso3 asked that has one, the ones that have none in the order asked, and the table read.
    Points {
        points: BTreeMap<String, [f64; 2]>,
        missing: Vec<String>,
        /// The table the points were read from, as the binary embeds it.
        table: &'static str,
    },
}

/// The visual group's command. Only a page can fail: Err lists what could not be drawn, or every digit the page check found
/// off the ledger (one per line); no page leaves with one.
pub fn call(request: Request<'_>) -> Result<Reply<'_>, String> {
    Ok(match request {
        Request::Rank {
            shape,
            registered,
            used_before,
        } => Reply::Matched(crate::shape_registry::rank(shape, registered, used_before)),
        Request::RankFirstToLast {
            shape,
            registered,
            used_before,
        } => Reply::Matched(crate::shape_registry::rank_first_to_last(
            shape,
            registered,
            used_before,
        )),
        Request::PagePlan { forms } => Reply::Plans(
            forms
                .iter()
                .map(|(r, v)| crate::shape_registry::page_plan(*r, *v))
                .collect(),
        ),
        Request::Page { spec } => {
            let page = render(spec, &Style::default())?;
            let off = check_numbers(&page.html, &page.ledger, &spec.refs);
            if !off.is_empty() {
                return Err(off.join("\n"));
            }
            Reply::Page(page)
        }
        Request::LeafPage { page } => {
            let given: Vec<(&str, &Strip)> = page.strip.map(|s| ("illus_strip", s)).into_iter().collect();
            let (panel, html, records) = draw_page_given(page.draw, page.w, page.h, page.frame.clone(), page.layers, &given)
                .map_err(|(_, why)| why.join("\n"))?;
            let checked = drawn_checked(&html, page.layers)?;
            let baked = bake_leaf_page(page.bake, &html, page.ledger, page.refs, page.facts).map_err(|off| off.join("\n"))?;
            Reply::Leaf(LeafDrawn {
                html: baked.html,
                records,
                dropped: panel.dropped.iter().map(|d| dropped_entry(&d.layer, &d.id, &d.why)).collect(),
                type_measured: baked.type_measured,
                scales: panel.scales.clone(),
                drawn_checked: checked,
            })
        }
        Request::LeafFill { recipe, rows, knobs, order, runtime } => Reply::Filled(fill(recipe, rows, knobs, order, runtime)?),
        Request::BrowserCheck {
            qa,
            html,
            out,
            html_sha256,
        } => Reply::Checked(passed(browser_check(qa, html, out)?, html_sha256)?),
        Request::Knob { node, knob } => {
            let leaf = leaves().nodes.get(node).ok_or_else(|| format!("knob: the leaf registry has no node {node}"))?;
            match leaf.info.knobs.iter().find(|k| k.name == knob).map(|k| &k.kind) {
                Some(Kind::Range { default, min, max, .. }) => Reply::Knob { default: *default, min: *min, max: *max },
                Some(Kind::Pick { .. } | Kind::Codes { .. }) => return Err(format!("knob: {node}.{knob} is a word, not a number")),
                None => return Err(format!("knob: node {node} has no knob {knob}")),
            }
        }
        Request::Recipes => Reply::Recipes(&leaves().recipes),
        Request::RecipeLayers { recipe } => Reply::Layers(recipe_layers(recipe)),
        Request::LeafRecheck { recipe, html, ledger, refs, facts: (spec, rows, facts) } => {
            let mut off = Vec::new();
            if !leaves().recipes.iter().any(|r| r.name == recipe) {
                off.push(format!("page: {recipe} is no recipe of the leaf registry"));
            }
            off.extend(crate::next_leaf::check_leaf_page(html, ledger, refs, spec, rows, facts));
            for (src, text) in ledger.iter().filter(|(s, _)| s.starts_with("series:")) {
                match rows.iter().find(|r| r.src == *src) {
                    Some(row) if crate::next_ledger::prints(text, row.value) => {}
                    Some(row) => off.push(format!("{src}: prints {text:?}, the row holds {}", row.value)),
                    None => off.push(format!("{src}: no row of the request holds it")),
                }
            }
            Reply::Rechecked(off)
        }
        Request::PlacePoints { iso3 } => {
            let by_iso3 = label_points()?;
            let (mut points, mut missing) = (BTreeMap::new(), Vec::new());
            for code in iso3.iter().map(|c| c.trim()) {
                match by_iso3.get(code) {
                    Some(p) => {
                        points.insert(code.to_string(), *p);
                    }
                    None if !missing.iter().any(|m| m == code) => missing.push(code.to_string()),
                    None => {}
                }
            }
            Reply::Points { points, missing, table: NE_ATTRIBUTES }
        }
        Request::IllusStrip { tables, width, runtime } => {
            let (strip, note) = illus_strip(tables, width, runtime)?;
            Reply::Strip { strip, note }
        }
        Request::NodeDeclare { layer, page_in } => Reply::NodeDeclared(Box::new(crate::next_tree_gen::declare(layer, page_in)?)),
        Request::NodeDraw { fill, page_in, layers, runtime } => {
            Reply::NodesDrawn(Box::new(crate::next_tree_gen::draw(fill, page_in, layers, runtime)?))
        }
    })
}

/// Request::RecipeLayers: the recipe's layers, a group's name followed by its own layers (a group inside it likewise).
fn recipe_layers(recipe: &str) -> Option<Vec<String>> {
    fn expand(layer: &str, groups: &BTreeMap<String, Vec<String>>, out: &mut Vec<String>) {
        if out.iter().any(|l| l == layer) {
            return;
        }
        out.push(layer.to_string());
        for inner in groups.get(layer).into_iter().flatten() {
            expand(inner, groups, out);
        }
    }
    let table = leaves();
    let found = table.recipes.iter().find(|r| r.name == recipe)?;
    let mut out = Vec::new();
    for layer in &found.layers {
        expand(layer, &table.groups, &mut out);
    }
    Some(out)
}

/// The report, when it is a PASS for the bytes `html_sha256`; a FAIL (with its first errors) or a PASS for other bytes is no
/// pass.
fn passed(report: Value, html_sha256: &str) -> Result<Value, String> {
    let status = report["status"].as_str().unwrap_or("no status");
    if status != "PASS" {
        let errors: Vec<&str> = report["errors"].as_array().into_iter().flatten().filter_map(Value::as_str).take(8).collect();
        return Err(format!("browser check: {status}: {}", errors.join("; ")));
    }
    if report["html_sha256"].as_str() != Some(html_sha256) {
        return Err(format!(
            "browser check: the PASS report is for html_sha256 {}, not the page written ({html_sha256})",
            report["html_sha256"]
        ));
    }
    Ok(report)
}

/// One run of the browser check on `html` (`--html --spec --output`, the spec beside its report in `out`): the report it
/// wrote. Its exit code is its status (browser_qa.py), so only the report is read; none within QA_DEADLINE is an error.
fn browser_check(runner: &Runner, html: &Path, out: &Path) -> Result<Value, String> {
    let mut child = Command::new(&runner.program)
        .args(&runner.args)
        .arg("--html")
        .arg(html)
        .arg("--spec")
        .arg(out.join("spec.json"))
        .arg("--output")
        .arg(out)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("browser check: {} would not start: {e}", runner.program))?;
    let started = Instant::now();
    while child.try_wait().map_err(|e| format!("browser check: {e}"))?.is_none() {
        if started.elapsed() > QA_DEADLINE {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("browser check: no report within {}s", QA_DEADLINE.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    std::fs::read_to_string(out.join("browser-qa.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or_else(|| "browser check: it wrote no readable browser-qa.json".to_string())
}


#[cfg(test)]
mod tests {
    use super::*;

    /// The drawn check: a bars layer printed where the core placed it passes, counted; one bar 0.1 px wider, a bar more, a
    /// text short, a text at another anchor, two texts in each other's place or a layer missing from the page refuses, and
    /// a layer its recipe does not bind external, or no external layer, is not compared.
    #[test]
    fn the_drawn_check_holds_an_external_layer_to_its_placed_geometry() {
        let item = |i: usize, w: f64| {
            let y = 6.0 + 24.0 * i as f64;
            json!({"code": format!("C{i}"), "mark": {"x": 100.25, "y": y + 3.0, "w": w, "h": 18},
                "texts": [{"name": "label", "x": 92.25, "y": y + 12.0, "anchor": "end", "src": "C"},
                          {"name": "value_text", "x": 106.25 + w, "y": y + 12.0, "anchor": "start", "src": format!("fact:v.C{i}.n")}]})
        };
        let items = vec![item(0, 400.123), item(1, 200.5)];
        let bar = |it: &Value, w: Option<&str>| {
            let (m, t) = (&it["mark"], &it["texts"]);
            let w = w.map_or(format!("{:.1}", m["w"].as_f64().unwrap()), str::to_string);
            format!(
                r#"<text x="{:.1}" y="{:.1}" text-anchor="end" font-size="13">N</text><rect x="{:.1}" y="{:.1}" width="{w}" height="18" fill="x"/><text x="{:.1}" y="{:.1}" font-size="13"><tspan data-src="s">1</tspan></text>"#,
                t[0]["x"].as_f64().unwrap(), t[0]["y"].as_f64().unwrap(), m["x"].as_f64().unwrap(), m["y"].as_f64().unwrap(),
                t[1]["x"].as_f64().unwrap(), t[1]["y"].as_f64().unwrap()
            )
        };
        let page = |inner: &str| format!(r#"<svg class="bars"><g data-layer="bars"><line x1="100.2" x2="100.2" y1="6" y2="54"/>{inner}</g></svg>"#);
        let good = page(&format!("{}{}", bar(&items[0], None), bar(&items[1], None)));
        let knobs = json!({"external": ["bars"], "placed": {"bars": {"items": items}}});
        let layers = |knobs: Value| vec![Layer::registered("column", "bars", json!([]), knobs).unwrap()];
        assert_eq!(drawn_checked(&good, &layers(knobs.clone())).unwrap(), vec![json!({"layer": "bars", "compared": 22, "failed": 0})]);
        let refused = |html: &str, words: &str| {
            let why = drawn_checked(html, &layers(knobs.clone())).unwrap_err();
            assert!(why.starts_with("drawn: layer bars: ") && why.contains(words), "{words}: {why}");
        };
        refused(&page(&format!("{}{}", bar(&items[0], Some("400.2")), bar(&items[1], None))), "item 0 rect width");
        refused(&format!("{}<rect x=\"1\" y=\"1\" width=\"1\" height=\"1\"/></g>", good.trim_end_matches("</g></svg>")), "3 rects drawn, 2 placed");
        refused(&good.replacen("<text x=\"92.2\" y=\"18.0\" text-anchor=\"end\" font-size=\"13\">N</text>", "", 1), "11 of 22 drawn numbers are not the placed ones, first text 0 x");
        refused(&good.replacen("text-anchor=\"end\"", "text-anchor=\"middle\"", 1), "text 0 anchor");
        refused(&page(&format!("{}{}", bar(&items[1], None), bar(&items[0], None))), "item 0 rect");
        refused("<svg></svg>", "elements tagged");
        refused(&good.replacen("<line", "<g><line", 1), "nested");
        let off = json!({"external": [], "placed": {}});
        assert_eq!(drawn_checked("<svg></svg>", &layers(off)).unwrap(), Vec::<Value>::new());
        let none = json!({"external": ["bars"], "placed": {"bars": {"items": []}}});
        assert!(drawn_checked(&page(""), &layers(none)).unwrap_err().contains("no placed items"));
    }

    /// A peak in the ring's last month leaves one mark there; marks on two months, or naming no computed fact, all stay.
    #[test]
    fn a_ring_mark_on_a_month_another_mark_has_is_dropped() {
        let fact = |key: &str, t: &str| Fact {
            key: key.into(),
            op: "peak".into(),
            v: 1.0,
            t: Some(t.into()),
            n: None,
            who: Vec::new(),
            fmt: "m".into(),
            reads: Vec::new(),
        };
        let marks = |facts: &[Fact]| {
            let mut knobs = json!({"spec": {"hero": {"ring": {"marks": [{"key": "p"}, {"key": "l"}, {"key": "x"}]}}}});
            one_mark_per_period(&mut knobs, facts);
            knobs["spec"]["hero"]["ring"]["marks"].clone()
        };
        assert_eq!(marks(&[fact("p", "2024-03"), fact("l", "2024-03")]), json!([{"key": "p"}, {"key": "x"}]));
        assert_eq!(marks(&[fact("p", "2022-01"), fact("l", "2024-03")]), json!([{"key": "p"}, {"key": "l"}, {"key": "x"}]));
    }

    /// An iso3's point is its Natural Earth label point (DEU, GRC); with three features filed under AUS it is Australia's own;
    /// a code with none is missing, once; the reply carries the embedded table, the vendored file's bytes.
    #[test]
    fn an_iso3_gets_its_natural_earth_label_point_and_one_without_is_missing() {
        let iso3: Vec<String> = ["DEU", "GRC", "AUS", "WLD", "XXX", "DEU", "WLD"].iter().map(|c| c.to_string()).collect();
        let Ok(Reply::Points { points, missing, table }) = call(Request::PlacePoints { iso3: &iso3 }) else {
            panic!("no points")
        };
        assert_eq!(points["DEU"], [9.678348, 50.961733]);
        assert_eq!(points["GRC"], [21.72568, 39.492763]);
        assert_eq!(points["AUS"], [134.04972, -24.129522]);
        assert_eq!(points.len(), 3);
        assert_eq!(missing, ["WLD", "XXX"]);
        let file = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("runtime/pi/assets/naturalearth-admin0-50m-attributes.json")).unwrap();
        assert_eq!(table.as_bytes(), &file[..]);
    }

    /// The ring's window knobs come from the registry with their ranges; a word knob or a missing one is no number.
    #[test]
    fn a_number_knob_is_read_from_the_registry_and_nothing_else_is() {
        let knob = |node, knob| match call(Request::Knob { node, knob }) {
            Ok(Reply::Knob { default, min, max }) => Ok((default, min, max)),
            Ok(_) => panic!("knob answered with another reply"),
            Err(e) => Err(e),
        };
        assert_eq!(knob("ring", "years"), Ok((5.0, 2.0, 10.0)));
        assert_eq!(knob("ring", "months"), Ok((60.0, 24.0, 120.0)));
        assert_eq!(knob("ring", "color"), Err("knob: ring.color is a word, not a number".to_string()));
        assert_eq!(knob("ring", "decades"), Err("knob: node ring has no knob decades".to_string()));
        assert_eq!(knob("rings", "years"), Err("knob: the leaf registry has no node rings".to_string()));
    }
}
