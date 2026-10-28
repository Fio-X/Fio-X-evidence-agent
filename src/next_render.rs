//! New route, visual group: what the flow hands the page renderer. A `PageSpec` names every piece of the page as words, numbers
//! from the data (`Num`, with where each was read) and names from the data (`Label`, when a name holds digits); the renderer's
//! nodes draw it and print every number through next_ledger, and the visual command checks the page against its ledger. The
//! flow builds a spec from these types only (shared vocabulary): it never prints a number or checks a page itself.

use std::cell::RefCell;

use crate::next_ledger::{esc, Ledger};
use crate::next_nodes::{
    layered, tw, Exposed, GroupInfo, Kind, Knob, Layer, NodeDef, NodeInfo, Occ, Style,
};

// The ledger's number and name kinds, named here as the spec's own (rule one: a type or constant is shared vocabulary).
pub type Label = crate::next_ledger::Label;
pub type Num = crate::next_ledger::Num;
pub type Seg = crate::next_ledger::Seg;
pub const LABEL_SRC: &str = crate::next_ledger::LABEL_SRC;

/// One bar: its row key (a code), the name it shows, and its value.
#[derive(Clone, Debug, PartialEq)]
pub struct BarRow {
    pub key: String,
    pub label: Seg,
    pub value: Num,
    /// The number of a claim made about this row (rank_top, rank_bottom): its value label prints it, the series value stays
    /// the bar's length and its line in the description.
    pub claim: Option<Num>,
}

