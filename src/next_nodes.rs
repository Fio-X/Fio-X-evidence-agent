//! New route, visual group: the node registry every page is built from, for any infographic. A node draws one kind of thing
//! on a frame and states the data shape it needs and its knobs, each with a default and a range. A group stacks nodes as
//! layers, bottom first, and exposes a few of their knobs under its own names; a group packed into a node is a node again,
//! so groups nest. A page is the outermost group (its recipe); no node, knob or rule here is tied to one page or chart kind.
//! `layered` draws a group's layers on one frame and one occupancy table, every reserve before any draw; `Occ`, `place` and
//! `tw` are the prototype renderer's, ported as they are (fixtures/next_nodes/prod-golden.json holds its own results). Pure.

use std::collections::BTreeMap;

/// What a knob takes: a number on a stepped range, or one word of a fixed list.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Range {
        default: f64,
        min: f64,
        max: f64,
        step: f64,
    },
    Pick {
        default: &'static str,
        options: &'static [&'static str],
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Knob {
    pub name: &'static str,
    pub kind: Kind,
}

/// A knob's value as set or read.
#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Num(f64),
    Word(String),
}

impl std::fmt::Display for Val {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Val::Num(x) => write!(f, "{x}"),
            Val::Word(w) => write!(f, "{w}"),
        }
    }
}

impl Knob {
    pub fn default_val(&self) -> Val {
        match self.kind {
            Kind::Range { default, .. } => Val::Num(default),
            Kind::Pick { default, .. } => Val::Word(default.to_string()),
        }
    }

    /// The range as the refusal and the listing print it.
    pub fn range_text(&self) -> String {
        match self.kind {
            Kind::Range { min, max, step, .. } => format!("{min}..{max} step {step}"),
            Kind::Pick { options, .. } => format!("one of {}", options.join("|")),
        }
    }

    /// The value when it lies in the knob's range; else the refusal, which names the range and one example (the default).
    pub fn check(&self, path: &str, v: &Val) -> Result<Val, String> {
        let ok = match (self.kind, v) {
            (Kind::Range { min, max, step, .. }, Val::Num(x)) => {
                let n = (x - min) / step;
                x.is_finite() && *x >= min && *x <= max && (n - n.round()).abs() < 1e-6
            }
            (Kind::Pick { options, .. }, Val::Word(w)) => options.contains(&w.as_str()),
            _ => false,
        };
        if ok {
            Ok(v.clone())
        } else {
            Err(format!(
                "{path}: {v} is not {}; e.g. {}",
                self.range_text(),
                self.default_val()
            ))
        }
    }
}

/// One node as the registry lists it: what it draws (its name), which data roles it needs, its knobs; a packed group has
/// `inner` set, and its knobs are the ones that group exposes (its own `knobs` stay empty).
#[derive(Debug)]
pub struct NodeInfo {
    pub name: &'static str,
    pub needs: &'static [&'static str],
    pub knobs: &'static [Knob],
    pub inner: Option<&'static GroupInfo>,
}

/// A knob of one layer that a group shows under its own name.
#[derive(Debug)]
pub struct Exposed {
    pub name: &'static str,
    pub layer: &'static str,
    pub knob: &'static str,
}

/// Layers bottom first, and the few knobs the group shows; every other knob of its layers keeps its default.
#[derive(Debug)]
pub struct GroupInfo {
    pub name: &'static str,
    pub layers: &'static [&'static NodeInfo],
    pub exposed: &'static [Exposed],
}

fn names<T>(xs: &[T], name: impl Fn(&T) -> &str) -> String {
    if xs.is_empty() {
        return "(none)".to_string();
    }
    xs.iter().map(name).collect::<Vec<_>>().join(", ")
}

