//! New route, visual group: what the flow hands the page renderer. A `PageSpec` names every piece of the page as words, numbers
//! from the data (`Num`, with where each was read) and names from the data (`Label`, when a name holds digits); the renderer's
//! nodes draw it and print every number through next_ledger, and the visual command checks the page against its ledger. The
//! flow builds a spec from these types only (shared vocabulary): it never prints a number or checks a page itself.

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