/// A ranking card: every row as a bar, the lead row in the accent, a bracket from the top bar to the bottom bar carrying its
/// lines (the gap and ratio claims).
#[derive(Clone, Debug, PartialEq)]
pub struct BarCard {
    pub id: String,
    /// How the program chose the card's places (its chart's Scope), above its title; empty for a chart of every place.
    pub eyebrow: Vec<Seg>,
    pub title: String,
    pub subtitle: Vec<Seg>,
    pub rows: Vec<BarRow>,
    /// The key of the row drawn in the accent.
    pub lead: Option<String>,
    pub bracket: Vec<Vec<Seg>>,
    /// The unit after a value, as the pack checked it (next_pack unit_text): words, or a name read from its row when it
    /// holds a digit.
    pub unit: Seg,
    pub source: Vec<Seg>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Card {
    Bar(BarCard),
}

/// The page's one big number, with its unit and what it is.
#[derive(Clone, Debug, PartialEq)]
pub struct Hero {
    pub value: Num,
    pub unit: Seg,
    pub label: Vec<Seg>,
}

/// A whole page. No digit outside a `Num` or a `Label`: a year is a `Num` read from a data row like any value.
#[derive(Clone, Debug, PartialEq)]
pub struct PageSpec {
    /// `#rrggbb`: the page's one saturated colour.
    pub accent: String,
    /// Above the title: the lead chart's Scope when the program narrowed its places (next_pack put_scopes), else the
    /// measure's name.
    pub kicker: Vec<Seg>,
    pub title: String,
    pub dek: String,
    pub hero: Option<Hero>,
    pub body: Vec<Vec<Seg>>,
    pub cards: Vec<Card>,
    /// The table ids the page names (its source lines).
    pub refs: Vec<String>,
}

impl PageSpec {
    /// Every number the spec prints, with where it was read, in page order (a source read twice appears twice).
    pub fn nums(&self) -> Vec<&Num> {
        fn of(segs: &[Seg]) -> impl Iterator<Item = &Num> {
            segs.iter().filter_map(|s| match s {
                Seg::Num(n) => Some(n),
                _ => None,
            })
        }
        let mut out: Vec<&Num> = of(&self.kicker).collect();
        if let Some(hero) = &self.hero {
            out.push(&hero.value);
            out.extend(of(&hero.label));
        }
        for segs in &self.body {
            out.extend(of(segs));
        }
        for Card::Bar(card) in &self.cards {
            out.extend(of(&card.eyebrow));
            out.extend(of(&card.subtitle));
            out.extend(
                card.rows
                    .iter()
                    .flat_map(|r| std::iter::once(&r.value).chain(&r.claim)),
            );
            for line in &card.bracket {
                out.extend(of(line));
            }
            out.extend(of(&card.source));
        }
        out
    }
}

// ---- the bar card's nodes (next_nodes registry): bars, their value labels, and the group that stacks them ----

/// The card's drawing is a fixed 640 px viewBox the page scales by CSS, so the occupancy table works in px.
pub const CARD_W: f64 = 640.0;
// Names end at LABEL_END, bars run from X0 for at most SPAN; a value label stands VALUE_DX past its bar's end.
const LABEL_END: f64 = 134.0;
const X0: f64 = 148.0;
const SPAN: f64 = 332.0;
const PAD: f64 = 8.0;
const TEXT_SIZE: f64 = 12.0;
const VALUE_DX: f64 = 6.0;

const SORT: Knob = Knob {
    name: "sort",
    kind: Kind::Pick {
        default: "desc",
        options: &["desc", "asc", "data"],
    },
};
const BAR_H: Knob = Knob {
    name: "bar_h",
    kind: Kind::Range {
        default: 14.0,
        min: 6.0,
        max: 28.0,
        step: 1.0,
    },
};
const GAP: Knob = Knob {
    name: "gap",
    kind: Kind::Range {
        default: 10.0,
        min: 2.0,
        max: 24.0,
        step: 1.0,
    },
};
const UNIT: Knob = Knob {
    name: "unit",
    kind: Kind::Pick {
        default: "first",
        options: &["first", "all", "off"],
    },
};

/// One bar per row from a common baseline, its name to its left.
pub static BARS: NodeInfo = NodeInfo {
    name: "bars",
    needs: &["label", "value"],
    knobs: &[SORT, BAR_H, GAP],
    inner: None,
};

/// The number at each bar's end: the row's claim number when a claim is made about the row, else its value; the unit after
/// the first value, after each, or nowhere.
pub static VALUE_LABELS: NodeInfo = NodeInfo {
    name: "value_labels",
    needs: &["value"],
    knobs: &[UNIT],
    inner: None,
};

static BAR_CARD_GROUP: GroupInfo = GroupInfo {
    name: "bar_card",
    layers: &[
        Layer {
            name: "bars",
            node: &BARS,
        },
        Layer {
            name: "value_labels",
            node: &VALUE_LABELS,
        },
    ],
    exposed: &[
        Exposed {
            name: "sort",
            layer: "bars",
            knob: "sort",
        },
        Exposed {
            name: "unit",
            layer: "value_labels",
            knob: "unit",
        },
    ],
};

/// A ranking card: its bars and value labels as layers, under its title, with a description that reads every row's value
/// and its source line.
pub static BAR_CARD: NodeInfo = NodeInfo {
    name: "bar_card",
    needs: &["label", "value"],
    knobs: &[],
    inner: Some(&BAR_CARD_GROUP),
};

/// What a bar card's layers draw on: the card, its rows in the drawn order, the scale and row geometry, and the page's
/// ledger, which every number and name with digits goes through.
pub struct CardFrame<'a> {
    card: &'a BarCard,
    rows: Vec<&'a BarRow>,
    max: f64,
    bar_h: f64,
    row: f64,
    ledger: &'a RefCell<Ledger>,
}

impl<'a> CardFrame<'a> {
    /// The frame for `card` as its bars layer's knobs set it (`bars` reads the part of `style` below "bars"); Err unless
    /// there is a row and every value is a finite number at or above zero, one above.
    fn new(card: &'a BarCard, ledger: &'a RefCell<Ledger>, bars: &Style) -> Result<Self, String> {
        let mut rows: Vec<&BarRow> = card.rows.iter().collect();
        let max = rows.iter().map(|r| r.value.value).fold(0f64, f64::max);
        if rows.is_empty()
            || max <= 0.0
            || rows
                .iter()
                .any(|r| !r.value.value.is_finite() || r.value.value < 0.0)
        {
            return Err(format!(
                "{}: a bar card needs rows of values at or above zero, one above",
                card.id
            ));
        }
        let by = |a: &&BarRow, b: &&BarRow| a.value.value.total_cmp(&b.value.value);
        match bars.word(&SORT).as_str() {
            "desc" => rows.sort_by(|a, b| by(b, a)),
            "asc" => rows.sort_by(by),
            _ => {}
        }
        let (bar_h, gap) = (bars.num(&BAR_H), bars.num(&GAP));
        Ok(CardFrame {
            card,
            rows,
            max,
            bar_h,
            row: bar_h + gap,
            ledger,
        })
    }