/// Where a knob name set on `node` lands: its key below the node ("layer/.../knob") and the leaf knob it reaches. A knob a
/// group does not expose is refused with the names it does expose.
fn find(node: &NodeInfo, name: &str) -> Result<(String, &'static Knob), String> {
    let Some(g) = node.inner else {
        return node
            .knobs
            .iter()
            .find(|k| k.name == name)
            .map(|k| (k.name.to_string(), k))
            .ok_or_else(|| {
                format!(
                    "{} has no knob {name}; its knobs: {}",
                    node.name,
                    names(node.knobs, |k| k.name)
                )
            });
    };
    let e = g.exposed.iter().find(|e| e.name == name).ok_or_else(|| {
        format!(
            "{} does not expose {name}; exposed: {}",
            node.name,
            names(g.exposed, |e| e.name)
        )
    })?;
    let layer = g.layers.iter().find(|l| l.name == e.layer).ok_or_else(|| {
        format!(
            "{} exposes {name} from {}, which is not one of its layers",
            node.name, e.layer
        )
    })?;
    let (key, k) = find(layer, e.knob).map_err(|r| format!("{}.{name} -> {r}", node.name))?;
    Ok((format!("{}/{key}", layer.name), k))
}

/// The knob values set on one node, keyed below it; unset knobs read as their defaults.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Style {
    set: BTreeMap<String, Val>,
}

impl Style {
    /// Set one knob `node` shows (a leaf's own knob, or a name its group exposes), refused outside the knob's range.
    pub fn set(&mut self, node: &NodeInfo, knob: &str, v: Val) -> Result<(), String> {
        let (key, k) = find(node, knob)?;
        let v = k.check(&format!("{}.{knob}", node.name), &v)?;
        self.set.insert(key, v);
        Ok(())
    }

    /// The part of this style that lies below one layer, as that layer reads it.
    pub fn within(&self, layer: &str) -> Style {
        let pre = format!("{layer}/");
        Style {
            set: self
                .set
                .iter()
                .filter_map(|(k, v)| k.strip_prefix(&pre).map(|k| (k.to_string(), v.clone())))
                .collect(),
        }
    }

    pub fn get(&self, k: &Knob) -> Val {
        self.set
            .get(k.name)
            .cloned()
            .unwrap_or_else(|| k.default_val())
    }

    /// A range knob's value (a pick knob reads as NaN).
    pub fn num(&self, k: &Knob) -> f64 {
        match self.get(k) {
            Val::Num(x) => x,
            Val::Word(_) => f64::NAN,
        }
    }

    /// A pick knob's word (a range knob reads as its number written out).
    pub fn word(&self, k: &Knob) -> String {
        self.get(k).to_string()
    }
}

/// One knob in the listing: its full path below the listed node, the knob with its default and range, and the name the
/// listed node exposes it under (None: it keeps its default unless the recipe opens it).
#[derive(Debug, Clone, PartialEq)]
pub struct Listed {
    pub path: String,
    pub knob: &'static Knob,
    pub exposed_as: Option<&'static str>,
}

fn walk(node: &NodeInfo, pre: &str, out: &mut Vec<Listed>) {
    match node.inner {
        None => out.extend(node.knobs.iter().map(|k| Listed {
            path: format!("{pre}{}", k.name),
            knob: k,
            exposed_as: None,
        })),
        Some(g) => {
            for l in g.layers {
                walk(l, &format!("{pre}{}/", l.name), out);
            }
        }
    }
}

/// Every knob below `node`, layer by layer bottom first, at any depth, with its default and range; the ones `node` exposes
/// carry their exposed name. The same for any recipe: the branch search over recipe variants reads only this.
pub fn list(node: &NodeInfo) -> Vec<Listed> {
    let mut out = vec![];
    walk(node, "", &mut out);
    if let Some(g) = node.inner {
        for e in g.exposed {
            if let Ok((key, _)) = find(node, e.name) {
                if let Some(l) = out.iter_mut().find(|l| l.path == key) {
                    l.exposed_as = Some(e.name);
                }
            }
        }
    }
    out
}

