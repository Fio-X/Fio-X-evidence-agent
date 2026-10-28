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
}