    fn x(&self, v: f64) -> f64 {
        X0 + SPAN * v / self.max
    }

    fn mid(&self, i: usize) -> f64 {
        PAD + self.row * i as f64 + self.row / 2.0
    }

    fn height(&self) -> f64 {
        PAD + self.row * self.rows.len() as f64 + PAD
    }

    fn seg(&self, tag: &str, seg: &Seg) -> String {
        self.ledger
            .borrow_mut()
            .segs(tag, std::slice::from_ref(seg))
    }
}

/// The text a piece prints (a table id as its id).
fn seg_text(seg: &Seg) -> &str {
    match seg {
        Seg::Text(t) | Seg::Ref(t) => t,
        Seg::Num(n) => &n.text,
        Seg::Label(l) => &l.text,
    }
}

fn reserve_bars(f: &CardFrame, occ: &mut Occ, l: &Layer, _: &Style) {
    for (i, row) in f.rows.iter().enumerate() {
        let (mid, h) = (f.mid(i), f.bar_h / 2.0);
        occ.add([X0, mid - h, f.x(row.value.value), mid + h], l.name);
        let w = tw(seg_text(&row.label), TEXT_SIZE);
        occ.add([LABEL_END - w, mid - h, LABEL_END, mid + h], l.name);
    }
}

fn draw_bars(f: &CardFrame, _: &mut Occ, _: &Layer, _: &Style) -> String {
    f.rows
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let mid = f.mid(i);
            format!(
                "<text class=\"lab\" x=\"{LABEL_END}\" y=\"{mid:.1}\" dy=\"0.35em\" text-anchor=\"end\">{}</text>\
                 <rect class=\"bar\" x=\"{X0}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{}\"/>",
                f.seg("tspan", &row.label),
                mid - f.bar_h / 2.0,
                f.x(row.value.value) - X0,
                f.bar_h,
            )
        })
        .collect()
}

fn draw_value_labels(f: &CardFrame, occ: &mut Occ, l: &Layer, st: &Style) -> String {
    let unit = st.word(&UNIT);
    f.rows
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let n = row.claim.as_ref().unwrap_or(&row.value);
            let with_unit = unit == "all" || (unit == "first" && i == 0);
            let (x, mid) = (f.x(row.value.value) + VALUE_DX, f.mid(i));
            let mut text = n.text.clone();
            if with_unit {
                text.push_str(seg_text(&f.card.unit));
            }
            let h = TEXT_SIZE / 2.0;
            occ.add([x, mid - h, x + tw(&text, TEXT_SIZE), mid + h], l.name);
            let num = f.ledger.borrow_mut().num("tspan", "v", n);
            let after = if with_unit {
                f.seg("tspan", &f.card.unit)
            } else {
                String::new()
            };
            format!(
                "<text class=\"val\" x=\"{x:.1}\" y=\"{mid:.1}\" dy=\"0.35em\">{num}{after}</text>"
            )
        })
        .collect()
}