/// What is wrong with a node's registration, at any depth: a default outside its range, a bad range, a repeated name, a
/// packed node with knobs of its own, an exposed name that reaches no knob. Empty when the registration is sound.
pub fn check_info(node: &NodeInfo) -> Vec<String> {
    let mut bad = vec![];
    let mut seen = vec![];
    for k in node.knobs {
        if seen.contains(&k.name) {
            bad.push(format!("{}: knob {} twice", node.name, k.name));
        }
        seen.push(k.name);
        match k.kind {
            Kind::Range { min, max, step, .. } if step.is_nan() || step <= 0.0 || min > max => bad
                .push(format!(
                    "{}.{}: bad range {}",
                    node.name,
                    k.name,
                    k.range_text()
                )),
            Kind::Pick { options: [], .. } => {
                bad.push(format!("{}.{}: no options", node.name, k.name))
            }
            _ => {
                if let Err(r) = k.check(&format!("{}.{}", node.name, k.name), &k.default_val()) {
                    bad.push(format!("default {r}"));
                }
            }
        }
    }
    let Some(g) = node.inner else { return bad };
    if !node.knobs.is_empty() {
        bad.push(format!(
            "{}: a packed node shows only what its group exposes",
            node.name
        ));
    }
    let mut layers = vec![];
    for l in g.layers {
        if layers.contains(&l.name) {
            bad.push(format!("{}: layer {} twice", g.name, l.name));
        }
        layers.push(l.name);
        bad.extend(check_info(l));
    }
    let mut shown = vec![];
    for e in g.exposed {
        if shown.contains(&e.name) {
            bad.push(format!("{}: exposes {} twice", g.name, e.name));
        }
        shown.push(e.name);
        if let Err(r) = find(node, e.name) {
            bad.push(r);
        }
    }
    bad
}

/// Claims room on the occupancy table before any layer draws (lines, terminals, names that must not move).
pub type Reserve<F> = fn(&F, &mut Occ, &Style);
/// Draws the layer's SVG, placing what it places against the table and adding it there.
pub type Draw<F> = fn(&F, &mut Occ, &Style) -> String;

/// A node with its code, generic over the frame its group draws on. A packed node's draw lays out its own group (often on a
/// frame of its own) and returns that group's drawing.
pub struct NodeDef<F> {
    pub info: &'static NodeInfo,
    pub reserve: Option<Reserve<F>>,
    pub draw: Draw<F>,
}

/// Each layer's own drawing, by layer name, bottom first.
pub type Layers = Vec<(&'static str, String)>;

/// Draw `group`'s layers on one frame and one occupancy table: every reserve first, then the draws, bottom first. Returns
/// each layer's own drawing (so a layer can be saved, compared and checked alone) and the table. Each layer reads the part
/// of `style` below its name; a layer with no code in `defs` is refused.
pub fn layered<F>(
    frame: &F,
    group: &GroupInfo,
    defs: &[&NodeDef<F>],
    style: &Style,
) -> Result<(Layers, Occ), String> {
    let order = group
        .layers
        .iter()
        .map(|l| {
            defs.iter()
                .find(|d| d.info.name == l.name)
                .copied()
                .ok_or_else(|| format!("{}: layer {} has no code", group.name, l.name))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut occ = Occ::default();
    for d in &order {
        if let Some(r) = d.reserve {
            r(frame, &mut occ, &style.within(d.info.name));
        }
    }
    let out = order
        .iter()
        .map(|d| {
            (
                d.info.name,
                (d.draw)(frame, &mut occ, &style.within(d.info.name)),
            )
        })
        .collect();
    Ok((out, occ))
}

/// A box: x0, y0, x1, y1.
pub type Bx = [f64; 4];

/// A point sampled along a line, with its layer and whose line it is.
#[derive(Debug, Clone, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
    pub layer: &'static str,
    pub tag: Option<String>,
}

/// A text box turned about its centre by `deg`, tested itself rather than by its bounds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Turned {
    pub cx: f64,
    pub cy: f64,
    pub w: f64,
    pub h: f64,
    pub deg: f64,
}

/// Occupancy table shared by the layers of one picture: boxes (labels) and points sampled along lines, each with its layer.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Occ {
    pub boxes: Vec<(Bx, &'static str)>,
    pub pts: Vec<Pt>,
}

impl Occ {
    pub fn add(&mut self, b: Bx, layer: &'static str) {
        self.boxes.push((b, layer));
    }

    pub fn add_line(&mut self, pts: &[(f64, f64)], layer: &'static str, tag: Option<&str>) {
        self.pts.extend(pts.iter().map(|&(x, y)| Pt {
            x,
            y,
            layer,
            tag: tag.map(str::to_string),
        }));
    }

    /// A box (of the layers in `only`, all when None, never those in `but`) overlaps `b` grown by `pad`.
    pub fn hit(&self, b: Bx, pad: (f64, f64), only: Option<&[&str]>, but: &[&str]) -> bool {
        let (px, py) = pad;
        self.boxes.iter().any(|(q, l)| {
            only.is_none_or(|o| o.contains(l))
                && !but.contains(l)
                && b[0] < q[2] + px
                && b[2] > q[0] - px
                && b[1] < q[3] + py
                && b[3] > q[1] - py
        })
    }

    /// A line point (of the layers in `only`, not of the line tagged `own`) inside `b` grown by `pad`, or inside the turned
    /// box when `rot` is given.
    pub fn on_line(
        &self,
        b: Bx,
        pad: f64,
        only: Option<&[&str]>,
        rot: Option<Turned>,
        own: Option<&str>,
    ) -> bool {
        let mine = |p: &&Pt| {
            only.is_none_or(|o| o.contains(&p.layer))
                && own.is_none_or(|w| p.tag.as_deref() != Some(w))
        };
        if let Some(t) = rot {
            let (ca, sa) = (t.deg.to_radians().cos(), t.deg.to_radians().sin());
            return self.pts.iter().filter(mine).any(|p| {
                ((p.x - t.cx) * ca + (p.y - t.cy) * sa).abs() < t.w / 2.0 + pad
                    && (-(p.x - t.cx) * sa + (p.y - t.cy) * ca).abs() < t.h / 2.0 + pad
            });
        }
        self.pts
            .iter()
            .filter(mine)
            .any(|p| b[0] - pad < p.x && p.x < b[2] + pad && b[1] - pad < p.y && p.y < b[3] + pad)
    }
}

/// The side of a point a label goes on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    R,
    L,
    U,
    D,
    UL,
    UR,
    DL,
    DR,
}

/// How `place` looks: the sides in the order tried, the layers whose boxes a label may cover, and the label's own line.
#[derive(Debug, Clone, Copy)]
pub struct Look<'a> {
    pub order: &'a [Side],
    pub but: &'a [&'a str],
    pub own: Option<&'a str>,
}

impl Default for Look<'_> {
    fn default() -> Self {
        Look {
            order: &[Side::R, Side::L, Side::U, Side::D],
            but: &[],
            own: None,
        }
    }
}

/// A free box for a w×h label beside the point `at`: tries the sides in order; free = `inside` (can be seen), touches no box
/// (except layers in `but`) and no line (except its own). None when no side is free.
pub fn place(
    inside: impl Fn(&Bx) -> bool,
    occ: &Occ,
    at: (f64, f64),
    size: (f64, f64),
    gap: f64,
    look: Look<'_>,
) -> Option<(Bx, Side)> {
    let ((x, y), (w, h)) = (at, size);
    look.order.iter().find_map(|&sd| {
        let b = match sd {
            Side::R => [x + gap, y - h / 2.0, x + gap + w, y + h / 2.0],
            Side::L => [x - gap - w, y - h / 2.0, x - gap, y + h / 2.0],
            Side::U => [x - w / 2.0, y - gap - h, x + w / 2.0, y - gap],
            Side::D => [x - w / 2.0, y + gap, x + w / 2.0, y + gap + h],
            Side::UL => [x - gap - w, y - gap - h, x - gap, y - gap],
            Side::UR => [x + gap, y - gap - h, x + gap + w, y - gap],
            Side::DL => [x - gap - w, y + gap, x - gap, y + gap + h],
            Side::DR => [x + gap, y + gap, x + gap + w, y + gap + h],
        };
        (inside(&b)
            && !occ.hit(b, (2.0, 1.0), None, look.but)
            && !occ.on_line(b, 1.0, None, None, look.own))
        .then_some((b, sd))
    })
}