/// The bar card drawn by its group's layers, with `style` set on `BAR_CARD`: the figure with its eyebrow, title and
/// subtitle, the chart, a description that reads every row's name and value with the unit, and its source line. Every
/// number goes through `ledger`; Err when the rows cannot be drawn.
pub fn bar_card(card: &BarCard, ledger: &RefCell<Ledger>, style: &Style) -> Result<String, String> {
    let f = CardFrame::new(card, ledger, &style.within("bars"))?;
    let bars = NodeDef {
        info: &BARS,
        reserve: Some(reserve_bars),
        draw: draw_bars,
    };
    let values = NodeDef {
        info: &VALUE_LABELS,
        reserve: None,
        draw: draw_value_labels,
    };
    let (layers, _) = layered(&f, &BAR_CARD_GROUP, &[&bars, &values], style)?;
    let svg: String = layers.into_iter().map(|(_, s)| s).collect();
    let mut l = ledger.borrow_mut();
    let desc: Vec<String> = f
        .rows
        .iter()
        .map(|r| {
            format!(
                "{} {}{}",
                l.segs("span", std::slice::from_ref(&r.label)),
                l.num("span", "v", &r.value),
                l.segs("span", std::slice::from_ref(&card.unit)),
            )
        })
        .collect();
    let eyebrow = if card.eyebrow.is_empty() {
        String::new()
    } else {
        format!("<p class=\"eyebrow\">{}</p>", l.segs("span", &card.eyebrow))
    };
    Ok(format!(
        "<figure class=\"card pub-visual\" data-module-id=\"{id}\" data-visual-type=\"horizontal_bar\" data-engine=\"svg\">\
         {eyebrow}<h2>{title}</h2><p class=\"sub\">{sub}</p>\
         <svg class=\"pub-chart\" viewBox=\"0 0 {CARD_W} {height:.1}\" role=\"img\" aria-label=\"{title}\" aria-describedby=\"desc-{id}\" tabindex=\"0\">{svg}</svg>\
         <p class=\"sr\" id=\"desc-{id}\">{desc}</p>\
         <p class=\"source\">{source}</p></figure>",
        id = esc(&card.id),
        title = esc(&card.title),
        sub = l.segs("span", &card.subtitle),
        height = f.height(),
        desc = desc.join("；"),
        source = l.segs("span", &card.source),
    ))
}

// ---- the page: the outermost group (its recipe), a text column with the cards under it ----

/// The tokens and the grid: prose 520 wide, cards 660, page 1200, breakpoints 1024 / 780 / 425, gutter 16. Greys after the
/// census page; `__ACCENT__` is the one accent. Local fonts only, so the page makes no request.
const CSS: &str = r#":root{--accent:__ACCENT__;--ink:#292928;--body:#4d4d4d;--dek:#676767;--second:#848484;--bar:#d4d4d4;--empty:#e5e5e5;--rule:#f2f2f2;--bg:#ffffff;
--serif:"Songti SC","Noto Serif SC","Source Han Serif SC",serif;--sans:"PingFang SC","Noto Sans SC","Source Han Sans SC","Microsoft YaHei",sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--body);font:400 16px/24px var(--sans)}
.page{max-width:1200px;margin:0 auto;padding:48px 16px 64px}
.prose{max-width:520px;margin:0 auto}
.kicker,.eyebrow{margin:0;font:600 13px/20px var(--sans);color:var(--accent);letter-spacing:.08em}
h1{margin:8px 0 16px;font:900 50px/1.2 var(--serif);color:var(--ink)}
.dek{margin:0;font:400 18px/28px var(--serif);color:var(--dek)}
.hero{margin:36px auto 8px;border-top:5px solid var(--rule);padding-top:16px}
.hero .big{font:700 72px/1 var(--sans);color:var(--accent);letter-spacing:-.02em}
.hero .unit{font-size:36px;margin-left:4px}
.hero .what{margin:8px 0 0;font:300 15px/22px var(--sans);color:var(--dek)}
.body p{margin:16px 0}
.n{font-weight:700;color:var(--ink)}
.card{max-width:660px;margin:40px auto 0;border-top:5px solid var(--rule);padding-top:12px}
.card h2{margin:0;font:600 18px/26px var(--sans);color:var(--ink)}
.card .sub{margin:2px 0 12px;font:300 15px/22px var(--sans);color:var(--dek)}
.card svg{display:block;width:100%;overflow:visible}
.card .source{margin:8px 0 0;font:300 12px/18px var(--sans);color:var(--second);text-transform:uppercase;letter-spacing:.04em}
.lab{font:400 13px var(--sans);fill:var(--body)}
.bar{fill:var(--bar)}
.val{font:400 12px var(--sans);fill:var(--second)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:1024px){h1{font-size:42px}}
@media (max-width:780px){h1{font-size:34px}.card{max-width:none}}
@media (max-width:425px){h1{font-size:28px}.hero .big{font-size:56px}.hero .unit{font-size:28px}}
"#;

/// The kicker, title and dek.
pub static HEADER: NodeInfo = NodeInfo {
    name: "header",
    needs: &["title"],
    knobs: &[],
    inner: None,
};

/// The page's one big number with its unit and what it is.
pub static HERO: NodeInfo = NodeInfo {
    name: "hero",
    needs: &["value"],
    knobs: &[],
    inner: None,
};

/// The body paragraphs.
pub static PROSE: NodeInfo = NodeInfo {
    name: "prose",
    needs: &["text"],
    knobs: &[],
    inner: None,
};

static COLUMN_PAGE_GROUP: GroupInfo = GroupInfo {
    name: "column_page",
    layers: &[
        Layer {
            name: "header",
            node: &HEADER,
        },
        Layer {
            name: "hero",
            node: &HERO,
        },
        Layer {
            name: "body",
            node: &PROSE,
        },
        Layer {
            name: "cards",
            node: &BAR_CARD,
        },
    ],
    exposed: &[
        Exposed {
            name: "sort",
            layer: "cards",
            knob: "sort",
        },
        Exposed {
            name: "unit",
            layer: "cards",
            knob: "unit",
        },
    ],
};

/// A one-column page: the header, the big number, the body, then each card in the spec's order. The recipe of any page
/// whose cards are drawn by registered card groups; it shows the cards' sort and unit.
pub static COLUMN_PAGE: NodeInfo = NodeInfo {
    name: "column_page",
    needs: &[],
    knobs: &[],
    inner: Some(&COLUMN_PAGE_GROUP),
};

/// What the page's layers draw on: the spec, the one ledger the whole page prints through, and what could not be drawn.
struct PageFrame<'a> {
    spec: &'a PageSpec,
    ledger: RefCell<Ledger>,
    errors: RefCell<Vec<String>>,
}

fn draw_header(f: &PageFrame, _: &mut Occ, _: &Layer, _: &Style) -> String {
    let kicker = f.ledger.borrow_mut().segs("span", &f.spec.kicker);
    format!(
        "<header class=\"prose\"><p class=\"kicker\">{kicker}</p><h1>{}</h1><p class=\"dek\">{}</p></header>",
        esc(&f.spec.title),
        esc(&f.spec.dek)
    )
}

fn draw_hero(f: &PageFrame, _: &mut Occ, _: &Layer, _: &Style) -> String {
    let Some(hero) = &f.spec.hero else {
        return String::new();
    };
    let mut l = f.ledger.borrow_mut();
    format!(
        "<section class=\"prose hero\" data-module-id=\"hero\" data-visual-type=\"hero_stat\"><div class=\"big\">{}<span class=\"unit\">{}</span></div><p class=\"what\">{}</p></section>",
        l.num("span", "v", &hero.value),
        l.segs("span", std::slice::from_ref(&hero.unit)),
        l.segs("span", &hero.label)
    )
}

fn draw_prose(f: &PageFrame, _: &mut Occ, _: &Layer, _: &Style) -> String {
    let mut l = f.ledger.borrow_mut();
    let paras: String = f
        .spec
        .body
        .iter()
        .map(|p| format!("<p>{}</p>", l.segs("span", p)))
        .collect();
    format!("<div class=\"prose body\">{paras}</div>")
}

fn draw_cards(f: &PageFrame, _: &mut Occ, _: &Layer, st: &Style) -> String {
    f.spec
        .cards
        .iter()
        .map(|card| match card {
            Card::Bar(bar) => bar_card(bar, &f.ledger, st).unwrap_or_else(|e| {
                f.errors.borrow_mut().push(e);
                String::new()
            }),
        })
        .collect()
}