/// Rough text width: CJK full, Latin about half.
pub fn tw(s: &str, size: f64) -> f64 {
    s.chars()
        .map(|c| if c as u32 > 0x2e7f { size } else { 0.58 * size })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::cell::RefCell;

    const GOLDEN: &str = include_str!("../fixtures/next_nodes/prod-golden.json");

    fn bx(v: &Value) -> Bx {
        let a: Vec<f64> = v
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_f64().unwrap())
            .collect();
        [a[0], a[1], a[2], a[3]]
    }
    fn strs(v: &Value) -> Vec<&str> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect()
    }
    fn side(s: &str) -> Side {
        match s {
            "R" => Side::R,
            "L" => Side::L,
            "U" => Side::U,
            "D" => Side::D,
            "UL" => Side::UL,
            "UR" => Side::UR,
            "DL" => Side::DL,
            "DR" => Side::DR,
            _ => panic!("side {s}"),
        }
    }
    // The prototype's layer names are free strings; the Rust table keeps 'static ones.
    fn layer(s: &str) -> &'static str {
        Box::leak(s.to_string().into_boxed_str())
    }

    fn golden() -> (Value, Occ) {
        let g: Value = serde_json::from_str(GOLDEN).unwrap();
        let mut occ = Occ::default();
        for b in g["occ"]["boxes"].as_array().unwrap() {
            occ.add(bx(&b[0]), layer(b[1].as_str().unwrap()));
        }
        for l in g["occ"]["lines"].as_array().unwrap() {
            let pts: Vec<(f64, f64)> = l[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| (p[0].as_f64().unwrap(), p[1].as_f64().unwrap()))
                .collect();
            occ.add_line(&pts, layer(l[1].as_str().unwrap()), l[2].as_str());
        }
        (g, occ)
    }

    #[test]
    fn tw_matches_the_prototype() {
        let (g, _) = golden();
        let cases = g["tw"].as_array().unwrap();
        assert_eq!(cases.len(), 8);
        for c in cases {
            let (s, z, want) = (
                c[0].as_str().unwrap(),
                c[1].as_f64().unwrap(),
                c[2].as_f64().unwrap(),
            );
            assert!(
                (tw(s, z) - want).abs() < 1e-9,
                "tw({s:?}, {z}) = {}, prototype {want}",
                tw(s, z)
            );
        }
    }

    #[test]
    fn occ_hit_and_on_line_match_the_prototype() {
        let (g, occ) = golden();
        let hits = g["hit"].as_array().unwrap();
        assert_eq!(hits.len(), 8);
        for c in hits {
            let only = c[2].as_array().map(|_| strs(&c[2]));
            let got = occ.hit(
                bx(&c[0]),
                (c[1][0].as_f64().unwrap(), c[1][1].as_f64().unwrap()),
                only.as_deref(),
                &strs(&c[3]),
            );
            assert_eq!(got, c[4].as_bool().unwrap(), "hit {c}");
        }
        let lines = g["on_line"].as_array().unwrap();
        assert_eq!(lines.len(), 10);
        for c in lines {
            let only = c[2].as_array().map(|_| strs(&c[2]));
            let rot = c[3].as_array().map(|r| {
                let r: Vec<f64> = r.iter().map(|x| x.as_f64().unwrap()).collect();
                Turned {
                    cx: r[0],
                    cy: r[1],
                    w: r[2],
                    h: r[3],
                    deg: r[4],
                }
            });
            let got = occ.on_line(
                bx(&c[0]),
                c[1].as_f64().unwrap(),
                only.as_deref(),
                rot,
                c[4].as_str(),
            );
            assert_eq!(got, c[5].as_bool().unwrap(), "on_line {c}");
        }
    }

    #[test]
    fn place_matches_the_prototype() {
        let (g, occ) = golden();
        // The prototype frame's inside(): a 400x300 rectangle, margin 4.
        let inside = |b: &Bx| !(b[0] < 4.0 || b[1] < 4.0 || b[2] > 396.0 || b[3] > 296.0);
        let cases = g["place"].as_array().unwrap();
        assert_eq!(cases.len(), 11);
        for c in cases {
            let f = |i: usize| c[i].as_f64().unwrap();
            let order: Vec<Side> = strs(&c[5]).into_iter().map(side).collect();
            let but = strs(&c[6]);
            let look = Look {
                order: &order,
                but: &but,
                own: c[7].as_str(),
            };
            let got = place(inside, &occ, (f(0), f(1)), (f(2), f(3)), f(4), look);
            let want = c[8]
                .as_array()
                .map(|_| (bx(&c[8]), side(c[9].as_str().unwrap())));
            assert_eq!(got, want, "place {c}");
        }
    }

    #[test]
    fn look_defaults_to_the_prototype_order() {
        assert_eq!(Look::default().order, &[Side::R, Side::L, Side::U, Side::D]);
    }

    // A small registry with no page or topic in it: two leaf layers packed into one node, then a page group around it.
    const WIDTH: Knob = Knob {
        name: "width",
        kind: Kind::Range {
            default: 2.0,
            min: 0.5,
            max: 6.0,
            step: 0.1,
        },
    };
    const SLANT: Knob = Knob {
        name: "slant",
        kind: Kind::Pick {
            default: "yes",
            options: &["yes", "no"],
        },
    };
    const SIZE: Knob = Knob {
        name: "size",
        kind: Kind::Range {
            default: 10.0,
            min: 7.0,
            max: 16.0,
            step: 0.5,
        },
    };
    static LINES: NodeInfo = NodeInfo {
        name: "lines",
        needs: &["from", "to", "value"],
        knobs: &[WIDTH, SLANT],
        inner: None,
    };
    static LABELS: NodeInfo = NodeInfo {
        name: "labels",
        needs: &["name"],
        knobs: &[SIZE],
        inner: None,
    };
    static KEY: NodeInfo = NodeInfo {
        name: "key",
        needs: &["series"],
        knobs: &[SIZE],
        inner: None,
    };
    static MAP_GROUP: GroupInfo = GroupInfo {
        name: "map",
        layers: &[&LINES, &LABELS],
        exposed: &[Exposed {
            name: "line",
            layer: "lines",
            knob: "width",
        }],
    };
    static MAP: NodeInfo = NodeInfo {
        name: "map",
        needs: &[],
        knobs: &[],
        inner: Some(&MAP_GROUP),
    };
    static PAGE_GROUP: GroupInfo = GroupInfo {
        name: "page",
        layers: &[&MAP, &KEY],
        exposed: &[
            Exposed {
                name: "map_line",
                layer: "map",
                knob: "line",
            },
            Exposed {
                name: "key_size",
                layer: "key",
                knob: "size",
            },
        ],
    };
    static PAGE: NodeInfo = NodeInfo {
        name: "page",
        needs: &[],
        knobs: &[],
        inner: Some(&PAGE_GROUP),
    };

    #[test]
    fn a_knob_outside_its_range_is_refused_with_the_range_and_one_example() {
        let mut st = Style::default();
        let r = st.set(&LINES, "width", Val::Num(9.0)).unwrap_err();
        assert_eq!(r, "lines.width: 9 is not 0.5..6 step 0.1; e.g. 2");
        let r = st.set(&LINES, "width", Val::Num(2.05)).unwrap_err();
        assert!(r.contains("0.5..6 step 0.1; e.g. 2"), "{r}");
        let r = st
            .set(&LINES, "slant", Val::Word("maybe".into()))
            .unwrap_err();
        assert_eq!(r, "lines.slant: maybe is not one of yes|no; e.g. yes");
        let r = st
            .set(&LINES, "width", Val::Word("wide".into()))
            .unwrap_err();
        assert!(r.ends_with("e.g. 2"), "{r}");
        let r = st.set(&LINES, "colour", Val::Num(1.0)).unwrap_err();
        assert_eq!(r, "lines has no knob colour; its knobs: width, slant");
        assert_eq!(st, Style::default(), "nothing refused is kept");
        st.set(&LINES, "width", Val::Num(3.7)).unwrap();
        st.set(&LINES, "slant", Val::Word("no".into())).unwrap();
        assert_eq!((st.num(&WIDTH), st.word(&SLANT)), (3.7, "no".to_string()));
    }

    #[test]
    fn a_group_takes_only_what_it_exposes_and_routes_it_down_the_nesting() {
        let mut st = Style::default();
        let r = st.set(&PAGE, "slant", Val::Word("no".into())).unwrap_err();
        assert_eq!(r, "page does not expose slant; exposed: map_line, key_size");
        let r = st.set(&PAGE, "map_line", Val::Num(9.0)).unwrap_err();
        assert_eq!(r, "page.map_line: 9 is not 0.5..6 step 0.1; e.g. 2");
        st.set(&PAGE, "map_line", Val::Num(3.0)).unwrap();
        st.set(&PAGE, "key_size", Val::Num(12.5)).unwrap();
        assert_eq!(st.within("map").within("lines").num(&WIDTH), 3.0);
        assert_eq!(st.within("key").num(&SIZE), 12.5);
        // the labels layer shares the knob name size with the key, but the page did not open it: it keeps its default
        assert_eq!(st.within("map").within("labels").num(&SIZE), 10.0);
        assert_eq!(st.within("map").within("lines").word(&SLANT), "yes");
    }

    #[test]
    fn list_enumerates_every_knob_at_any_depth_with_its_range() {
        let got: Vec<(String, String, String, Option<&str>)> = list(&PAGE)
            .into_iter()
            .map(|l| {
                (
                    l.path,
                    l.knob.default_val().to_string(),
                    l.knob.range_text(),
                    l.exposed_as,
                )
            })
            .collect();
        let want = [
            ("map/lines/width", "2", "0.5..6 step 0.1", Some("map_line")),
            ("map/lines/slant", "yes", "one of yes|no", None),
            ("map/labels/size", "10", "7..16 step 0.5", None),
            ("key/size", "10", "7..16 step 0.5", Some("key_size")),
        ];
        assert_eq!(got.len(), want.len());
        for (g, w) in got.iter().zip(want) {
            assert_eq!((g.0.as_str(), g.1.as_str(), g.2.as_str(), g.3), w);
        }
        // a packed node lists the same way when listed alone, with its own exposed name
        let inner: Vec<_> = list(&MAP)
            .into_iter()
            .map(|l| (l.path, l.exposed_as))
            .collect();
        assert_eq!(inner[0], ("lines/width".to_string(), Some("line")));
        assert_eq!(list(&LINES).len(), 2);
    }

    #[test]
    fn check_info_passes_a_sound_registry_and_names_each_fault() {
        assert!(check_info(&PAGE).is_empty(), "{:?}", check_info(&PAGE));
        const OFF: Knob = Knob {
            name: "size",
            kind: Kind::Range {
                default: 30.0,
                min: 7.0,
                max: 16.0,
                step: 0.5,
            },
        };
        static BAD_LEAF: NodeInfo = NodeInfo {
            name: "dots",
            needs: &[],
            knobs: &[OFF, OFF],
            inner: None,
        };
        static BAD_GROUP: GroupInfo = GroupInfo {
            name: "bad",
            layers: &[&BAD_LEAF, &KEY, &KEY],
            exposed: &[Exposed {
                name: "w",
                layer: "nowhere",
                knob: "size",
            }],
        };
        static BAD: NodeInfo = NodeInfo {
            name: "bad",
            needs: &[],
            knobs: &[SIZE],
            inner: Some(&BAD_GROUP),
        };
        let bad = check_info(&BAD);
        for want in [
            "dots: knob size twice",
            "default dots.size: 30 is not 7..16 step 0.5; e.g. 30",
            "bad: a packed node shows only what its group exposes",
            "bad: layer key twice",
            "bad exposes w from nowhere, which is not one of its layers",
        ] {
            assert!(bad.iter().any(|b| b == want), "missing {want:?} in {bad:?}");
        }
    }

    // A frame that records what ran, in order.
    struct Log(RefCell<Vec<String>>);
    impl Log {
        fn note(&self, s: String) {
            self.0.borrow_mut().push(s);
        }
    }
    fn reserve_lines(f: &Log, occ: &mut Occ, _: &Style) {
        f.note("reserve lines".into());
        occ.add_line(&[(10.0, 10.0), (20.0, 10.0)], "lines", None);
    }
    fn draw_lines(f: &Log, occ: &mut Occ, st: &Style) -> String {
        f.note(format!(
            "draw lines (labels already drawn: {})",
            occ.boxes.len()
        ));
        format!("<path stroke-width=\"{}\"/>", st.num(&WIDTH))
    }
    fn draw_labels(f: &Log, occ: &mut Occ, _: &Style) -> String {
        // the reserved line is on the table before this draw, though the lines layer draws below it
        f.note(format!("draw labels (line points seen: {})", occ.pts.len()));
        occ.add([0.0, 0.0, 5.0, 5.0], "labels");
        "<text/>".into()
    }
    fn reserve_key(f: &Log, _: &mut Occ, _: &Style) {
        f.note("reserve key".into());
    }
    fn draw_key(f: &Log, _: &mut Occ, st: &Style) -> String {
        f.note("draw key".into());
        format!("<g font-size=\"{}\"/>", st.num(&SIZE))
    }
    fn draw_map(f: &Log, _: &mut Occ, st: &Style) -> String {
        f.note("draw map".into());
        // a packed node lays out its own group, on its own table
        let (parts, _) = layered(f, &MAP_GROUP, &[&LINES_DEF, &LABELS_DEF], st).unwrap();
        parts.into_iter().map(|(_, s)| s).collect()
    }
    static LINES_DEF: NodeDef<Log> = NodeDef {
        info: &LINES,
        reserve: Some(reserve_lines),
        draw: draw_lines,
    };
    static LABELS_DEF: NodeDef<Log> = NodeDef {
        info: &LABELS,
        reserve: None,
        draw: draw_labels,
    };
    static KEY_DEF: NodeDef<Log> = NodeDef {
        info: &KEY,
        reserve: Some(reserve_key),
        draw: draw_key,
    };
    static MAP_DEF: NodeDef<Log> = NodeDef {
        info: &MAP,
        reserve: None,
        draw: draw_map,
    };

    #[test]
    fn layered_reserves_everything_before_any_draw_and_nests() {
        let f = Log(RefCell::new(vec![]));
        let mut st = Style::default();
        st.set(&PAGE, "map_line", Val::Num(3.5)).unwrap();
        let (parts, occ) = layered(&f, &PAGE_GROUP, &[&KEY_DEF, &MAP_DEF], &st).unwrap();
        assert_eq!(
            parts,
            vec![
                ("map", "<path stroke-width=\"3.5\"/><text/>".to_string()),
                ("key", "<g font-size=\"10\"/>".to_string())
            ],
            "bottom first, in the group's order, not the order of defs"
        );
        assert_eq!(
            f.0.into_inner(),
            [
                "reserve key",
                "draw map",
                "reserve lines",
                "draw lines (labels already drawn: 0)",
                "draw labels (line points seen: 2)",
                "draw key"
            ]
        );
        assert_eq!(
            occ,
            Occ::default(),
            "the inner group's table stays inside the packed node"
        );
    }

    #[test]
    fn layered_refuses_a_layer_with_no_code() {
        let f = Log(RefCell::new(vec![]));
        let r = layered(&f, &PAGE_GROUP, &[&MAP_DEF], &Style::default()).unwrap_err();
        assert_eq!(r, "page: layer key has no code");
        assert!(
            f.0.into_inner().is_empty(),
            "nothing runs before every layer has code"
        );
    }
}