/// A drawn page and the ledger it came back with (source -> the text printed), for the visual command to check.
#[derive(Debug)]
pub struct Rendered {
    pub html: String,
    pub ledger: std::collections::BTreeMap<String, String>,
}

fn is_hex_colour(text: &str) -> bool {
    text.len() == 7 && text.starts_with('#') && text[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// The page for `spec` by the column recipe, with `style` set on `COLUMN_PAGE`. Err lists every number or name that could
/// not go on it and every card that could not be drawn. The page is not checked here: the visual command checks it.
pub fn render(spec: &PageSpec, style: &Style) -> Result<Rendered, String> {
    if !is_hex_colour(&spec.accent) {
        return Err(format!("the accent {:?} is not #rrggbb", spec.accent));
    }
    let f = PageFrame {
        spec,
        ledger: RefCell::new(Ledger::default()),
        errors: RefCell::new(vec![]),
    };
    let defs = [
        NodeDef {
            info: &HEADER,
            reserve: None,
            draw: draw_header,
        },
        NodeDef {
            info: &HERO,
            reserve: None,
            draw: draw_hero,
        },
        NodeDef {
            info: &PROSE,
            reserve: None,
            draw: draw_prose,
        },
        NodeDef {
            info: &BAR_CARD,
            reserve: None,
            draw: draw_cards,
        },
    ];
    let (layers, _) = layered(
        &f,
        &COLUMN_PAGE_GROUP,
        &defs.iter().collect::<Vec<_>>(),
        style,
    )?;
    let errors = f.errors.into_inner();
    let ledger = f.ledger.into_inner().finish();
    let ledger = match (ledger, errors.is_empty()) {
        (Ok(l), true) => l,
        (l, _) => {
            let mut all = errors;
            all.extend(l.err());
            return Err(all.join("\n"));
        }
    };
    let main: String = layers.into_iter().map(|(_, s)| s).collect();
    let html = format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>{title}</title><style>{css}</style></head><body><main class=\"page pub-page\" data-style-profile=\"next-column\">\
         {main}</main><script>{READY_JS}</script></body></html>",
        title = esc(&spec.title),
        css = CSS.replace("__ACCENT__", &spec.accent),
        READY_JS = crate::next_ledger::READY_JS,
    );
    Ok(Rendered { html, ledger })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::next_ledger::check_numbers;
    use crate::next_nodes::{check_info, list, Val};
    use std::collections::BTreeMap;

    fn num(src: &str, value: f64, text: &str) -> Num {
        Num {
            src: src.into(),
            value,
            text: text.into(),
        }
    }
    fn row(key: &str, label: Seg, value: f64, text: &str, claim: Option<Num>) -> BarRow {
        BarRow {
            key: key.into(),
            label,
            value: num(&format!("series:s1:{key}:value"), value, text),
            claim,
        }
    }
    fn card() -> BarCard {
        BarCard {
            id: "c1".into(),
            eyebrow: vec![
                Seg::Text("前".into()),
                Seg::Num(num("rec:members", 3.0, "3")),
            ],
            title: "可再生能源占比".into(),
            subtitle: vec![Seg::Num(num("series:s1:time", 2025.0, "2025"))],
            rows: vec![
                row("DE", Seg::Text("德国".into()), 21.3, "21.3", None),
                row(
                    "SE",
                    Seg::Text("瑞典".into()),
                    65.4,
                    "65.4",
                    Some(num("claim-a:value", 65.4, "65.4")),
                ),
                row(
                    "EU27_2020",
                    Seg::Label(Label {
                        src: format!("{LABEL_SRC}zh_names:geo:EU27_2020"),
                        text: "欧盟27国".into(),
                    }),
                    24.5,
                    "24.5",
                    None,
                ),
            ],
            lead: Some("SE".into()),
            bracket: vec![],
            unit: Seg::Text("%".into()),
            source: vec![Seg::Text("来源：".into()), Seg::Ref("nrg_ind_ren".into())],
        }
    }
    fn draw(card: &BarCard, style: &Style) -> Result<(String, BTreeMap<String, String>), String> {
        let ledger = RefCell::new(Ledger::default());
        let html = bar_card(card, &ledger, style)?;
        Ok((html, ledger.into_inner().finish()?))
    }
    fn set(knob: &str, v: &str) -> Style {
        let mut st = Style::default();
        st.set(&BAR_CARD, knob, Val::Word(v.into())).unwrap();
        st
    }

    #[test]
    fn the_bar_card_registers_as_a_sound_group_showing_sort_and_unit() {
        assert!(
            check_info(&BAR_CARD).is_empty(),
            "{:?}",
            check_info(&BAR_CARD)
        );
        let shown: Vec<_> = list(&BAR_CARD)
            .into_iter()
            .filter_map(|l| l.exposed_as.map(|e| (e, l.path)))
            .collect();
        assert_eq!(
            shown,
            [
                ("sort", "bars/sort".to_string()),
                ("unit", "value_labels/unit".to_string())
            ]
        );
        let mut st = Style::default();
        let r = st.set(&BAR_CARD, "bar_h", Val::Num(20.0));
        assert!(
            r.is_err(),
            "a knob the group does not expose keeps its default"
        );
    }

    #[test]
    fn a_bar_card_prints_every_number_through_the_ledger_and_passes_the_page_check() {
        let (html, ledger) = draw(&card(), &Style::default()).unwrap();
        let want: BTreeMap<String, String> = [
            ("rec:members", "3"),
            ("series:s1:time", "2025"),
            ("series:s1:DE:value", "21.3"),
            ("series:s1:SE:value", "65.4"),
            ("series:s1:EU27_2020:value", "24.5"),
            ("claim-a:value", "65.4"),
            ("name:zh_names:geo:EU27_2020", "欧盟27国"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(ledger, want);
        let refs = ["nrg_ind_ren".to_string()];
        assert_eq!(check_numbers(&html, &ledger, &refs), Vec::<String>::new());
        // the claim's number labels its bar; the series value is the bar and its line in the description
        assert!(html.contains("<text class=\"val\" x=\"486.0\" y=\"20.0\" dy=\"0.35em\"><tspan class=\"v\" data-src=\"claim-a:value\">65.4</tspan>%</text>"), "{html}");
        assert!(
            html.contains("瑞典 <span class=\"v\" data-src=\"series:s1:SE:value\">65.4</span>%"),
            "{html}"
        );
        assert!(
            !html.contains("<tspan class=\"v\" data-src=\"series:s1:SE:value\">"),
            "{html}"
        );
        // descending by default; the drawing is the fixed 640 px viewBox
        let order: Vec<_> = ["瑞典", "欧盟27国", "德国"]
            .iter()
            .map(|n| html.find(n).unwrap())
            .collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]), "{html}");
        assert!(html.contains("viewBox=\"0 0 640 88.0\""), "{html}");
        // with one digit off the ledger the check fails it
        let off = html.replace(">21.3<", ">21.4<");
        assert!(!check_numbers(&off, &ledger, &refs).is_empty());
    }

    #[test]
    fn the_unit_and_sort_knobs_change_only_what_they_name() {
        let units = |st: &Style| draw(&card(), st).unwrap().0.matches("%</text>").count();
        assert_eq!(
            units(&Style::default()),
            1,
            "the unit after the first value"
        );
        assert_eq!(units(&set("unit", "all")), 3);
        assert_eq!(units(&set("unit", "off")), 0);
        let (html, _) = draw(&card(), &set("sort", "asc")).unwrap();
        assert!(
            html.find("德国").unwrap() < html.find("瑞典").unwrap(),
            "{html}"
        );
        let (html, _) = draw(&card(), &set("sort", "data")).unwrap();
        assert!(
            html.find("德国").unwrap() < html.find("瑞典").unwrap()
                && html.find("瑞典").unwrap() < html.find("欧盟27国").unwrap()
        );
    }

    #[test]
    fn a_bar_card_refuses_rows_it_cannot_draw_and_numbers_it_cannot_print() {
        let mut bad = card();
        bad.rows[0].value.value = -1.0;
        assert!(draw(&bad, &Style::default())
            .unwrap_err()
            .contains("at or above zero"));
        bad.rows.clear();
        assert!(draw(&bad, &Style::default()).is_err());
        let mut bad = card();
        bad.rows[1].claim = Some(num("claim-a:value", 65.4, "64.0"));
        let err = draw(&bad, &Style::default()).unwrap_err();
        assert!(
            err.contains("claim-a:value: the text \"64.0\" does not print the value 65.4"),
            "{err}"
        );
    }

    fn spec() -> PageSpec {
        PageSpec {
            accent: "#c8553d".into(),
            kicker: vec![Seg::Text("可再生能源".into())],
            title: "瑞典领先".into(),
            dek: "北欧遥遥领先。".into(),
            hero: Some(Hero {
                value: num("claim-a:value", 65.4, "65.4"),
                unit: Seg::Text("%".into()),
                label: vec![
                    Seg::Text("瑞典，".into()),
                    Seg::Num(num("series:s1:time", 2025.0, "2025")),
                ],
            }),
            body: vec![vec![
                Seg::Text("德国为".into()),
                Seg::Num(num("series:s1:DE:value", 21.3, "21.3")),
                Seg::Text("%。".into()),
            ]],
            cards: vec![Card::Bar(card())],
            refs: vec!["nrg_ind_ren".into()],
        }
    }
    fn door(spec: &PageSpec) -> Result<Rendered, String> {
        match crate::next_visual::call(crate::next_visual::Request::Page { spec }) {
            Ok(crate::next_visual::Reply::Page(page)) => Ok(page),
            Ok(_) => unreachable!(),
            Err(e) => Err(e),
        }
    }

    #[test]
    fn the_visual_command_draws_a_column_page_and_refuses_one_with_a_digit_off_its_ledger() {
        assert!(
            check_info(&COLUMN_PAGE).is_empty(),
            "{:?}",
            check_info(&COLUMN_PAGE)
        );
        let page = door(&spec()).unwrap();
        assert_eq!(page.ledger.len(), 7, "{:?}", page.ledger);
        let at = |s: &str| {
            page.html
                .find(s)
                .unwrap_or_else(|| panic!("{s} not in the page"))
        };
        assert!(
            at("<h1>") < at("hero_stat")
                && at("hero_stat") < at("class=\"prose body\"")
                && at("class=\"prose body\"") < at("<figure")
        );
        assert!(page.html.ends_with(&format!(
            "<script>{}</script></body></html>",
            crate::next_ledger::READY_JS
        )));
        // a digit typed into words, not read from the data
        let mut typed = spec();
        typed.dek = "北欧遥遥领先，2025年。".into();
        let err = door(&typed).unwrap_err();
        assert!(err.contains("the digits 2025"), "{err}");
        // a number printed two ways, and a card it cannot draw
        let mut two = spec();
        two.body[0][1] = Seg::Num(num("series:s1:DE:value", 21.3, "21.30"));
        assert!(door(&two).unwrap_err().contains("printed as both"));
        // one value printed two ways from two sources: the hero's claim and the bar it is about
        let mut alike = spec();
        let Card::Bar(c) = &mut alike.cards[0];
        c.rows[1].value.text = "65.40".into();
        let err = door(&alike).unwrap_err();
        assert!(err.contains("the value 65.4 is printed"), "{err}");
        let mut empty = spec();
        let Card::Bar(c) = &mut empty.cards[0];
        c.rows.clear();
        assert!(door(&empty)
            .unwrap_err()
            .contains("c1: a bar card needs rows"));
        let mut accent = spec();
        accent.accent = "red".into();
        assert!(door(&accent).is_err());
    }
}
