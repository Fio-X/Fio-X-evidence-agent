"""Story findings: the candidate findings a long page (the story recipe, story.py) can tell, worked out from the request's rows,
scored, and, for the ones the model picks, composed into the page's sections. Nothing here belongs to a topic: the measure's
name, its unit and the places' names come from the request (layer 1 writes them from the knowledge group), every number on
the page is a fact this file declares and layer 1 computes and checks again from the rows (next_facts); the values worked
out here only rank the findings, they are never printed.

Angles (data-journalism practice: change and pace, the gap to a target, scenarios, the spread between places, who rose
and who fell), each one section with one story leaf (a leaf stands at most once on a page, so each angle names its own):
  * path   (target_path):    the whole's line so far and three paces carried on to the target year (the past average,
                              the last five years', the best single year's every year): even the best is short, or which
                              pace gets there; needs a target.
  * need   (gap_axis):       where the whole stands, the target, and the pace a year the target needs over the past
                              average pace ("x times"); needs a target above or below the last value.
  * spread (winners_losers): the members that rose and those that fell between the first and the last year, and whether
                              the lowest at the start caught up with the highest (group_change), when both columns hold one.
  * ends   (pair_bars):      the highest and the lowest member at the last year side by side, the first over the second.
  * rank   (rankbar):        every member's value at the last year from the highest down, the whole among them (its row the
                              page's accent) and where it stands, "position" among the members and itself; with no whole the
                              highest and the lowest; the share column is each row's difference from the whole (or from the
                              highest). The leaf draws no reference line: a target the request holds is said in the text only.
                              Needs five members at least with a value in a year they all share (the latest such year).
  * members (small_multiples): one small line chart a member on one shared axis over the years every member has (at least
                              SM_YEARS), the whole as a pale line behind them and a target within reach as a dashed level;
                              the two members whose change over the span stands furthest apart in the accent; with more than
                              SM_MAX members the SM_MAX / 2 highest and lowest at the last year. Needs SM_MIN members at least.
                              Score: size = how far the best member's change is from the worst's over the picture's range of
                              values; surprise = the share of members moving against the majority; sturdy = years and members.
  * map    (member_map):     the members' values at the last year they share, each member's country filled by its value on
                              a map (five steps), the highest and the lowest MAP_CALL called out; the title names the highest
                              and the lowest and, when the east or the north (or the west, the south) holds the higher values
                              clearly, says so. Needs the request's "points" ({code: [lon, lat]}, a point inside each member's
                              country, which layer 1 reads from the attributes table) for MAP_MIN members at least. Score: size
                              = the values' range over the highest; surprise = how far the two halves of the members, split at the
                              median longitude or latitude, differ in mean over the range; sturdy = members.
  * movers   (change_dots):  every member's value at the first and the last year they share as two dots on a row joined by a line,
                              the rows from the largest rise to the largest fall (with more than DOTS_MAX members the largest
                              rises and falls only), the whole as a bold row: who moved most. Needs DOTS_MIN members at least.
                              Score: size = how far the rows' changes stand apart over the span of the values drawn; surprise =
                              how far down the start order the biggest mover began (a late starter that moved most is news);
                              sturdy = members and years.
  * overtake (rank_slope):   every place's rank at the first and the last year as two columns joined by a line (a slope chart),
                              the places that rose most and fell most in the accent, the one the riser passed named: who
                              overtook whom. Ranks are the table's own (position facts over every place of the table), so it
                              needs the rows to hold the members and the whole and no other place, each with both years, between
                              SLOPE_MIN and SLOPE_MAX of them, and at least one place that rose two ranks. Score: size = the share
                              of pairs of places whose order flipped, over a quarter; surprise = the biggest riser's jump over a
                              third of the places; sturdy = places and years.
  * tiles    (tile_map):     the map angle's data (the request's "points", TILE_MIN members at least) drawn as one tile a member
                              on a grid that keeps the directions (a tile as big as any other: no small member vanishes), each
                              tile printing the member's name and value; the title says which side holds the higher values like
                              the map's. Score: the map's, times 0.8 to 1.2 by how many members there are (a crowd of small
                              members is what a map hides: 8 members 0.8, 24 or more 1.2).
  * chain  (event_chain):    the companion tables' series side by side on the years they and the whole share (a panel
                              each, the page's measure not one of them), the one year the whole moved most shaded across
                              them: what moved around that year, told in order and never as a cause; needs the request's
                              "chain" (two to five tables) and a whole.
  * pace   (winners_losers): the members' simple mean over two windows of the years they all share, each window's pace a year
                              (per_year of the mean at its ends), the split year chosen by the program: the request's first
                              event whose years both windows leave PACE_WIN years at least on each side (named by the event's
                              words), else the split with the largest difference of the two paces (named by its year alone, no
                              cause word); the rows are the mean and the members whose pace changed most each way (before →
                              after), and the later pace over the earlier when both are above 0. No count of the members that
                              sped up is printed: no op checks a member's two paces against each other. Needs PACE_MIN years.
  * groups (winners_losers): the members grouped by the request's "groups" (the knowledge group's M49 sub-regions), each group's
                              simple mean at the last year they share against the mean of every grouped member, the gap of the
                              highest group over the lowest, and the group with the widest spread inside it named by its highest
                              and lowest member. Needs GROUPS_MIN groups of GROUP_MEMBERS members at least.
  * below  (unit_grid):      the members under a line at the last year they share (the target, else the whole's value, else
                              the members' simple mean), named lowest first and counted by layer 1 (op count, below); raised by a
                              "which ones" question (story.ask.below).
  pace and groups draw on winners_losers until their own leaves are wired; a page's picks that name one leaf twice keep the first.
  Each block declares what it shows ("shows": measure, year or span, shape of SHAPES): two blocks with an entry in common answer one
  question and the page keeps the first (the lead's); a page holds MAX_BLOCKS data blocks at most; a flag grid with no lit glyph
  is not drawn; a strip of more than LABEL_ALL_MAX points names only the lead finding's members ("about").
  A finding whose question words (words.zh.json story.ask.<angle>) the request's "question" holds is scored ASKED_BOOST higher.
  The change notes of spread, movers and overtake end with how many times the members' average change the mover's change is (to_average:
  the average a mean fact over the same members, the multiple a times fact), or keep their plain words where no average stands.
Chain rules. Years: the longest run of consecutive years, ending at the last, that every chain table and the whole have
(at least CHAIN_YEARS). A chain table is read at the dims its "filter" names (one row a year, else the angle is dropped).
Panel kind: the item's "kind" ("flow" = bars, "stock" = line) when it gives one, else bars when every value of the run is 0
or above (a flow's values are amounts, never below 0), whatever the number of years, else a line; a flow with a value below 0
is a line. A line is drawn from 0 when its values are all 0 or above and its lowest is at most half its highest (a series
that swings from near nothing), else on its own range.
Formats: an item's "fmt" (a format of the request's fmt_defs) when it gives one; else the child names one by the series'
size, the largest value of the run (1000 or more: no decimal place, 10 or more: one, under 10: two), as "<table>_d0",
"<table>_d1" or "<table>_d2", which the request defines in "chain_fmts" ({name: {"scale", "dec", "suffix"}}, the flow writes the
three of each chain table with that table's unit suffix); a name chain_fmts lacks refuses the angle. The whole's change in
the title keeps the page's value format.
Band: the one year, inside the run and not its first, where the sum over the chain tables of the step from the year before
(in size), each step over that table's own range on the run (its highest less its lowest), is largest (the earlier year if two
tie): the year the tables together moved most, whichever of them it was; a table that does not move at all adds nothing. It is
shaded in every panel and named in the key; the title prints the whole's own change that year (the larger of the whole's two
values less the smaller, above 0 whichever way it moved: a figure the page's rows give, the title not saying it moved most).
The link under each band between two panels is one neutral word of the table ("then"), never a claim of cause.
Score = size x surprise x sturdiness, each 0..1: size how far the finding's number is from the plain reading (the gap
left, the ratio), surprise whether it goes against the obvious (even the best year falls short; the low ones did not catch
up; for the chain, how many of the companion series have their own biggest step in the band year or the year after it),
sturdiness how many years and members (panels) it stands on. The chain's size is its band's summed steps over the number of
tables (each table at most 1: all of them at their own biggest step that year). The page takes the model's three picks of the top five.

Request (one JSON line on stdin, one reply line on stdout; mode "candidates"):
  {"mode": "candidates",
   "rows": [{"src", "table", "dims", "time", "value"}],        # the request's rows (next_facts Row)
   "main": {"table", "by": dim, "whole": code?, "members": [code]?, "filter": {dim: code}?},
   "target": {"table", "filter": {dim: code}, "time": year}?,   # the whole's target row (knowledge group, I8)
   "fmts": {"value": fmt, "year": fmt, "times": fmt,            # the spec's format names for a value, a year, a ratio,
            "delta": fmt?},                                     # and a difference or pace (a share's in points; value if none)
   "fmt_defs": {fmt: {"scale", "dec", "suffix"}},               # those formats (an axis's ticks are worked out as next_facts does)
   "words": {"measure": words, "unit": words, "unit_src": ledger name?},   # the measure's name and its unit (no digit; a unit whose
                                                                 # name holds one, a base year, comes as unit_src, the unit table's name entry)
   "points": {code: [lon, lat]}?,                              # a point inside each member's country (the map angle's)
   "chain": [{"table", "filter": {dim: code}, "words": {"measure", "unit"}, "fmt"?: fmt, "kind"?: "flow"|"stock"}]?,
                                                                 # companion tables (knowledge group's chain_companions), their
                                                                 # place and years the main's; "fmt" absent: taken by size (below)
   "chain_fmts": {"<table>_d0|d1|d2": {"scale", "dec", "suffix"}}?,   # the formats a chain item with no "fmt" takes by size
   "groups": {"groups": [{"id", "name_zh", "members": [code]}], "moved": [{"code", "from_zh", "to_zh"}]}?,  # knowledge group
   "events": [{"id", "name_zh", "from": year, "to": year}]?,   # registered events over the table's years (none today)
   "question": text?}                                          # the question asked (raises the findings it names)
Reply: {"candidates": [{"id", "angle", "layer", "score", "why", "summary"}...], "dropped": [{"angle", "why"}]}, best first;
"summary" is the one-line English summary the model reads (no number of its own: a finding is picked by its number in the list).

Request (mode "compose"): the same fields and "picks": [candidate id, ...] (the model's, first the answer); reply:
  {"facts": {key: query}, "sections": [section], "leaves": {layer: hero.data}} — what the flow writes into knobs.spec
  (facts into spec.facts, sections into spec.sections, leaves into hero.leaves). A section is story.py's: {"id", "layer",
  "kicker"?, "title"?, "text"?}; a title or text is a wording whose numbers are placeholders ({k}, {k.t}, {name.<code>}).
  The page opens with a thesis block (thesis_claims: the answer and each pick's number pointing to its section) and closes
  with the risk notes (risk_notes: each scenario named as one, the last year read)."""
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # run as a child with -I: its folder holds the word table
import words as WD  # noqa: E402

THESIS, NOTES = "thesis_claims", "risk_notes"
CHAIN_MIN, CHAIN_MAX = 2, 5   # the tables a chain holds
CHAIN_YEARS = 4      # years in a row every chain table and the whole share, at least
MIN_YEARS = 6        # a pace needs this many years of the whole at least
RECENT = 5           # the recent pace runs over the last five years
TOP_K = 14           # the candidates the child gives (one a finding: there are fourteen angles; the flow shows the model its best few)
GROUP_K = 3          # the lowest and the highest three at the start (spread)
ROWS_MAX = 5         # rows a winners/losers column shows
MAP_MIN, MAP_CALL = 8, 3   # members with a point a map needs at least; the highest and the lowest this many are called out
SM_MIN, SM_MAX, SM_YEARS = 6, 12, 5   # members a small-multiples grid needs at least and shows at most; years in a row they share
RANK_MIN, RANK_MAX = 5, 40   # members a ranking needs at least, and shows at most
DOTS_MIN, DOTS_MAX = 6, 16   # members a change-dots picture needs at least; with more it keeps the DOTS_MAX / 2 largest rises and the DOTS_MAX / 2 largest falls
SLOPE_MIN, SLOPE_MAX = 6, 30   # places a rank slope needs at least, and draws at most (the whole among them)
TILE_MIN, TILE_MAX = 10, 40   # members with a point a tile map needs at least, and draws at most
PACE_MIN, PACE_WIN = 8, 4     # years in a row the members share a two-period pace needs, and years each window holds at least (the windows may share the split year)
GROUPS_MIN, GROUP_MEMBERS = 2, 3   # groups a group comparison needs at least, each with this many members at least
ASKED_BOOST = 1.0             # added to the score of a finding the question's words name, so it is shown first
BELOW_MIN, BELOW_NAMES = 8, 5   # members a "which ones are under the line" finding needs at least; the lowest it names in its title
MAX_BLOCKS = 5                # data blocks a page holds at most (the picks' own sections and the extra parts; not the numbers, thesis or notes)
LABEL_ALL_MAX = 20            # a strip of more points than this names only the lead finding's members (the rest unlabelled)
LEAD_MAX = 12                 # names a strip takes at most (dot_strip's LEAD_MAX)
LABEL_GAP = 0.08              # two names in one strip row stand at least this share of the strip's span apart
MEAN_MIN = 3                  # members an average change a note is set against stands on at least (as the level notes' simple mean)
# What a block can show, its "shape" (each part declares shows: [{measure, when, shape}], Req.shows): two blocks that share an
# entry answer one question, and a page keeps the first (place_leaves, same_question). No chart is named here: a leaf's part
# says what it shows, the comparison reads only these declarations.
SHAPES = {"rank": "every member's value at one year, in order (who is high, who is low, who is under a line)",
          "change": "every member's value at two years: who rose, who fell",
          "rank_change": "every place's rank at two years: who overtook whom",
          "series": "each member's line over the years",
          "map": "the members' values at one year by where they lie",
          "ends": "the highest member over the lowest at one year",
          "path": "the whole's line carried on to the target year", "need": "the pace the target needs against the past pace",
          "chain": "companion series around the year they moved most", "pace": "the members' mean pace before and after a split",
          "pace_members": "the members whose pace changed most", "group_means": "each group's mean against every member's",
          "within_groups": "the members by group: the spread inside each group"}


class Refused(Exception):
    pass


# ---------------------------------------------------------------- the rows as series

def series(rows, table, by, code, fixed):
    """{year: (value, src)} of one code of `by` in `table`, the `fixed` dims held; a period that is no year is left out."""
    out = {}
    for r in rows:
        if r.get("table") != table: continue
        d = r.get("dims") or {}
        if d.get(by) != code or any(d.get(k) != v for k, v in (fixed or {}).items()): continue
        t = str(r.get("time"))
        v = number(r.get("value"))
        if len(t) == 4 and t.isdigit() and v is not None:
            out[t] = (v, r["src"])
    return dict(sorted(out.items()))


def number(v):
    """A row's value as a float: the knowledge group gives it as the source's decimal text, a test as a number; None when
    it is neither or not finite."""
    if isinstance(v, bool): return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def codes_of(rows, table, by, fixed):
    seen = []
    for r in rows:
        d = r.get("dims") or {}
        if r.get("table") == table and by in d and all(d.get(k) == v for k, v in (fixed or {}).items()) and d[by] not in seen:
            seen.append(d[by])
    return seen


def run_years(s):
    """The longest run of consecutive years at the end of a series (a pace never spans a gap)."""
    ys = [int(y) for y in s]
    out = [ys[-1]] if ys else []
    for y in reversed(ys[:-1]):
        if y != out[0] - 1: break
        out.insert(0, y)
    return [str(y) for y in out]


# ---------------------------------------------------------------- ticks as next_facts::ticks works them out

def fixed_text(x, dec):
    s = f"{x:,.{dec}f}"
    return s[1:] if s.startswith("-") and not any(c in "123456789" for c in s) else s   # a value that rounds to 0 has no minus


def ticks(top_value, fmt_def):
    """The axis ticks of a fact (0 left out), as next_facts::ticks gives them: their count is what a leaf names."""
    scale, dec = float(fmt_def.get("scale", 1.0)), int(fmt_def.get("dec", 0))
    top = top_value * scale
    if not (math.isfinite(top) and top > 0): raise Refused("an axis needs a fact above 0")
    place = 10.0 ** -dec
    target = top / 3.0
    mag = 10.0 ** math.floor(math.log10(target))
    step = next((m * mag for m in (5.0, 2.0, 1.0) if m * mag <= target * (1 + 1e-9)), mag)
    step = max(step, place)
    out, i = [], 1
    while i * step <= top * (1 + 1e-9):
        out.append(i * step / scale); i += 1
    if not out: raise Refused("the axis is shorter than one printed place")
    return out


# ---------------------------------------------------------------- wording: one template, two spellings

def wording(parts):
    """A template as a wording (story.py's titles and texts): ("w", words), ("f", key), ("y", key: its year with the year word,
    as {key.t} prints it), ("n", code)."""
    out = []
    for kind, v in parts:
        out.append({"w": v, "f": "{%s}" % v, "y": "{%s.t}" % v, "n": "{name.%s}" % v}[kind])
    return "".join(out)


def segs(parts):
    """The same template as a leaf's segments (wbkit.segs)."""
    out = []
    for kind, v in parts:
        if kind == "y":  # the year's entry prints the bare year; the year word follows it, as {k.t} prints it in a wording
            out += [{"src": f"fact:{v}.t.y"}, {"word": "story.year"}]
            continue
        out.append({"w": {"w": v}, "f": {"src": f"fact:{v}"}, "n": {"name": v}}[kind])
    return out


TEMPLATE = re.compile(r"\{([fynlg]):(\w+)\}")


def T(key, **bind):
    """A word-table template (words.zh.json story.*) as parts: {f:k} a fact's number, {y:k} its year, {n:v} a place's name,
    {l:v} a list of places' names joined by the table's join word, {g:v} plain words the request gave (a group's or an event's
    name, never with a digit); a slot's name is looked up in `bind` first (a place's
    code, a list of codes, or another fact key), else it is the fact key itself. The file holds no word of its own."""
    text, out, at = WD.WORDS[key], [], 0
    for mo in TEMPLATE.finditer(text):
        if mo.start() > at: out.append(("w", text[at:mo.start()]))
        kind, name = mo.groups()
        v = bind.get(name, name)
        if kind == "g":
            if not isinstance(v, str) or not v or any(ch.isdigit() for ch in v): raise Refused(f"the words {v!r} are no plain words")
            out.append(("w", v))
        elif kind == "l":
            for i, c in enumerate(v):
                if i: out.append(("w", WD.WORDS["story.join"]))
                out.append(("n", c))
        else:
            out.append((kind, v))
        at = mo.end()
    if at < len(text): out.append(("w", text[at:]))
    return out


def W(t):
    return [("w", t)]


def SW(t):
    """Plain words as a leaf's segments."""
    return [{"w": t}]


def ST(key, **bind):
    """A word-table template as a leaf's segments."""
    return segs(T(key, **bind))


def note(key, word, **bind):
    """One short note over a section's picture: a number (the fact `key`, the section's own) and the words that say what it is (a
    word-table template of the section's own facts and names, never a number of its own)."""
    return {"num": f"fact:{key}", "text": ST(word, **bind)}


def ratio(q, f, name, a, b, va, vb, flip=False):
    """The short note's comparison: `a` as a multiple of `b` (op times), only where it is a plain ratio (a >= 0, b > 0); True when written.
    `flip`: for the smaller of the two (a below b), the other way round, b as a multiple of a ("the whole is 1.8 times the lowest", not
    "the lowest is 0.6 times the whole"); then the smaller must be above 0."""
    if flip: a, b, va, vb = b, a, vb, va
    if vb > 0 and va >= 0:
        f[name] = {"op": "times", "a": a, "b": b, "fmt": q.fmts["times"]}
        return True
    return False


def versus(q, f, tag, a, b, va, vb, only_up=False):
    """How far the value of fact `a` stands from the value of fact `b`, as one more fact of the section: (kind, up, name) or None.
    A percent measure: the gap in percentage points (op minus, the larger less the smaller, the page's change format); any other unit: the
    larger as a multiple of the smaller (op times, only a plain ratio, the smaller above 0). `up` is whether a is the larger. None
    where the two print alike (a gap that prints 0, a multiple that prints 1.0), where the multiple is no plain ratio, or (only_up) where a is
    the smaller: the caller keeps its plain note, no number is made up."""
    if va == vb or (only_up and va < vb): return None
    up, name = va > vb, f"vs_{tag}"
    if (q.defs.get(q.fmts["value"]) or {}).get("suffix", "").strip() == "%":
        if printed(q, abs(va - vb), q.fmts.get("delta") or q.fmts["value"]) == 0: return None
        f[name] = {"op": "minus", "a": a if up else b, "b": b if up else a, "fmt": q.change}
        return "pp", up, name
    big, small = max(va, vb), min(va, vb)
    if small <= 0 or printed(q, big / small, q.fmts["times"]) <= 1: return None
    return ("x", up, name) if ratio(q, f, name, a, b, va, vb, flip=not up) else None


def compared(q, f, tag, base, num, a, b, va, vb, only_up=False, mean=False, **bind):
    """A short note that says where its number stands against a reference: the plain note `base` (its words say what the number is) becomes
    "<what it is>, <higher/lower by N points | N times the reference>" when versus() finds a number; else it stays as it was."""
    v = versus(q, f, tag, a, b, va, vb, only_up)
    if not v: return note(num, base, **bind)
    kind, up, name = v
    return note(num, f"{base}{'_m' if mean else ''}_{kind}_{'up' if up else 'dn'}", rv=b, d=name, **bind)


def to_average(q, f, base, num, d, avg, avg_key, avg_facts, n, **bind):
    """A change note set against the members' average change: the plain note `base` (its number the fact `num`, the mover's change `d`)
    becomes "<base>, N times the average" (word `<base>_ref`, fact k_<num> = num over avg_key, op times) when the mover moved more than
    the average, else "<base>, the average is N times it" (`<base>_ref_lo`, avg_key over num: the larger is the one said to be N times,
    as ratio() flips). `d` and `avg` are the two changes in one reading (both signed, or both the size in the mover's direction); `avg` is
    the plain mean over `n` members, its facts `avg_facts` (avg_key among them) declared only when the note uses them. The note stays as it
    was and declares nothing when fewer than MEAN_MIN members feed the mean, the mean is 0 (the shared tolerance), it went the other way
    from the mover's (a multiple of an average that moved the other way would mislead), the multiple prints as 1 or less (it says nothing),
    or the word table holds no such variant of `base`."""
    if n < MEAN_MIN or abs(avg) <= 1e-9 * max(abs(d), 1.0) or d * avg <= 0: return note(num, base, **bind)
    over = abs(d) >= abs(avg)
    word = f"{base}_ref" if over else f"{base}_ref_lo"
    big, small = (abs(d), abs(avg)) if over else (abs(avg), abs(d))
    if word not in WD.WORDS or printed(q, big / small, q.fmts["times"]) <= 1: return note(num, base, **bind)
    k = f"k_{num}"
    f.update(avg_facts)
    f[k] = {"op": "times", "a": num if over else avg_key, "b": avg_key if over else num, "fmt": q.fmts["times"]}
    return note(num, word, k=k, **bind)


def plain_ends(hi, lo):
    """The suffix of a highest-and-lowest headline: "" (the words with a verb before each number, "reaches N", "only N") when both values
    are above 0, else "_nov" (the same numbers with no verb: "reaches" or "only" before a value of 0 or below would mislead)."""
    return "" if hi > 0 and lo > 0 else "_nov"


def clamp(x):
    return max(0.0, min(1.0, x))


# ---------------------------------------------------------------- the request

# The measure families (the knowledge group's runtime/pi/assets/measure-families.json, shipped beside this folder): each family's
# "zh" is its reviewed short name for the page, and its "tables" the table ids (or id prefixes ending in "_" or ".") it holds.
FAMILIES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pi", "assets", "measure-families.json")


def short_measure(table):
    """The short name a chart's head prints for the main table's measure: the zh of the first measure family that holds the table
    (as next_visual measure_family matches it: a prefix ending in "_" or ".", else the id itself, the id's "@<version>" left off),
    or None when no family holds it, the file is missing or the name holds a digit (the request's measure words stay then). The
    table's long reviewed name stays on the page's source line, which layer 1 writes."""
    try:
        with open(FAMILIES, encoding="utf-8") as fh: fams = json.load(fh).get("families") or []
    except (OSError, ValueError):
        return None
    tid = str(table or "").split("@")[0]
    for fam in fams:
        held = [h for h in fam.get("tables") or [] if isinstance(h, str) and h]
        if any(tid.startswith(h) if h.endswith(("_", ".")) else tid == h for h in held):
            zh = fam.get("zh")
            return zh if isinstance(zh, str) and zh and not any(ch.isdigit() for ch in zh) else None
    return None


class Req:
    def __init__(q, r):
        q.rows = r.get("rows") or []
        m = r.get("main") or {}
        q.table, q.by, q.fixed = m.get("table"), m.get("by"), dict(m.get("filter") or {})
        if not q.table or not q.by: raise Refused("findings: the request names no main table or place dimension")
        q.whole = m.get("whole")
        q.members = [c for c in (m.get("members") or codes_of(q.rows, q.table, q.by, q.fixed)) if c != q.whole]
        q.target = r.get("target")
        q.fmts = r.get("fmts") or {}
        q.defs = {**(r.get("fmt_defs") or {}), **(r.get("chain_fmts") or {})}
        for k in ("value", "year", "times"):
            if not q.fmts.get(k): raise Refused(f"findings: the request gives no {k} format")
        # a difference or a pace of the measure (a share's in percentage points): its own format when the request gives one
        q.change = q.fmts.get("delta") or q.fmts["value"]
        q.words = r.get("words") or {}
        us = q.words.get("unit_src")
        if us is not None and not (isinstance(us, str) and us.startswith("name:unit_short_zh:")): raise Refused("findings: the unit's name entry is no name:unit_short_zh: entry")
        for k in ("measure", "unit"):
            if not q.words.get(k): raise Refused(f"findings: the request gives no {k} words")
            if any(ch.isdigit() for ch in q.words[k]) and not (k == "unit" and us): raise Refused(f"findings: the {k} words hold a digit")
        # the unit as a leaf's segments: its words, or (a name with a digit) the unit table's name entry, which layer 1 holds to the table
        q.unit = [{"src": us}] if us else SW(q.words["unit"])
        # the measure as a chart's head names it: the family's short name for the main table, else the request's measure words
        q.head_name = short_measure(q.table) or q.words["measure"]
        q.chain = r.get("chain")
        pts = r.get("points") or {}
        q.points = {c: tuple(v) for c, v in pts.items() if isinstance(v, (list, tuple)) and len(v) == 2 and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v)} if isinstance(pts, dict) else {}
        q.panel = {c: series(q.rows, q.table, q.by, c, q.fixed) for c in q.members}
        q.panel = {c: s for c, s in q.panel.items() if s}
        q.wseries = series(q.rows, q.table, q.by, q.whole, q.fixed) if q.whole else {}
        g = r.get("groups") if isinstance(r.get("groups"), dict) else {}
        q.groups = [x for x in (g.get("groups") or []) if isinstance(x, dict) and x.get("id") and x.get("name_zh") and isinstance(x.get("members"), list)]
        q.moved = [x for x in (g.get("moved") or []) if isinstance(x, dict) and x.get("code") and x.get("from_zh") and x.get("to_zh")]
        q.events = [x for x in (r.get("events") or []) if isinstance(x, dict) and x.get("name_zh") and x.get("from") and x.get("to")]
        q.question = r.get("question") if isinstance(r.get("question"), str) else ""
        q.illus = {}   # {angle: the subject the opening picture draws}, set by each angle that has one (illus_*); compose hands the lead's on
        # the measure a block shows: the main table at its fixed dimensions (what "the same measure" means in shows)
        q.measure = q.table + "".join(f"|{k}={v}" for k, v in sorted(q.fixed.items()))

    def shows(q, when, shape):
        """One entry of what a block shows (a part's "shows"): the measure, the year or the span ("y0-y1") it reads, and the shape
        of its answer (SHAPES). Two blocks with one entry in common answer one question (same_question)."""
        if shape not in SHAPES: raise Refused(f"findings: {shape!r} is no shape a block shows")
        return {"measure": q.measure, "when": str(when), "shape": shape}

    def asked(q, angle):
        """The first of the angle's question words (words.zh.json story.ask.<angle>, "|" between them) the question holds, or None."""
        return next((w for w in WD.WORDS.get(f"story.ask.{angle}", "").split("|") if w and w in q.question), None)

    def mean(q, codes, year, fmt=None):
        """The members' simple mean at a year (next_facts mean over a list of codes); its time names the year a rate reads."""
        return {"op": "mean", "table": q.table, "filter": {**q.fixed, q.by: sorted(codes)}, "within": year, "time": year,
                "fmt": fmt or q.fmts["value"]}

    def target_ref(q):
        """({goal: query}, ref) of the registered target as a reference line (dot_strip refs, kind target): its label the
        target's place name and year in the words' frame (story.ref.target), both from the request's target row; None with none."""
        g = q.goal()
        place = (q.target or {}).get("filter", {}).get(q.by) if g else None
        if not place: return None
        return {"goal": g[2]}, {"kind": "target", "text": "fact:goal", "label": ST("story.ref.target", w=place)}

    def filt(q, code):
        return {**q.fixed, q.by: code}

    def value(q, code, year, fmt=None):
        return {"table": q.table, "filter": q.filt(code), "time": year, "fmt": fmt or q.fmts["value"]}

    def goal(q):
        """(value, year, query) of the target row, or None."""
        t = q.target
        if not t: return None
        hits = [r for r in q.rows if r.get("table") == t.get("table") and str(r.get("time")) == str(t.get("time"))
                and all((r.get("dims") or {}).get(k) == v for k, v in (t.get("filter") or {}).items())]
        if len(hits) != 1 or number(hits[0].get("value")) is None: return None
        return number(hits[0]["value"]), str(t["time"]), {"table": t["table"], "filter": dict(t.get("filter") or {}),
                                                          "time": str(t["time"]), "fmt": q.fmts["value"]}

# ---------------------------------------------------------------- the opening picture's subject
# The lead finding's own rows as the subject the illustration child (runtime/illus_hero/run_hero.py) draws: the values the angle's leaf
# reads (at the year it reads them, in the page's units: the value format's scale), nothing retyped. An angle with no sensible subject
# sets none; compose then adds no `picture` and the picture is drawn as before. The family and the measure are the caller's.
ILLUS_MEMBERS = (3, 60)   # members a tally, a rank or a pair draws (run_hero members_of)
ILLUS_YEARS = (4, 30)     # years a series draws (the layout's series min and max)


def illus_value(q, v):
    """A row's value in the page's units (the value format's scale), without float noise."""
    return round(v * float(q.defs.get(q.fmts["value"], {}).get("scale", 1)), 9)


def illus_members(q, at):
    """[{"code", "value"}] of {code: value} in the page's units, by code; None outside the picture's member range."""
    if not ILLUS_MEMBERS[0] <= len(at) <= ILLUS_MEMBERS[1]: return None
    return [{"code": c, "value": illus_value(q, at[c])} for c in sorted(at)]


def illus_lit(members, op, ref):
    """The codes a threshold rule lights (lt: below ref, ge: at or above it)."""
    return sorted(m["code"] for m in members if (m["value"] < ref if op == "lt" else m["value"] >= ref))


def illus_tally(q, at, year):
    """{"members", "rule", "declared"}: the members at `year` against the line the page draws, the registered target, else the whole's
    value at that year; None with neither, or when the rule lights none or all of them (no count to draw)."""
    ms = illus_members(q, at)
    g = q.goal()
    line = g[0] if g else (q.wseries[year][0] if q.whole and year in q.wseries else None)
    if ms is None or line is None: return None
    ref = illus_value(q, line)
    n = len(illus_lit(ms, "lt", ref))
    if not 0 < n < len(ms): return None
    return {"members": ms, "rule": {"op": "lt", "ref": ref}, "declared": {"count": n, "total": len(ms)}}


def illus_pair(q, at):
    """{"members"} of the members at the last year (the highest and the lowest are the pair); None unless the highest is above the lowest."""
    ms = illus_members(q, at)
    if ms is None or min(m["value"] for m in ms) < 0 or max(m["value"] for m in ms) <= min(m["value"] for m in ms): return None
    return {"members": ms}


def illus_series(q, vals, split):
    """{"series", "split", "declared"} of {year: value} with the years from `split` on lit (the last ILLUS_YEARS[1] years when there are more);
    None when it leaves no year before or none from the split."""
    ys = sorted(vals, key=int)[-ILLUS_YEARS[1]:]
    lit = [y for y in ys if int(y) >= split]
    if len(ys) < ILLUS_YEARS[0] or not 0 < len(lit) < len(ys): return None
    return {"series": [{"t": int(y), "value": illus_value(q, vals[y])} for y in ys], "split": split,
            "declared": {"count": len(lit), "total": len(ys)}}


# A rate (a measure whose value prints with the percent sign, layer 1's fmt_defs suffix "%") read off one member may also be drawn as a share
# of PROPORTION_FIGURES figures (a classroom), K = N x share half to even: run_hero recounts it from Decimal(repr(share)) and refuses another
# count; a K of 0 or N has nothing to count and gives no proportion. It is a key beside the angle's own subject, never in its place: the
# child draws it only where the topic's renderer is the scene renderer, and the angle's own subject everywhere else.
PROPORTION_FIGURES = 30
MEASURE_SLOT = "<measure>"   # the caption's place for the measure's name: a {"slot": "measure"} segment story.py fills from the page's kicker


def proportion_count(share, n):
    """K of n figures for a share, half to even on the share's decimal value as written (run_hero.proportion_flags' own rule)."""
    from decimal import Decimal, ROUND_HALF_EVEN
    return int((Decimal(repr(share)) * n).to_integral_value(rounding=ROUND_HALF_EVEN))


def illus_proportion(q, c):
    """{"share", "figures", "declared": {"count", "total"}} (the subject's "proportion") of a finding whose claim (the lead section's title) names one
    member and prints its value: a value fact of the main table read off that member at a year (no op), on a measure that is a rate.
    The share is that member's row at that year in the page's units over 100, nothing retyped; the page prints the fact, never K. None
    otherwise: a measure that is no rate (a money unit, a count), a claim naming no member or more than one, a number that is no value
    (a position, a change, a multiple), a share off 0..1, or a K of 0 or of every figure."""
    if (q.defs.get(q.fmts["value"]) or {}).get("suffix", "").strip() != "%": return None
    named = [v for kind, v in c["claim"]["head"] if kind == "n"]
    num = c["claim"]["num"]
    if len(set(named)) != 1 or not num.startswith("fact:"): return None
    code, f = named[0], c["facts"].get(num[len("fact:"):]) or {}
    if f.get("op", "value") != "value" or f.get("table") != q.table or (f.get("filter") or {}).get(q.by) != code: return None
    cell = q.panel.get(code, {}).get(str(f.get("time")))
    if cell is None or number(cell[0]) is None: return None
    share = round(illus_value(q, number(cell[0])) / 100, 12)
    if not 0.0 <= share <= 1.0: return None
    k = proportion_count(share, PROPORTION_FIGURES)
    if not 0 < k < PROPORTION_FIGURES: return None
    return {"share": share, "figures": PROPORTION_FIGURES, "declared": {"count": k, "total": PROPORTION_FIGURES}}


# ---------------------------------------------------------------- the angles

def paces(s):
    """(years in the end run, past avg, recent, best step and its year) of a {year: (v, src)} series."""
    ys = run_years(s)
    v = {y: s[y][0] for y in ys}
    first, last = ys[0], ys[-1]
    span = int(last) - int(first)
    past = (v[last] - v[first]) / span
    r0 = str(int(last) - RECENT)
    recent = (v[last] - v[r0]) / RECENT
    steps = {ys[i]: v[ys[i]] - v[ys[i - 1]] for i in range(1, len(ys))}
    best_y = max(steps, key=lambda y: (steps[y], -int(y)))
    return ys, past, recent, steps[best_y], best_y


def angle_path(q):
    g = q.goal()
    if not g: return None, "no target row"
    if not q.whole or len(run_years(q.wseries)) < MIN_YEARS: return None, f"the whole has fewer than {MIN_YEARS} years in a row"
    gv, gy, gq = g
    ys, past, recent, best, best_y = paces(q.wseries)
    first, last = ys[0], ys[-1]
    now = q.wseries[last][0]
    if int(gy) <= int(last): return None, "the target year is not after the last year"
    up = gv > now
    if not up: return None, "the target is not above the last value (a falling path draws on another angle)"
    if min(past, recent, best) <= 0: return None, "a pace is not above 0"
    n = int(gy) - int(last)
    runs = {"p_best": now + best * n, "p_recent": now + recent * n, "p_past": now + past * n}
    top = max([gv] + list(runs.values()))
    f = {"now": q.value(q.whole, last), "first": q.value(q.whole, first), "rec0": q.value(q.whole, str(int(last) - RECENT)),
         "goal": gq,
         "past": {"op": "per_year", "a": "now", "b": "first", "fmt": q.change},
         "recent": {"op": "per_year", "a": "now", "b": "rec0", "fmt": q.change},
         "best": {"op": "step_max", "table": q.table, "filter": q.filt(q.whole), "from": first, "to": last, "fmt": q.change},
         "p_past": {"op": "line_at", "start": "now", "rate": "past", "at": gy, "fmt": q.fmts["value"]},
         "p_recent": {"op": "line_at", "start": "now", "rate": "recent", "at": gy, "fmt": q.fmts["value"]},
         "p_best": {"op": "line_at", "start": "now", "rate": "best", "at": gy, "fmt": q.fmts["value"]}}
    # the axis runs to the highest value drawn: a fact of its own key (another finding may declare the same fact with no axis)
    top_key = max(["goal", "p_best", "p_recent", "p_past"], key=lambda k: gv if k == "goal" else runs[k])
    f["path_top"] = {**f[top_key], "axis": True}
    short = runs["p_best"] < gv
    if short:
        title = T("story.path.short")
        surprise, size = 1.0, clamp((gv - runs["p_best"]) / max(gv - now, 1e-9))
    else:
        f["when"] = {"op": "reach_year", "start": "now", "rate": "best", "target": "goal", "fmt": q.fmts["year"]}
        reached = [k for k in ("p_past", "p_recent") if runs[k] >= gv]
        if reached:
            k = reached[0]
            title = T("story.path.reach_past" if k == "p_past" else "story.path.reach_recent")
            surprise, size = 0.3, clamp((runs[k] - gv) / max(gv - now, 1e-9))
        else:
            title = T("story.path.when")
            surprise, size = 0.7, clamp((gv - runs["p_recent"]) / max(gv - now, 1e-9))
    text = T("story.path.text")
    s = q.wseries
    tk = ticks(top, q.defs.get(q.fmts["value"], {}))
    data = {"title": SW(q.head_name), "unit": q.unit,
            "series": {"code": q.whole, "points": [s[y][1] for y in ys], "start_text": lab(q, f, "first"), "end_text": lab(q, f, "now")},
            "target": {"year": "fact:goal.t.y", "text": lab(q, f, "goal"), "label": ST("story.target")},
            "runs": [{"text": lab(q, f, "p_best"), "label": ST("story.run.best")},
                     {"text": lab(q, f, "p_recent"), "label": ST("story.run.recent")},
                     {"text": lab(q, f, "p_past"), "label": ST("story.run.past")}],
            "axis": {"ticks": [f"fact:path_top.tick{i}" for i in range(1, len(tk) + 1)], "scale": float(q.defs.get(q.fmts["value"], {}).get("scale", 1))},
            "periods": [f"period:{q.table}:{y}" for y in ys],
            "footnote": ST("story.path.foot")}
    if short:
        f["gap"] = {"op": "minus", "a": "goal", "b": "p_best", "fmt": q.change}
        data["gap_label"] = ST("story.gap", g="gap")
    anns = []  # a note adds what the title and the text do not print: the gap each slower pace leaves to the target
    for run, key in (("p_recent", "gap_recent"), ("p_past", "gap_past")):
        if runs[run] < gv:
            f[key] = {"op": "minus", "a": "goal", "b": run, "fmt": q.change}
            anns.append(note(key, f"story.note.path.{key}"))
    sturdy = clamp(len(ys) / 15)
    q.illus["path"] = {"path": {"from": illus_value(q, q.wseries[first][0]), "now": illus_value(q, now), "goal": illus_value(q, gv)}}
    return {"angle": "path", "shows": [q.shows(f"{first}-{gy}", "path")], "about": [], "layer": "target_path", "kicker": T("story.path.kicker"), "title": title, "text": text, "facts": f, "data": data,
            "claim": {"num": "fact:p_best", "head": T("story.path.claim")}, "notes": ["scenario"], "last": "now",
            "anns": anns,
            "score": round(size * surprise * sturdy, 4),
            "why": {"size": round(size, 3), "surprise": surprise, "sturdy": round(sturdy, 3)},
            "summary": "even the best single year's rise repeated every year falls short of the target" if short else
                    "the target year under three paces: which pace gets there"}, None


def angle_need(q):
    g = q.goal()
    if not g: return None, "no target row"
    if not q.whole or len(run_years(q.wseries)) < MIN_YEARS: return None, f"the whole has fewer than {MIN_YEARS} years in a row"
    gv, gy, gq = g
    ys, past, recent, best, best_y = paces(q.wseries)
    first, last = ys[0], ys[-1]
    now = q.wseries[last][0]
    if int(gy) <= int(last) or gv <= now: return None, "the target is not above the last value after the last year"
    if past <= 0: return None, "the past pace is not above 0"
    need = (gv - now) / (int(gy) - int(last))
    ratio = need / past
    f = {"now": q.value(q.whole, last), "first": q.value(q.whole, first), "goal": gq, "need_top": {**gq, "axis": True},
         "past": {"op": "per_year", "a": "now", "b": "first", "fmt": q.change},
         "need": {"op": "per_year", "a": "goal", "b": "now", "fmt": q.change},
         "need_x": {"op": "times", "a": "need", "b": "past", "fmt": q.fmts["times"]},
         "p_past": {"op": "line_at", "start": "now", "rate": "past", "at": gy, "fmt": q.fmts["value"]},
         "gap_now": {"op": "minus", "a": "goal", "b": "now", "fmt": q.change},
         "rec0": q.value(q.whole, str(int(last) - RECENT)),  # the notes: the recent pace and the best year, which the title and the text do not print
         "recent": {"op": "per_year", "a": "now", "b": "rec0", "fmt": q.change},
         "best": {"op": "step_max", "table": q.table, "filter": q.filt(q.whole), "from": first, "to": last, "fmt": q.change}}
    title, text = T("story.need.title"), T("story.need.text")
    tk = ticks(gv, q.defs.get(q.fmts["value"], {}))
    data = {"title": SW(q.head_name), "unit": q.unit,
            "axis": {"ticks": [f"fact:need_top.tick{i}" for i in range(1, len(tk) + 1)], "scale": float(q.defs.get(q.fmts["value"], {}).get("scale", 1)), "from_zero": True},
            "now": {"text": lab(q, f, "now"), "at": q.wseries[last][1], "label": ST("story.now")},
            "marks": [{"text": lab(q, f, "p_past"), "label": ST("story.run.past")}],
            "target": {"text": lab(q, f, "goal"), "label": ST("story.target_year")},
            }
    if now + past * (int(gy) - int(last)) < gv:  # the leaf takes a gap's words only when no mark reaches the target
        data["gap_label"] = ST("story.gap", g="gap_now")
    size = clamp((ratio - 1) / 3)
    surprise = 1.0 if need > best else 0.6
    sturdy = clamp(len(ys) / 15)
    q.illus["need"] = {"path": {"from": illus_value(q, q.wseries[first][0]), "now": illus_value(q, now), "goal": illus_value(q, gv)}}
    return {"angle": "need", "shows": [q.shows(last, "need")], "about": [], "layer": "gap_axis", "kicker": T("story.need.kicker"), "title": title, "text": text, "facts": f, "data": data,
            "claim": {"num": "fact:need_x", "head": T("story.need.claim")}, "notes": ["scenario"], "last": "now",
            "anns": [note("recent", "story.note.need.recent"), note("best", "story.note.need.best", y="best")],
            "score": round(size * surprise * sturdy, 4),
            "why": {"size": round(size, 3), "surprise": surprise, "sturdy": round(sturdy, 3), "ratio": round(ratio, 3)},
            "summary": "the pace a year the target needs, against the past average pace"}, None


def common_ends(q):
    """The first and last year every member has (the panel's span), or None."""
    if len(q.panel) < 2: return None
    years = set.intersection(*(set(s) for s in q.panel.values()))
    if len(years) < 2: return None
    ys = sorted(years)
    return ys[0], ys[-1]


def angle_spread(q):
    ends = common_ends(q)
    if not ends: return None, "fewer than two members with two common years"
    y0, y1 = ends
    if len(q.panel) < 2 * GROUP_K: return None, f"fewer than {2 * GROUP_K} members"
    ch = {c: s[y1][0] - s[y0][0] for c, s in q.panel.items()}
    up = sorted([c for c in ch if ch[c] > 0], key=lambda c: -ch[c])[:ROWS_MAX]
    down = sorted([c for c in ch if ch[c] < 0], key=lambda c: ch[c])[:ROWS_MAX]
    start = sorted(q.panel, key=lambda c: -q.panel[c][y0][0])
    top, low = start[:GROUP_K], start[-GROUP_K:]
    top_ch = sum(ch[c] for c in top) / GROUP_K
    low_ch = sum(ch[c] for c in low) / GROUP_K
    caught = low_ch > top_ch
    members = sorted(q.panel)
    f = {"lowg": {"op": "group_change", "table": q.table, "filter": q.fixed, "by": q.by, "from": y0, "to": y1, "part": "bottom",
                  "k": GROUP_K, "fmt": q.change},
         "topg": {"op": "group_change", "table": q.table, "filter": q.fixed, "by": q.by, "from": y0, "to": y1, "part": "top",
                  "k": GROUP_K, "fmt": q.change},
         "y0": q.value(members[0], y0), "y1": q.value(members[0], y1)}
    rows = {}
    for side, cs in (("up", up), ("down", down)):
        rows[side] = []
        for c in cs:
            a, b, d = f"a_{c.lower()}", f"b_{c.lower()}", f"d_{c.lower()}"
            f[a], f[b] = q.value(c, y0), q.value(c, y1)
            f[d] = {"op": "minus", "a": b, "b": a, "fmt": q.change}
            rows[side].append({"label": [{"name": c}], "a": cell_src(q, a, q.fmts["value"]), "b": cell_src(q, b, q.fmts["value"]), "change": [{"src": f"fact:{d}"}]})
    # the groups are named, never counted in words: a count would be a number no fact prints
    title = T("story.spread.caught" if caught else "story.spread.not")
    text = T("story.spread.text", low=sorted(low), top=sorted(top))
    if not up or not down:
        # a column with no rows is refused by the leaf: one side only is a page of the ends instead
        return None, "every member moved the same way (one column would be empty)"
    data = {"up": {"title": ST("story.up"), "rows": rows["up"]}, "down": {"title": ST("story.down"), "rows": rows["down"]},
            "footnote": ST("story.span")}
    size = clamp(abs(low_ch - top_ch) / max(abs(top_ch), abs(low_ch), 1e-9))
    surprise = 0.9 if not caught else 0.5
    sturdy = clamp(len(q.panel) / 20) * clamp((int(y1) - int(y0)) / 10)
    key = "lowg" if caught else "topg"
    # the two notes against the members' mean change over the span (the mean at the last year less the mean at the first: every member has both)
    avg = {"sp_m0": q.mean(members, y0), "sp_m1": q.mean(members, y1), "sp_mch": {"op": "minus", "a": "sp_m1", "b": "sp_m0", "fmt": q.change}}
    mch = sum(ch.values()) / len(ch)
    def spread_note(base, c):
        if len(members) >= MEAN_MIN and ch[c] * mch < 0 and printed(q, abs(mch), q.change) != 0 and f"{base}_opp" in WD.WORDS:
            # the mean went the other way: no multiple of it (it would mislead); the note says the mean's own change that way (its size)
            if mch > 0: f.update(avg); m = "sp_mch"
            else: f.update({"sp_m0": avg["sp_m0"], "sp_m1": avg["sp_m1"], "sp_mdn": {"op": "minus", "a": "sp_m0", "b": "sp_m1", "fmt": q.change}}); m = "sp_mdn"
            return note(f"d_{c.lower()}", f"{base}_opp", c=c, m=m)
        return to_average(q, f, base, f"d_{c.lower()}", ch[c], mch, "sp_mch", avg, len(members), c=c)
    anns = [spread_note(base, c) for base, c in (("story.note.spread.rise", up[0]), ("story.note.spread.fall", down[0]))]
    return {"angle": "spread", "shows": [q.shows(f"{y0}-{y1}", "change")], "about": [up[0], down[0]], "layer": "winners_losers", "kicker": T("story.spread.kicker"), "title": title, "text": text, "facts": f,
            "anns": anns,
            "data": data, "claim": {"num": f"fact:{key}", "head": T("story.spread.claim_low" if caught else "story.spread.claim_top")}, "notes": [], "members": True, "last": "y1",
            "score": round(size * surprise * sturdy, 4),
            "why": {"size": round(size, 3), "surprise": surprise, "sturdy": round(sturdy, 3), "caught_up": caught},
            "summary": "the lowest at the start caught up with the highest" if caught else "the lowest at the start did not catch up"}, None


def angle_ends(q):
    ends = common_ends(q)
    if not ends: return None, "fewer than two members with two common years"
    y1 = ends[1]
    at = {c: s[y1][0] for c, s in q.panel.items() if y1 in s}
    hi = max(at, key=lambda c: (at[c], c))
    lo = min(at, key=lambda c: (at[c], c))
    if at[lo] <= 0: return None, "the lowest member is not above 0 (no ratio)"
    if any(v < 0 for v in at.values()): return None, "a value below 0"
    ratio = at[hi] / at[lo]
    f = {"hi": q.value(hi, y1), "lo": q.value(lo, y1), "hi_lo": {"op": "times", "a": "hi", "b": "lo", "fmt": q.fmts["times"]},
         "d_hl": {"op": "minus", "a": "hi", "b": "lo", "fmt": q.change}}
    title, text = T("story.ends.title", a=hi, b=lo), T("story.ends.text", a=hi, b=lo)
    data = {"title": SW(q.head_name), "unit": q.unit, "places": [hi, lo], "place_kind": "place",
            "rows": [{"code": "main", "label": SW(q.head_name), "a": q.panel[hi][y1][1], "b": q.panel[lo][y1][1],
                      "a_text": lab(q, f, "hi"), "b_text": lab(q, f, "lo"), "ratio": "fact:hi_lo"}],
            "ratio_unit": ST("story.times")}
    size = clamp(math.log(ratio) / math.log(5))
    surprise = 0.5
    sturdy = clamp(len(at) / 20)
    ill = illus_pair(q, at)
    if ill: q.illus["ends"] = ill
    return with_part({"angle": "ends", "shows": [q.shows(y1, "ends")], "about": [hi, lo], "layer": "pair_bars", "kicker": T("story.ends.kicker"), "title": title, "text": text, "facts": f, "data": data,
            "claim": {"num": "fact:hi_lo", "head": T("story.ends.claim", a=hi, b=lo)}, "notes": [], "members": True, "last": "hi",
            "anns": [note("d_hl", "story.note.ends.diff", a=hi, b=lo)],
            "score": round(size * surprise * sturdy, 4),
            "why": {"size": round(size, 3), "surprise": surprise, "sturdy": round(sturdy, 3), "ratio": round(ratio, 3)},
            "summary": "the highest member over the lowest at the last year"}, grid_part(q, y1, sorted(at))), None


def chain_series(q, item):
    """{year: (value, src)} of one chain table at the dims its filter names, one row a year; two rows at a year refuse."""
    out = {}
    for r in q.rows:
        d = r.get("dims") or {}
        if r.get("table") != item["table"] or any(d.get(k) != v for k, v in item["filter"].items()): continue
        t, v = str(r.get("time")), number(r.get("value"))
        if not (len(t) == 4 and t.isdigit() and v is not None): continue
        if t in out: raise Refused(f"the chain table {item['table']} has two rows at {t} at that filter")
        out[t] = (v, r["src"])
    return dict(sorted(out.items()))


def angle_chain(q):
    ch = q.chain
    if not isinstance(ch, list) or len(ch) < CHAIN_MIN: return None, f"the request's chain holds fewer than {CHAIN_MIN} tables"
    if len(ch) > CHAIN_MAX: raise Refused(f"the chain holds more than {CHAIN_MAX} tables")
    if not q.whole or not q.wseries: return None, "no whole to print its change by"
    items, tables = [], []
    for i, it in enumerate(ch):
        if not isinstance(it, dict) or not it.get("table") or not isinstance(it.get("filter"), dict) or not it["filter"]:
            raise Refused(f"chain table {i + 1} names no table or filter")
        w = it.get("words") or {}
        for k in ("measure", "unit"):
            if not w.get(k): raise Refused(f"chain table {i + 1} gives no {k} words")
            if any(ch_.isdigit() for ch_ in w[k]): raise Refused(f"chain table {i + 1}'s {k} words hold a digit")
        fmt = it.get("fmt")
        if fmt is not None and fmt not in q.defs: raise Refused(f"chain table {i + 1} names the format {fmt}, which the request does not define")
        if it.get("kind") not in (None, "flow", "stock"): raise Refused(f"chain table {i + 1}'s kind is neither flow nor stock")
        key = (it["table"], tuple(sorted(it["filter"].items())))
        if key in tables: raise Refused(f"the chain names {it['table']} at the same filter twice")
        tables.append(key)
        items.append(dict(it, fmt=fmt, series=chain_series(q, it)))
    common = set(q.wseries)
    for it in items: common &= set(it["series"])
    ys = run_years({y: 1 for y in sorted(common)}) if common else []
    if len(ys) < CHAIN_YEARS: return None, f"the chain tables and the whole share fewer than {CHAIN_YEARS} years in a row"
    first, last = ys[0], ys[-1]
    vals_of = [[it["series"][y][0] for y in ys] for it in items]
    ranges = [max(v) - min(v) for v in vals_of]
    if not any(ranges): return None, "no chain table moves over the shared years"
    # each year's summed steps, every table's step over its own range (a table that does not move adds nothing)
    moved_by = {ys[j]: sum(abs(v[j] - v[j - 1]) / rg for v, rg in zip(vals_of, ranges) if rg) for j in range(1, len(ys))}
    band = max(moved_by, key=lambda y: (moved_by[y], -int(y)))
    prev = str(int(band) - 1)
    step = q.wseries[band][0] - q.wseries[prev][0]
    # the larger of the whole's two values less the smaller, above 0 whichever way it moved
    hi_y, lo_y = (band, prev) if step >= 0 else (prev, band)
    f = {"m_hi": q.value(q.whole, hi_y), "m_lo": q.value(q.whole, lo_y), "band_y": q.value(q.whole, band),
         "m_step": {"op": "minus", "a": "m_hi", "b": "m_lo", "fmt": q.change}}
    panels, moved = [], 0
    for i, it in enumerate(items):
        code, s = f"c{i + 1}", it["series"]
        vals = vals_of[i]
        k = it.get("kind")
        if k is None: k = "flow" if min(vals) >= 0 else "stock"
        kind = "bar" if k == "flow" and min(vals) >= 0 else "line"
        zero = kind == "bar" or (min(vals) >= 0 and min(vals) <= max(vals) / 2)
        filt = it["filter"]
        fmt = it.get("fmt")
        if fmt is None:
            top = max(abs(v) for v in vals)
            fmt = f"{it['table']}_d{0 if top >= 1000 else 1 if top >= 10 else 2}"
            if fmt not in q.defs: raise Refused(f"chain table {i + 1} takes the format {fmt} by its size, and the request's chain_fmts does not define it")
        f[f"{code}_first"] = {"table": it["table"], "filter": filt, "time": first, "fmt": fmt}
        f[f"{code}_last"] = {"table": it["table"], "filter": filt, "time": last, "fmt": fmt}
        pstep = {ys[j]: abs(vals[j] - vals[j - 1]) for j in range(1, len(ys))}
        big = max(pstep, key=lambda y: (pstep[y], -int(y))) if ranges[i] else None
        moved += big is not None and int(band) <= int(big) <= int(band) + 1
        p = {"code": code, "title": SW(it["words"]["measure"]), "unit": SW(it["words"]["unit"]), "kind": kind, "zero": zero,
             "points": [s[y][1] for y in ys], "first_text": lab(q, f, f"{code}_first"), "last_text": lab(q, f, f"{code}_last"),
             "periods": [f"period:{it['table']}:{first}", f"period:{it['table']}:{last}"]}
        if i < len(items) - 1: p["link"] = ST("story.chain.link")
        panels.append(p)
    data = {"title": SW(q.head_name), "panels": panels,
            "band": {"from": band, "to": band, "label": ST("story.chain.band", y="band_y")},
            "footnote": ST("story.chain.foot")}
    title = W(q.words["measure"]) + T("story.chain.title")
    text = T("story.chain.text")
    size = clamp(moved_by[band] / len(items))
    share = moved / len(items)
    surprise = clamp(0.3 + 0.7 * share)
    sturdy = clamp(len(ys) / 10) * clamp(len(items) / 4)
    ill = illus_series(q, {y: q.wseries[y][0] for y in ys}, int(band))   # the whole over the shared years, the shaded band's year the lit run's start
    if ill: q.illus["chain"] = ill
    return {"angle": "chain", "shows": [q.shows(band, "chain")], "about": [], "layer": "event_chain", "kicker": T("story.chain.kicker"), "title": title, "text": text, "facts": f,
            "data": data, "claim": {"num": "fact:m_step", "head": T("story.chain.claim")}, "notes": [], "last": "c1_last",
            "anns": [{"num": "fact:c1_last", "text": SW(items[0]["words"]["measure"]) + ST("story.note.chain.last")},
                     {"num": f"fact:c{len(items)}_last", "text": SW(items[-1]["words"]["measure"]) + ST("story.note.chain.last")}],
            "score": round(size * surprise * sturdy, 4),
            "why": {"size": round(size, 3), "surprise": round(surprise, 3), "sturdy": round(sturdy, 3), "band": band, "moved": moved},
            "summary": "companion series side by side, the one year they together moved most shaded"}, None


def angle_rank(q):
    members = {c: s for c, s in q.panel.items()}
    if len(members) < RANK_MIN: return None, f"fewer than {RANK_MIN} members"
    if len(members) > RANK_MAX: return None, f"more than {RANK_MAX} members (a ranking of them would not fit one picture)"
    years = set.intersection(*(set(s) for s in members.values()), *([set(q.wseries)] if q.wseries else []))
    if not years: return None, "no year in which every member (and the whole) has a value"
    y = max(years)
    at = {c: s[y][0] for c, s in members.items()}
    if any(v < 0 for v in at.values()): return None, "a value below 0 (a bar cannot be drawn)"
    hi = max(at, key=lambda c: (at[c], c))
    lo = min(at, key=lambda c: (at[c], c))
    if at[hi] == at[lo]: return None, "every member holds the same value"
    key = lambda c: f"r_{c.lower()}"
    ref_code = q.whole if q.wseries else hi          # the row the share column is measured from
    f, rows = {}, []
    pct = (q.defs.get(q.fmts["value"]) or {}).get("suffix", "").strip() == "%"
    codes = sorted(members) + ([q.whole] if q.wseries else [])
    for c in codes:
        f[key(c)] = q.value(c, y)
    for c in codes:
        f[f"g_{c.lower()}"] = {"op": "minus", "a": key(c), "b": key(ref_code), "fmt": q.change}
        rows.append({"code": c, "value": (q.wseries[y] if c == q.whole else members[c][y])[1], "value_text": lab(q, f, key(c)),
                     "share_text": f"fact:g_{c.lower()}.n" if pct else lab(q, f, f"g_{c.lower()}"), **({"share_none": True} if c == ref_code else {})})   # a gap of a percent: the number alone (the head says points); no cell for the row it is measured from (its gap is 0)
    sturdy = clamp(len(members) / 20)
    size = clamp((at[hi] - at[lo]) / at[hi])
    g = q.goal()
    if q.wseries:
        f["pos"] = {"op": "position", "table": q.table, "filter": q.fixed, "by": q.by, "code": q.whole, "time": y, "fmt": "n"}
        n_above = sum(1 for v in at.values() if v > q.wseries[y][0])
        frac = n_above / len(members)                   # 0 = the whole above every member, 1 = below every member
        surprise = clamp(0.3 + 0.7 * abs(frac - 0.5) * 2)
        title = T("story.rank.title", w=q.whole, hi=hi, lo=lo, y=key(hi), pos="pos")
        text = T("story.rank.text_goal" if g else "story.rank.text", w=q.whole, hi=hi, lo=lo, y=key(hi), rhi=key(hi), rlo=key(lo), rw=key(q.whole), pos="pos")
        claim = {"num": "fact:pos", "head": T("story.rank.claim", w=q.whole)}
        head, why_line = ST("story.rank.gap_head" + "_pp" * pct), "every member's value at the last year, highest first, and where the whole stands"
        why = {"size": round(size, 3), "surprise": round(surprise, 3), "sturdy": round(sturdy, 3), "above_whole": n_above}
    else:
        surprise = 0.5
        title = T("story.rank.title_top" + plain_ends(at[hi], at[lo]), hi=hi, lo=lo, rhi=key(hi), rlo=key(lo))
        text = T("story.rank.text_top", hi=hi, lo=lo, y=key(hi))
        claim = {"num": f"fact:{key(hi)}", "head": T("story.rank.claim_top", hi=hi)}
        head, why_line = ST("story.rank.gap_top_head" + "_pp" * pct), "every member's value at the last year, highest first"
        why = {"size": round(size, 3), "surprise": surprise, "sturdy": round(sturdy, 3)}
    if g: f["goal"] = g[2]
    ill = illus_pair(q, at)   # the members' values at the page's year (the whole is a row of the leaf, not a member of the ranking)
    if ill: q.illus["rank"] = {"members": ill["members"]}
    data = {"title": SW(q.head_name), "unit": q.unit, "share_head": head, "name_kind": "place", "rows": rows,
            "highlight": q.whole if q.wseries else hi,   # the code of the row the page draws in the accent (story.rank_style reads it)
            "omit": ST("story.rank.omit")}   # a long rank folds to its ends and the highlighted row (the leaf's fold_over), this line where rows are left out
    if q.wseries:   # each end as a multiple of the whole, where the end is on the side its words say
        w0 = q.wseries[y][0]
        hx = at[hi] > w0 and ratio(q, f, "t_hi", key(hi), key(q.whole), at[hi], w0)
        lx = at[lo] < w0 and ratio(q, f, "t_lo", key(lo), key(q.whole), at[lo], w0, flip=True)
        anns = [note(f"g_{hi.lower()}", "story.note.rank.hi" + "_x" * hx, hi=hi, w=q.whole, rw=key(q.whole), tx="t_hi"),
                note(f"g_{lo.lower()}", "story.note.rank.lo" + "_x" * lx, lo=lo, w=q.whole, rw=key(q.whole), tx="t_lo")]
    else:
        lx = ratio(q, f, "t_lo", key(lo), key(hi), at[lo], at[hi], flip=True)
        anns = [note(f"g_{lo.lower()}", "story.note.rank.lo_top" + "_x" * lx, lo=lo, hi=hi, rhi=key(hi), tx="t_lo")]
    return with_part({"angle": "rank", "shows": [q.shows(y, "rank")], "about": [hi, lo], "layer": "rankbar", "kicker": T("story.rank.kicker"), "title": title, "text": text, "facts": f, "data": data,
            "claim": claim, "notes": [], "members": True, "last": key(hi),
            "anns": anns,
            "score": round(size * surprise * sturdy, 4), "why": why, "summary": why_line}, grid_part(q, y, sorted(members))), None


def angle_members(q):
    members = dict(q.panel)
    if len(members) < SM_MIN: return None, f"fewer than {SM_MIN} members"
    common = set.intersection(*(set(s_) for s_ in members.values()))
    ys = run_years({y: 1 for y in sorted(common)}) if common else []
    if len(ys) < SM_YEARS: return None, f"the members share fewer than {SM_YEARS} years in a row"
    y0, y1 = ys[0], ys[-1]
    if len(members) > SM_MAX:  # the highest and the lowest at the last year
        order = sorted(members, key=lambda c: (-members[c][y1][0], c))
        keep = set(order[:SM_MAX // 2] + order[-(SM_MAX // 2):])
        members = {c: s_ for c, s_ in members.items() if c in keep}
    ch = {c: s_[y1][0] - s_[y0][0] for c, s_ in members.items()}
    hi = max(ch, key=lambda c: (ch[c], c))
    lo = min(ch, key=lambda c: (ch[c], c))
    if ch[hi] <= ch[lo]: return None, "every member changed alike"
    if ch[hi] == 0 or ch[lo] == 0: return None, "a member that stands furthest out did not move"
    allv = [s_[y][0] for s_ in members.values() for y in ys]
    span = max(allv) - min(allv)
    if span <= 0: return None, "every value is the same"
    key = lambda c: f"sm_{c.lower()}"
    f = {}
    for c in members:
        f[key(c)] = q.value(c, y1)
    for c in (hi, lo):
        f[f"sm0_{c.lower()}"] = q.value(c, y0)
    def d(c, up):  # the change, the larger value less the smaller
        a, b = (key(c), f"sm0_{c.lower()}") if up else (f"sm0_{c.lower()}", key(c))
        return {"op": "minus", "a": a, "b": b, "fmt": q.change}
    f["dhi"], f["dlo"] = d(hi, ch[hi] > 0), d(lo, ch[lo] > 0)
    if ch[hi] > 0 and ch[lo] < 0: tk = "story.sm.title_split"
    elif ch[lo] > 0: tk = "story.sm.title_up"
    else: tk = "story.sm.title_down"
    hot = key(hi)
    # what the two notes stand against: the whole's last value, else the members' simple mean at the last year (the page's own word for it)
    whole_at, by_mean = (q.wseries[y1][0], False) if q.whole and q.wseries and y1 in q.wseries else (None, False)
    if whole_at is not None: f["sm_w"] = q.value(q.whole, y1)
    else:
        pool = sorted(c for c, s_ in q.panel.items() if y1 in s_)
        if len(pool) >= 3:
            f["sm_w"] = q.mean(pool, y1)
            whole_at, by_mean = sum(q.panel[c][y1][0] for c in pool) / len(pool), True
    bind = dict(hi=hi, lo=lo, y0=f"sm0_{hi.lower()}", y1=hot)
    ref = None
    if q.wseries and all(y in q.wseries for y in ys):
        ref = {"code": q.whole, "points": [q.wseries[y][1] for y in ys], "label": ST("story.sm.ref", w=q.whole)}
    g = q.goal()
    target = None
    if g and 0 < g[0] <= 1.5 * max(allv):
        f["goal"] = g[2]
        target = {"text": lab(q, f, "goal"), "scale": float(q.defs[q.fmts["value"]].get("scale", 1)), "label": ST("story.sm.target")}
    data = {"title": SW(q.head_name), "unit": q.unit, "name_kind": "place",
            "cells": [{"code": c, "points": [members[c][y][1] for y in ys], "last_text": lab(q, f, key(c))} for c in sorted(members)],
            "periods": [f"period:{q.table}:{y0}", f"period:{q.table}:{y1}"], "accent": [hi, lo], "footnote": ST("story.sm.foot")}
    if ref: data["ref"] = ref
    if target: data["target"] = target
    # with no target row the page's legend says no dashed target (story.LEGEND_NO_TARGET; the leaf ignores the key)
    if not q.target: data["legend"] = "story.legend.members_ref" if ref else "story.legend.members_plain"
    ill = illus_tally(q, {c: s_[y1][0] for c, s_ in members.items()}, y1)   # the cells' last values against the target, else the reference line's last value
    if ill: q.illus["members"] = ill
    ups = sum(1 for v in ch.values() if v > 0); downs = sum(1 for v in ch.values() if v < 0)
    minority = min(ups, downs) / len(ch)
    size = clamp((ch[hi] - ch[lo]) / span)
    surprise = clamp(0.3 + 1.4 * minority)
    sturdy = clamp(len(ys) / 10) * clamp(len(members) / 8)
    big_items = [{"fact": hot, "label": {"word": "story.big.now", "name": hi, "year": {"src": f"fact:{hot}.t.y"}}},
                 {"fact": "dhi", "label": {"word": "story.big.change_of", "name": hi}}, {"fact": "dlo", "label": {"word": "story.big.change_of", "name": lo}}]
    return {"angle": "members", "shows": [q.shows(f"{y0}-{y1}", "series")], "about": [hi, lo], "layer": "small_multiples", "big": big_items, "kicker": T("story.sm.kicker"), "title": T(tk, **bind),
            "text": T("story.sm.text_ref" if ref else "story.sm.text", w=q.whole, y1=hot), "facts": f, "data": data,
            "claim": {"num": "fact:dhi", "head": T("story.sm.claim")}, "notes": [], "members": True, "last": hot,
            "anns": [compared(q, f, "hi", "story.note.members.last", hot, hot, "sm_w", members[hi][y1][0], whole_at, mean=by_mean, r=q.whole, hi=hi) if whole_at is not None else note(hot, "story.note.members.last", hi=hi),
                     compared(q, f, "lo", "story.note.members.last_lo", key(lo), key(lo), "sm_w", members[lo][y1][0], whole_at, mean=by_mean, r=q.whole, lo=lo) if whole_at is not None else note(key(lo), "story.note.members.last_lo", lo=lo)],
            "score": round(size * surprise * sturdy, 4),
            "why": {"size": round(size, 3), "surprise": round(surprise, 3), "sturdy": round(sturdy, 3), "rising": ups, "falling": downs},
            "summary": "one small chart a member on a shared axis: the member that moved most each way"}, None


def angle_map(q):
    if not q.points: return None, "the request gives no points for the members"
    members = {c: s_ for c, s_ in q.panel.items() if c in q.points}
    if len(members) < MAP_MIN: return None, f"fewer than {MAP_MIN} members with a point"
    years = set.intersection(*(set(s_) for s_ in members.values()))
    if not years: return None, "no year in which every member with a point has a value"
    y = max(years)
    at = {c: s_[y][0] for c, s_ in members.items()}
    hi = max(at, key=lambda c: (at[c], c)); lo = min(at, key=lambda c: (at[c], c))
    if at[hi] <= at[lo]: return None, "every member holds the same value"
    rng = at[hi] - at[lo]
    # the halves of the members at the median longitude and at the median latitude: the larger gap in means, and which side is higher
    best = halves(q, at)
    gradient = clamp(abs(best[0]) / rng)
    key = lambda c: f"mp_{c.lower()}"
    ranked = sorted(at, key=lambda c: (-at[c], c))
    called = ranked[:MAP_CALL] + ranked[-MAP_CALL:]
    f = {key(c): q.value(c, y) for c in called}
    f["mrange"] = {"op": "minus", "a": key(hi), "b": key(lo), "fmt": q.change}
    mx = ratio(q, f, "mx", key(hi), key(lo), at[hi], at[lo])
    second = ranked[1]
    tk = "story.map.title_" + (best[1] if gradient >= 0.2 else "plain") + plain_ends(at[hi], at[lo])
    data = {"title": SW(q.head_name), "unit": q.unit, "name_kind": "place",
            "cells": [dict({"code": c, "at": list(q.points[c]), "value": members[c][y][1]}, **({"text": lab(q, f, key(c))} if c in called else {})) for c in sorted(members)],
            "ends": {"lo": lab(q, f, key(lo)), "hi": lab(q, f, key(hi))}, "footnote": ST("story.map.foot")}
    size = clamp(rng / max(abs(at[hi]), 1e-9))
    surprise = clamp(0.3 + 0.7 * gradient)
    sturdy = clamp(len(members) / 20)
    ill = illus_tally(q, at, y)
    if ill: q.illus["map"] = ill
    big_items = [{"fact": key(hi), "label": {"word": "story.big.hi", "name": hi, "year": {"src": f"fact:{key(hi)}.t.y"}}},
                 {"fact": key(lo), "label": {"word": "story.big.lo", "name": lo, "year": {"src": f"fact:{key(lo)}.t.y"}}},
                 {"fact": "mrange", "label": {"word": "story.big.range"}}]
    return {"angle": "map", "shows": [q.shows(y, "map")], "about": [hi, lo], "layer": "member_map", "big": big_items, "kicker": T("story.map.kicker"), "title": T(tk, hi=hi, lo=lo, mhi=key(hi), mlo=key(lo), y1=key(hi)),
            "text": T("story.map.text", y1=key(hi)), "facts": f, "data": data,
            "claim": {"num": f"fact:{key(hi)}", "head": T("story.map.claim")}, "notes": [], "members": True, "last": key(hi),
            "anns": [note("mrange", "story.note.map.range" + "_x" * mx, hi=hi, lo=lo, mx="mx"), compared(q, f, "second", "story.note.map.second", key(second), key(second), key(lo), at[second], at[lo], only_up=True, r=lo, c=second)],
            "score": round(size * surprise * sturdy, 4),
            "why": {"size": round(size, 3), "surprise": round(surprise, 3), "sturdy": round(sturdy, 3), "gradient": round(gradient, 3), "higher": best[1]},
            "summary": "the members' values on a map, filled by value: where the high ones lie"}, None


def halves(q, at):
    """(gap, side) of the members' values split at the median longitude and at the median latitude: the larger gap in the means of the
    upper half less the lower, and which side is higher ("east", "west", "north", "south"); (0.0, None) when the values do not differ."""
    best = (0.0, None)
    for axis, east in ((0, "east"), (1, "north")):
        order = sorted(at, key=lambda c: (q.points[c][axis], c)); half = len(order) // 2
        a, b = order[:half], order[-half:]
        gap = sum(at[c] for c in b) / len(b) - sum(at[c] for c in a) / len(a)
        if abs(gap) > abs(best[0]): best = (gap, east if gap > 0 else ("west" if axis == 0 else "south"))
    return best


def angle_movers(q):
    ends = common_ends(q)
    if not ends: return None, "fewer than two members with two common years"
    y0, y1 = ends
    if len(q.panel) < DOTS_MIN: return None, f"fewer than {DOTS_MIN} members"
    ch = {c: s[y1][0] - s[y0][0] for c, s in q.panel.items()}
    big = max(ch, key=lambda c: (abs(ch[c]), c))
    if ch[big] == 0: return None, "no member moved"
    other = min(ch, key=lambda c: (ch[c], c)) if ch[big] > 0 else max(ch, key=lambda c: (ch[c], c))   # the far end of the order
    if other == big: return None, "every member changed alike"
    if ch[other] == 0: return None, "the member at the other end did not move"
    order = sorted(ch, key=lambda c: (-ch[c], c))
    kept = order if len(order) <= DOTS_MAX else order[:DOTS_MAX // 2] + order[-(DOTS_MAX // 2):]
    whole = q.whole if q.wseries and y0 in q.wseries and y1 in q.wseries else None
    key0, key1 = (lambda c: f"mv_a_{c.lower()}"), (lambda c: f"mv_b_{c.lower()}")
    f, rows, vals = {}, [], []
    for c in kept + ([whole] if whole else []):
        s_ = q.wseries if c == whole else q.panel[c]
        f[key0(c)], f[key1(c)] = q.value(c, y0), q.value(c, y1)
        rows.append({"code": c, "a": s_[y0][1], "b": s_[y1][1], "a_text": lab(q, f, key0(c)), "b_text": lab(q, f, key1(c))})
        vals += [s_[y0][0], s_[y1][0]]
    span = max(vals) - min(vals)
    if span <= 0: return None, "every value is the same"
    def amount(code, name):  # a change as its size, the larger value less the smaller (the words say which way it went); True when it rose
        up = (q.wseries if code == whole else q.panel[code])[y1][0] > (q.wseries if code == whole else q.panel[code])[y0][0]
        f[name] = {"op": "minus", "a": key1(code) if up else key0(code), "b": key0(code) if up else key1(code), "fmt": q.change}
        return up
    members = sorted(q.panel)
    mch = sum(ch.values()) / len(ch)   # the members' mean change: the mean at the last year less the mean at the first (every member has both)
    avg = {"mv_m0": q.mean(members, y0), "mv_m1": q.mean(members, y1)}
    def mean_key(up):  # the members' mean change the way `up` says, as a fact (its size, op minus of the two means), the means declared with it
        key = "mv_mup" if up else "mv_mdn"
        f.update(avg); f[key] = {"op": "minus", "a": "mv_m1" if up else "mv_m0", "b": "mv_m0" if up else "mv_m1", "fmt": q.change}
        return key
    mean_moved = len(members) >= MEAN_MIN and printed(q, abs(mch), q.change) != 0   # a mean change a note can print and stand on
    def vs_avg(code, name, base, up):  # the note on a member's change (fact `name`, its size) against the members' mean change the same way
        if mean_moved and (mch > 0) != up and f"{base}_opp" in WD.WORDS:
            # the mean went the other way: no multiple of it (it would mislead); the note says the mean's own change the other way
            return note(name, f"{base}_opp", c=code, m=mean_key(not up))
        key = "mv_mup" if up else "mv_mdn"
        facts = {**avg, key: {"op": "minus", "a": "mv_m1" if up else "mv_m0", "b": "mv_m0" if up else "mv_m1", "fmt": q.change}}
        return to_average(q, f, base, name, abs(ch[code]), mch if up else -mch, key, facts, len(members), c=code)
    def whole_note(up):  # the whole's change (fact mv_dw) against the members' mean change: how much more or less the same way, else
        # (the mean went the other way) the mean's own change; the plain note where no mean stands or the gap prints as 0
        base = "story.note.mv.whole_up" if up else "story.note.mv.whole_down"
        if not mean_moved: return note("mv_dw", base, w=whole)
        if (mch > 0) != up: return note("mv_dw", f"{base}_opp", w=whole, m=mean_key(not up))
        gap = abs(q.wseries[y1][0] - q.wseries[y0][0]) - abs(mch)
        if printed(q, abs(gap), q.change) == 0: return note("mv_dw", base, w=whole)
        key = mean_key(up)
        f["mv_gw"] = {"op": "minus", "a": "mv_dw" if gap > 0 else key, "b": key if gap > 0 else "mv_dw", "fmt": q.change}
        return note("mv_dw", f"{base}_{'more' if gap > 0 else 'less'}", w=whole, m=key, d="mv_gw")
    other_up = amount(other, "mv_do")
    kind = {(True, True): "up_least", (True, False): "down_most", (False, False): "down_least", (False, True): "up_most"}[(ch[big] > 0, other_up)]
    anns = [vs_avg(other, "mv_do", f"story.note.mv.{kind}", other_up)]
    if whole:
        anns.append(whole_note(amount(whole, "mv_dw")))
    else:
        lead = max(q.panel, key=lambda c: (q.panel[c][y0][0], c))
        if lead in kept and lead not in (big, other) and ch[lead] != 0:
            lead_up = amount(lead, "mv_dl")
            anns.append(vs_avg(lead, "mv_dl", "story.note.mv.lead_up" if lead_up else "story.note.mv.lead_down", lead_up))
    data = {"title": SW(q.head_name), "unit": q.unit, "name_kind": "place", "rows": rows,
            "periods": [f"period:{q.table}:{y0}", f"period:{q.table}:{y1}"], "accent": [big, other], "footnote": ST("story.mv.foot", y0=key0(big), y1=key1(big))}
    if whole: data["ref"] = whole
    if len(kept) < len(order): data["omit"] = ST("story.mv.omit")
    start_pos = sorted(q.panel, key=lambda c: (-q.panel[c][y0][0], c)).index(big) / max(len(q.panel) - 1, 1)   # 0 = the biggest mover began highest
    size = clamp((max(ch.values()) - min(ch.values())) / span)
    surprise = clamp(0.3 + 0.7 * start_pos)
    sturdy = clamp(len(q.panel) / 12) * clamp((int(y1) - int(y0)) / 8)
    f["mv_dbig"] = {"op": "minus", "a": key1(big), "b": key0(big), "fmt": q.change}
    ill = illus_tally(q, {c: q.panel[c][y1][0] for c in kept}, y1)   # the dots' last values (the members the picture draws)
    if ill: q.illus["movers"] = ill
    big_items = [{"fact": key0(big), "label": {"word": "story.big.now", "name": big, "year": {"src": f"fact:{key0(big)}.t.y"}}},
                 {"fact": key1(big), "label": {"word": "story.big.now", "name": big, "year": {"src": f"fact:{key1(big)}.t.y"}}},
                 {"fact": "mv_dbig", "label": {"word": "story.big.moved", "name": big}}]
    return with_part({"angle": "movers", "shows": [q.shows(f"{y0}-{y1}", "change")], "about": [big, other], "layer": "change_dots", "big": big_items, "kicker": T("story.mv.kicker"),
            # the headline's verb says which way the biggest mover went ("rose to ..., rose most"); the plain "moved" only for no change
            "title": T("story.mv.title" + ("_up" if ch[big] > 0 else "_down" if ch[big] < 0 else ""), big=big, y0=key0(big), y1=key1(big), abig=key0(big), bbig=key1(big)),
            "text": T("story.mv.text_ref" if whole else "story.mv.text", w=whole, y0=key0(big), y1=key1(big)), "facts": f, "data": data,
            "claim": {"num": f"fact:{key1(big)}", "head": T("story.mv.claim", big=big)}, "notes": [], "members": True, "last": key1(big),
            "anns": anns, "score": round(size * surprise * sturdy, 4),
            "why": {"size": round(size, 3), "surprise": round(surprise, 3), "sturdy": round(sturdy, 3), "biggest": big, "started_at": round(start_pos, 3)},
            "summary": "every member's first and last value as two dots on a row, from the largest rise to the largest fall: who moved most"}, strip_two(q, y0, y1, "story.strip.kicker", [big, other])), None


def angle_overtake(q):
    ends = common_ends(q)
    if not ends: return None, "fewer than two members with two common years"
    y0, y1 = ends
    pool = codes_of(q.rows, q.table, q.by, q.fixed)
    want = sorted(set(q.panel) | ({q.whole} if q.wseries else set()))
    if sorted(pool) != want: return None, "the table holds places the page does not name (a rank among them could not be printed)"
    if not SLOPE_MIN <= len(pool) <= SLOPE_MAX: return None, f"fewer than {SLOPE_MIN} or more than {SLOPE_MAX} places"
    ser = {c: (q.wseries if c == q.whole else q.panel[c]) for c in pool}
    if any(y0 not in s_ or y1 not in s_ for s_ in ser.values()): return None, "a place lacks a value at the first or the last year"
    v0, v1 = {c: ser[c][y0][0] for c in pool}, {c: ser[c][y1][0] for c in pool}
    rank = lambda v: {c: 1 + sum(1 for w in v.values() if w > v[c]) for c in v}
    r0, r1 = rank(v0), rank(v1)
    jump = {c: r0[c] - r1[c] for c in pool}      # above 0: rose
    up = max(jump, key=lambda c: (jump[c], -r1[c], c))
    dn = min(jump, key=lambda c: (jump[c], c))
    if jump[up] < 2: return None, "no place rose two ranks or more"
    if jump[dn] >= 0: return None, "no place fell"
    passed = [c for c in pool if v0[c] > v0[up] and v1[c] < v1[up]]
    if not passed: return None, "the riser passed no one (its rank rose through the others' falls alone)"
    over = min(passed, key=lambda c: (r0[c], c))   # the highest-ranked place at the start that it passed
    codes = sorted(pool)
    cross = sum(1 for i, a in enumerate(codes) for b in codes[i + 1:] if (v0[a] - v0[b]) * (v1[a] - v1[b]) < 0)
    pairs = len(pool) * (len(pool) - 1) / 2
    ka, kb = (lambda c: f"ot_a_{c.lower()}"), (lambda c: f"ot_b_{c.lower()}")
    pos = lambda c, y: {"op": "position", "table": q.table, "filter": q.fixed, "by": q.by, "code": c, "time": y, "fmt": "n"}
    f, rows = {}, []
    for c in pool:
        f[ka(c)], f[kb(c)] = pos(c, y0), pos(c, y1)
        rows.append({"code": c, "a": ser[c][y0][1], "b": ser[c][y1][1], "a_rank": f"fact:{ka(c)}", "b_rank": f"fact:{kb(c)}"})
    f["ot_y0"], f["ot_y1"] = q.value(up, y0), q.value(up, y1)   # the two years the title and the key name
    f["ot_rise"] = {"op": "minus", "a": ka(up), "b": kb(up), "fmt": "n"}
    f["ot_fall"] = {"op": "minus", "a": kb(dn), "b": ka(dn), "fmt": "n"}
    # the notes against the places' average rank move (each place's move in size, 0 for one that kept its rank): the moves of the places
    # that moved (the riser's and the faller's are ot_rise and ot_fall) summed one by one (op plus), over the number of places. That
    # number is the rank of the place alone at the bottom at the first year (else the last): a position fact the slope already prints,
    # layer 1 rechecks it from the rows (no count of places, op n, which it cannot). Tied at the bottom both years: no average, the
    # plain notes.
    mk = lambda c: "ot_rise" if c == up else "ot_fall" if c == dn else f"ot_m_{c.lower()}"
    moved = [c for c in codes if jump[c] != 0]
    avg, total = {}, mk(moved[0])
    for c in moved:
        if c not in (up, dn): avg[mk(c)] = {"op": "minus", "a": ka(c) if jump[c] > 0 else kb(c), "b": kb(c) if jump[c] > 0 else ka(c), "fmt": "n"}
    for i, c in enumerate(moved[1:], 1):
        avg[f"ot_s{i}"] = {"op": "plus", "a": total, "b": mk(c), "fmt": "n"}; total = f"ot_s{i}"
    count = next((k(c) for r, k in ((r0, ka), (r1, kb)) for c in codes if r[c] == len(pool)), None)
    avg["ot_avg"] = {"op": "times", "a": total, "b": count, "fmt": q.fmts["times"]}
    move = sum(abs(j) for j in jump.values()) / len(pool)
    anns = [to_average(q, f, base, name, abs(jump[c]), move, "ot_avg", avg, len(pool) if count else 0, c=c, a=ka(c), b=kb(c))
            for base, name, c in (("story.note.ot.fall", "ot_fall", dn), ("story.note.ot.rise", "ot_rise", up))]
    data = {"title": SW(q.head_name), "unit": q.unit, "name_kind": "place", "rows": rows,
            "periods": [f"period:{q.table}:{y0}", f"period:{q.table}:{y1}"], "accent": [up, dn], "footnote": ST("story.ot.foot")}
    if q.wseries: data["ref"] = q.whole
    size = clamp(cross / pairs * 4)
    surprise = clamp(0.3 + 0.7 * jump[up] / (len(pool) / 3))
    sturdy = clamp(len(pool) / 16) * clamp((int(y1) - int(y0)) / 8)
    ill = illus_tally(q, {c: v1[c] for c in pool if c != q.whole}, y1)   # the places' last values (the whole is the reference, not a member)
    if ill: q.illus["overtake"] = ill
    big_items = [{"fact": "ot_rise", "label": {"word": "story.big.ot_rise", "name": up}}, {"fact": "ot_fall", "label": {"word": "story.big.ot_fall", "name": dn}},
                 {"fact": kb(up), "label": {"word": "story.big.rank_at", "name": up, "year": {"src": "fact:ot_y1.t.y"}}}]
    return with_part({"angle": "overtake", "shows": [q.shows(f"{y0}-{y1}", "rank_change")], "about": [up, dn, over], "layer": "rank_slope", "kicker": T("story.ot.kicker"), "big": big_items,
            "title": T("story.ot.title", up=up, over=over, y0="ot_y0", y1="ot_y1", u0=ka(up), u1=kb(up)),
            "text": T("story.ot.text_ref" if q.wseries else "story.ot.text", w=q.whole, y0="ot_y0", y1="ot_y1"), "facts": f, "data": data,
            "claim": {"num": "fact:ot_rise", "head": T("story.ot.claim", up=up)}, "notes": [], "members": True, "last": "ot_y1",
            "anns": anns,
            "score": round(size * surprise * sturdy, 4),
            "why": {"size": round(size, 3), "surprise": round(surprise, 3), "sturdy": round(sturdy, 3), "crossings": cross, "pairs": int(pairs),
                    "riser": up, "rose": jump[up], "faller": dn, "fell": -jump[dn]},
            "summary": "every place's rank at the first and the last year, joined: who rose, who fell, whom the riser passed"}, strip_two(q, y0, y1, "story.strip.kicker", [up, dn])), None


def angle_tiles(q):
    if not q.points: return None, "the request gives no points for the members"
    members = {c: s_ for c, s_ in q.panel.items() if c in q.points}
    if len(members) < TILE_MIN: return None, f"fewer than {TILE_MIN} members with a point"
    if len(members) > TILE_MAX: return None, f"more than {TILE_MAX} members (the tiles would not fit one picture)"
    years = set.intersection(*(set(s_) for s_ in members.values()))
    if not years: return None, "no year in which every member with a point has a value"
    if len({tuple(q.points[c]) for c in members}) < len(members): return None, "two members share one point"
    y = max(years)
    at = {c: s_[y][0] for c, s_ in members.items()}
    hi = max(at, key=lambda c: (at[c], c)); lo = min(at, key=lambda c: (at[c], c))
    if at[hi] <= at[lo]: return None, "every member holds the same value"
    rng = at[hi] - at[lo]
    gap, side = halves(q, at)
    gradient = clamp(abs(gap) / rng)
    key = lambda c: f"tl_{c.lower()}"
    f = {key(c): q.value(c, y) for c in members}
    f["trange"] = {"op": "minus", "a": key(hi), "b": key(lo), "fmt": q.change}
    tk = "story.tl.title_" + (side if gradient >= 0.2 else "plain") + plain_ends(at[hi], at[lo])
    data = {"title": SW(q.head_name), "unit": q.unit, "name_kind": "place",
            "cells": [{"code": c, "at": list(q.points[c]), "value": members[c][y][1], "text": lab(q, f, key(c))} for c in sorted(members)],
            "ends": {"lo": lab(q, f, key(lo)), "hi": lab(q, f, key(hi))}, "footnote": ST("story.tl.foot")}
    tx = ratio(q, f, "tx", key(hi), key(lo), at[hi], at[lo])
    anns = [note("trange", "story.note.tl.range" + "_x" * tx, hi=hi, lo=lo, tx="tx")]
    if q.whole and y in q.wseries:
        f["tl_whole"] = q.value(q.whole, y)
        anns.append(compared(q, f, "whole", "story.note.tl.whole", "tl_whole", "tl_whole", key(lo), q.wseries[y][0], at[lo], only_up=True, r=lo, w=q.whole))
    n = len(members)
    ill = illus_tally(q, at, y)
    if ill: q.illus["tiles"] = ill
    crowd = clamp((n - 8) / 16)      # a crowd of members is what a map hides; 8 members 0, 24 or more 1
    size = clamp(rng / max(abs(at[hi]), 1e-9))
    surprise = clamp(0.3 + 0.7 * gradient)
    sturdy = clamp(n / 20)
    big_items = [{"fact": key(hi), "label": {"word": "story.big.hi", "name": hi, "year": {"src": f"fact:{key(hi)}.t.y"}}},
                 {"fact": key(lo), "label": {"word": "story.big.lo", "name": lo, "year": {"src": f"fact:{key(lo)}.t.y"}}},
                 {"fact": "trange", "label": {"word": "story.big.range"}}]
    return {"angle": "tiles", "shows": [q.shows(y, "map")], "about": [hi, lo], "layer": "tile_map", "big": big_items, "kicker": T("story.tl.kicker"), "title": T(tk, hi=hi, lo=lo, thi=key(hi), tlo=key(lo), y1=key(hi)),
            "text": T("story.tl.text", y1=key(hi)), "facts": f, "data": data,
            "claim": {"num": f"fact:{key(hi)}", "head": T("story.tl.claim")}, "notes": [], "members": True, "last": key(hi),
            "anns": anns, "score": round(size * surprise * sturdy * (0.8 + 0.4 * crowd), 4),
            "why": {"size": round(size, 3), "surprise": round(surprise, 3), "sturdy": round(sturdy, 3), "gradient": round(gradient, 3), "higher": side,
                    "crowd": round(crowd, 3)},
            "summary": "the members as equal tiles laid by direction, filled by value: which side holds the high ones"}, None


def strip_two(q, y0, y1, kicker_key, lead):
    """A dot_strip section (an extra part) of every member at the first and the last year (two period rows, knob periods 2), the
    members' simple mean at the last year and the registered target as rules: who is past the line, and how the field moved. Its
    facts each member's two values (ds0_*, ds1_*) and the mean (ds_mean); None with fewer than four members holding both years."""
    members = sorted(c for c, s_ in q.panel.items() if y0 in s_ and y1 in s_)
    if len(members) < 4: return None
    f, rows = {}, []
    for c in members:
        k0, k1 = f"ds0_{c.lower()}", f"ds1_{c.lower()}"
        f[k0], f[k1] = q.value(c, y0), q.value(c, y1)
        rows.append({"code": c, "a": q.panel[c][y1][1], "a_text": f"fact:{k1}.n", "b": q.panel[c][y0][1], "b_text": f"fact:{k0}.n"})
    f["ds_mean"] = q.mean(members, y1)
    refs = [{"kind": "mean", "text": "fact:ds_mean.n"}]
    tr = q.target_ref()
    if tr:
        f.update(tr[0]); refs.append({**tr[1], "text": "fact:goal.n"})
    k0, k1 = f"ds0_{members[0].lower()}", f"ds1_{members[0].lower()}"
    data = {"title": SW(q.head_name), "unit": q.unit, "name_kind": "place", "rows": rows,
            "scale": float(q.defs.get(q.fmts["value"], {}).get("scale", 1)),
            "periods": [f"period:{q.table}:{y0}", f"period:{q.table}:{y1}"], "refs": refs, "footnote": ST("story.risk.simple_mean")}
    if lead: data["lead"] = [c for c in lead if c in members]
    if not tr: data["legend"] = "dot.legend_plain"   # the page's legend line names no target the strip does not draw (story.py)
    return f, {"layer": "dot_strip", "shows": [q.shows(f"{y0}-{y1}", "change"), q.shows(y1, "rank")], "data": data, "style": {"dot_strip": {"periods": 2, "lead_set": "given" if lead else "both"}}, "kicker": T(kicker_key),
               "title": T("story.strip.title", y1=k1, m="ds_mean"), "text": T("story.strip.text", y0=k0, y1=k1)}


def grid_part(q, y, members):
    """A unit_grid section (an extra part): one glyph a member at year y, lit when the member is under the registered target
    (rule lt, the target's bare number) when some are and some are not, else among the five lowest (rule bottom 5). No count of
    the lit glyphs is printed (no op of layer 1 recomputes it; the leaf rechecks each flag against its cell and the rule): the title
    leans on the lowest member's value and, under a target, its gap to it. None with fewer than eight members."""
    at = {c: q.panel[c][y][0] for c in members if y in q.panel[c]}
    if len(at) < 8: return None
    g, tr = q.goal(), q.target_ref()
    scale = float(q.defs.get(q.fmts["value"], {}).get("scale", 1))
    lo = min(at, key=lambda c: (at[c], c))
    f = {"ug_lo": q.value(lo, y)}
    if g and tr and any(v < g[0] for v in at.values()) and any(v >= g[0] for v in at.values()):
        lit = sorted(c for c, v in at.items() if v < g[0])
        f.update(tr[0])
        f["ug_gap"] = {"op": "minus", "a": "goal", "b": "ug_lo", "fmt": q.change}
        rule = {"op": "lt", "ref": "fact:goal.n"}
        key, title = {"lit": ST("story.grid.lit_below"), "unlit": ST("story.grid.unlit")}, T("story.grid.title_below", lo=lo, w=(q.target or {}).get("filter", {}).get(q.by))
    else:
        order = sorted(at, key=lambda c: (at[c], c))
        if at[order[4]] == at[order[5]]: return None   # the cut falls inside a tie
        lit = sorted(order[:5])
        rule = {"op": "bottom", "k": 5}
        key, title = {"lit": ST("story.grid.lit_bottom"), "unlit": ST("story.grid.unlit")}, T("story.grid.title_bottom", lo=lo)
    data = {"title": SW(q.head_name), "unit": q.unit, "name_kind": "place", "mode": "flag", "scale": scale,
            "members": [{"code": c, "value": q.panel[c][y][1], "flag": c in lit} for c in sorted(at)], "rule": rule,
            "key": key}
    return f, {"layer": "unit_grid", "shows": [q.shows(y, "rank")], "data": data, "style": {"unit_grid": {"sort": "flag_first"}}, "kicker": T("story.grid.kicker"),
               "title": title, "text": T("story.grid.text")}


def with_part(c, part):
    """The candidate with an extra part (its facts declared with the candidate's), or as it was when the part does not stand."""
    if part:
        c["facts"].update(part[0]); c.setdefault("more", []).append(part[1])
    return c


def printed(q, x, fmt):
    """x as its format prints it (scale, places), for telling two printed numbers apart."""
    d = q.defs.get(fmt, {})
    return round(x * float(d.get("scale", 1)), int(d.get("dec", 0)))


def cell_src(q, key, fmt):
    """The ledger entry a winners_losers row's before/after cell prints: the fact itself when its format puts at most a percent sign
    after the number, else the fact's bare number (fact:<key>.n): that leaf reads a plain number there, and the words that carry the
    unit (a pace's unit word) stay in the sentences and the change cell, which print the fact in its own format."""
    suffix = (q.defs.get(fmt, {}).get("suffix") or "").strip()
    return f"fact:{key}" if suffix in ("", "%") else f"fact:{key}.n"


def lab(q, f, key):
    """The ledger entry a label next to a mark inside a chart prints: the number alone (cell_src) when the fact's format puts a unit
    after it, since the chart's head states the unit once (the leaf's "unit"); a percent sign stays. The fact's format is its
    declaration's in f, else the page's value format."""
    d = f.get(key) if isinstance(f, dict) else None
    return cell_src(q, key, (d.get("fmt") if isinstance(d, dict) else None) or q.fmts["value"])


def pace_split(q, ys, m):
    """(from, to, event or None) of the pace's two windows over the years ys and the mean m: the first request event whose years
    lie inside and leave PACE_WIN years on each side, else the shared split year with the largest difference of the two paces
    (the earlier on a tie); None when no split leaves PACE_WIN years on each side."""
    y0, y1 = int(ys[0]), int(ys[-1])
    for ev in q.events:
        a, b = str(ev["from"]), str(ev["to"])
        if a in ys and b in ys and int(a) <= int(b) and int(a) - y0 + 1 >= PACE_WIN and y1 - int(b) + 1 >= PACE_WIN:
            return a, b, ev
    best = None
    for s_ in ys:
        s = int(s_)
        if s - y0 + 1 < PACE_WIN or y1 - s + 1 < PACE_WIN: continue
        d = abs((m[ys[-1]] - m[s_]) / (y1 - s) - (m[s_] - m[ys[0]]) / (s - y0))
        if best is None or d > best[0]: best = (d, s_)
    return (best[1], best[1], None) if best else None


def angle_pace(q):
    if len(q.panel) < DOTS_MIN: return None, f"fewer than {DOTS_MIN} members"
    common = set.intersection(*(set(s_) for s_ in q.panel.values()))
    ys = run_years({y: 1 for y in sorted(common)}) if common else []
    if len(ys) < PACE_MIN: return None, f"the members share fewer than {PACE_MIN} years in a row"
    pool = sorted(q.panel)
    m = {y: sum(q.panel[c][y][0] for c in pool) / len(pool) for y in ys}
    split = pace_split(q, ys, m)
    if not split: return None, f"no split leaves {PACE_WIN} years on each side"
    a_, b_, ev = split
    y0, y1 = ys[0], ys[-1]
    rate = lambda v, x, y: (v[y] - v[x]) / (int(y) - int(x))
    pa, pb = rate(m, y0, a_), rate(m, b_, y1)
    dch = {c: rate({y: q.panel[c][y][0] for y in ys}, b_, y1) - rate({y: q.panel[c][y][0] for y in ys}, y0, a_) for c in pool}
    paces = {c: (rate({y: q.panel[c][y][0] for y in ys}, y0, a_), rate({y: q.panel[c][y][0] for y in ys}, b_, y1)) for c in pool}
    fast = [c for c in pool if paces[c][1] > paces[c][0]]
    slow = [c for c in pool if paces[c][1] < paces[c][0]]
    up = pb > pa
    f = {"pc_m0": q.mean(pool, y0), "pc_ma": q.mean(pool, a_), "pc_mb": q.mean(pool, b_), "pc_m1": q.mean(pool, y1),
         "pc_a": {"op": "per_year", "a": "pc_ma", "b": "pc_m0", "fmt": q.change},
         "pc_b": {"op": "per_year", "a": "pc_m1", "b": "pc_mb", "fmt": q.change},
         "pc_d": {"op": "minus", "a": "pc_b", "b": "pc_a", "fmt": q.change},
         # the windows' years as facts of their own (the split's two years: the era band a later layer shades reads them)
         "pc_y0": q.value(pool[0], y0), "pc_from": q.value(pool[0], a_), "pc_to": q.value(pool[0], b_), "pc_y1": q.value(pool[0], y1),
         }
    if pa > 0 and pb > 0: f["pc_x"] = {"op": "times", "a": "pc_b", "b": "pc_a", "fmt": q.fmts["times"]}
    if a_ == b_: f["pc_mb"] = f["pc_ma"]
    cols = {"up": [], "down": []}
    if printed(q, pa, q.change) != printed(q, pb, q.change):   # the mean's own row, in its column
        cols["up" if up else "down"].append({"label": ST("story.ref.mean"), "a": cell_src(q, "pc_a", q.change), "b": cell_src(q, "pc_b", q.change),
                                             "change": [{"src": "fact:pc_d"}]})
    for col, cs in (("up", sorted(fast, key=lambda c: (-dch[c], c))), ("down", sorted(slow, key=lambda c: (dch[c], c)))):
        for c in cs:
            if len(cols[col]) >= ROWS_MAX: break
            ra, rb = paces[c]
            if printed(q, ra, q.change) == printed(q, rb, q.change): continue   # the leaf reads the direction off the printed numbers
            k = c.lower()
            for y in (y0, a_, b_, y1): f[f"pv_{k}_{y}"] = q.value(c, y)
            f[f"pa_{k}"] = {"op": "per_year", "a": f"pv_{k}_{a_}", "b": f"pv_{k}_{y0}", "fmt": q.change}
            f[f"pb_{k}"] = {"op": "per_year", "a": f"pv_{k}_{y1}", "b": f"pv_{k}_{b_}", "fmt": q.change}
            f[f"pd_{k}"] = {"op": "minus", "a": f"pb_{k}", "b": f"pa_{k}", "fmt": q.change}
            cols[col].append({"label": [{"name": c}], "a": cell_src(q, f"pa_{k}", q.change), "b": cell_src(q, f"pb_{k}", q.change), "change": [{"src": f"fact:pd_{k}"}]})
    rows_ok = bool(cols["up"] and cols["down"])   # the members' rows stand only when both columns hold one (the leaf refuses an empty one)
    # the pair of glyphs: an area holds no value below 0, the larger prints above 0, the smaller at least six px across (or a point at 0)
    pa_p, pb_p = printed(q, pa, q.change), printed(q, pb, q.change)
    pair_ok = pa_p >= 0 and pb_p >= 0 and max(pa_p, pb_p) > 0 and (min(pa_p, pb_p) == 0 or 110 * math.sqrt(min(pa_p, pb_p) / max(pa_p, pb_p)) >= 6)
    if not rows_ok and not pair_ok: return None, "every member changed pace the same way and a pace is below 0 (no picture stands)"
    tone = ("fast" if up else "slow") if pa >= 0 and pb >= 0 else "plain"
    bind = {"ev": ev["name_zh"]} if ev else {}
    title = T(f"story.pace.title_ev_{tone}" if ev else f"story.pace.title_{tone}", **bind)
    text = T("story.pace.text")
    rows_data = {"up": {"title": ST("story.pace.up"), "rows": cols["up"]}, "down": {"title": ST("story.pace.down"), "rows": cols["down"]},
                 "footnote": ST("story.pace.foot")}
    anns = [note("pc_d", "story.note.pace.diff")] + ([note("pc_x", "story.note.pace.ratio")] if "pc_x" in f else [])
    rows_part = None
    if rows_ok:   # the members whose pace changed most each way, before -> after (a section of its own beside the pair)
        top = max(fast, key=lambda c: (dch[c], c)) if fast else None
        k = top.lower() if top and f"pa_{top.lower()}" in f else None
        rows_part = {"layer": "winners_losers", "shows": [q.shows(f"{y0}-{y1}", "pace_members")], "data": rows_data, "kicker": T("story.pace.rows_kicker"),
                     "title": T("story.pace.rows_title", c=top, a=f"pa_{k}", b=f"pb_{k}") if k else T("story.pace.rows_title_mean"),
                     "text": T("story.pace.rows_text")}
    if pair_ok:   # the two paces as two glyphs whose area is the pace (glyph_row: a derived fact's bare number is its value)
        suffix = (q.defs.get(q.change, {}).get("suffix") or "").strip()
        layer, data = "glyph_row", {"title": ST("story.pace.pair_title"), "unit": SW(suffix) if suffix else q.unit, "accent": "after", "footnote": ST("story.risk.simple_mean"),
                                    "items": [{"code": "before", "name": ST("story.pace.pair_before"), "value": "fact:pc_a.n", "text": "fact:pc_a.n"},
                                              {"code": "after", "name": ST("story.pace.pair_after"), "value": "fact:pc_b.n", "text": "fact:pc_b.n"}]}
        more, fallback = ([rows_part] if rows_part else []), ({"layer": "winners_losers", "data": rows_data, "anns": anns,
                                                              "shows": [q.shows(f"{y0}-{y1}", "pace"), q.shows(f"{y0}-{y1}", "pace_members")]} if rows_ok else None)
        shows = [q.shows(f"{y0}-{y1}", "pace")]
    else:
        layer, data, more, fallback = "winners_losers", rows_data, [], None
        shows = [q.shows(f"{y0}-{y1}", "pace"), q.shows(f"{y0}-{y1}", "pace_members")]
    # hook (era_bands, with the events registry): the windows' years are the facts pc_y0, pc_from, pc_to and pc_y1
    big = [{"fact": "pc_a", "label": {"word": "story.big.pace_a", "year": {"src": "fact:pc_from.t.y"}}},
           {"fact": "pc_b", "label": {"word": "story.big.pace_b", "year": {"src": "fact:pc_to.t.y"}}},
           {"fact": "pc_x", "label": {"word": "story.big.pace_x"}} if "pc_x" in f else {"fact": "pc_d", "label": {"word": "story.big.pace_d"}}]
    risks = [ST("story.risk.pace_event", **bind) if ev else ST("story.risk.pace_split"), ST("story.risk.simple_mean")]
    size = clamp(abs(pb - pa) / max(abs(pa), abs(pb), 1e-9))
    surprise = clamp(0.3 + 1.4 * min(len(fast), len(slow)) / len(pool))
    sturdy = clamp(len(ys) / 15) * clamp(len(pool) / 12)
    ill = illus_series(q, m, int(b_))   # the members' mean a year, the years after the split lit
    if ill: q.illus["pace"] = ill
    asked = q.asked("pace")
    score = size * surprise * sturdy + (ASKED_BOOST if asked else 0)
    return {"angle": "pace", "shows": shows, "about": [top] if rows_part and top else [], "layer": layer, "kicker": T("story.pace.kicker"), "title": title, "text": text, "facts": f,
            "data": data, "more": more, "fallback": fallback, "big": big, "era": {"from": "pc_from", "to": "pc_to"}, "claim": {"num": "fact:pc_b", "head": T("story.pace.claim_ev" if ev else "story.pace.claim", **bind)},
            "notes": [], "risks": risks, "members": True, "last": "pc_y1",
            "anns": anns,
            "score": round(score, 4),
            "why": {"size": round(size, 3), "surprise": round(surprise, 3), "sturdy": round(sturdy, 3), "from": a_, "to": b_,
                    "event": ev.get("id") if ev else None, "faster": len(fast), "slower": len(slow), "asked": asked},
            "summary": "the members' average pace a year before and after a split year: did it speed up or slow down, and which members changed most"}, None


def illus_groups(q, kept, order, at, allm):
    """{"groups", "rule", "declared"} of the highest and the lowest group (by mean, the page's own two): each one's members at the page's
    year, lit when at or above the mean of every grouped member (the section's reference line); None unless the pair stands."""
    pair = [order[0], order[-1]]
    groups = []
    for gid in pair:
        ms = illus_members(q, {c: at[c] for c in kept[gid][1]})
        if ms is None or len(ms) > 30: return None
        groups.append({"key": gid, "name": kept[gid][0], "members": ms})
    ref = illus_value(q, allm)
    lit = {g["key"]: len(illus_lit(g["members"], "ge", ref)) for g in groups}
    if not 0 < sum(lit.values()) < sum(len(g["members"]) for g in groups): return None
    return {"groups": groups, "rule": {"op": "ge", "ref": ref},
            "declared": {"groups": {g["key"]: {"count": lit[g["key"]], "total": len(g["members"])} for g in groups}}}


def angle_groups(q):
    if not q.groups: return None, "the request gives no groups of the members"
    kept, left = {}, []
    for g in q.groups:
        cs = [c for c in g["members"] if c in q.panel]
        if len(cs) >= GROUP_MEMBERS: kept[g["id"]] = (g["name_zh"], cs)
        else: left += cs
    if len(kept) < GROUPS_MIN: return None, f"fewer than {GROUPS_MIN} groups of {GROUP_MEMBERS} members or more"
    pool = sorted(c for _, cs in kept.values() for c in cs)
    years = set.intersection(*(set(q.panel[c]) for c in pool))
    if not years: return None, "no year in which every grouped member has a value"
    y = max(years)
    at = {c: q.panel[c][y][0] for c in pool}
    gm = {gid: sum(at[c] for c in cs) / len(cs) for gid, (_, cs) in kept.items()}
    allm = sum(at.values()) / len(at)
    hi = max(gm, key=lambda g: (gm[g], g)); lo = min(gm, key=lambda g: (gm[g], g))
    if gm[hi] <= gm[lo]: return None, "every group holds the same mean"
    rng = {gid: max(at[c] for c in cs) - min(at[c] for c in cs) for gid, (_, cs) in kept.items()}
    wide = max(rng, key=lambda g: (rng[g], g))
    wcs = kept[wide][1]
    whi = max(wcs, key=lambda c: (at[c], c)); wlo = min(wcs, key=lambda c: (at[c], c))
    gk = lambda gid: f"gp_{gid.lower()}"
    f = {gk(gid): q.mean(cs, y) for gid, (_, cs) in kept.items()}
    f["gp_all"] = q.mean(pool, y)
    f["gp_gap"] = {"op": "minus", "a": gk(hi), "b": gk(lo), "fmt": q.change}
    f["gp_y"] = q.value(pool[0], y)
    f["gp_vhi"], f["gp_vlo"] = q.value(whi, y), q.value(wlo, y)
    cols = {"up": [], "down": []}
    for gid in sorted(kept, key=lambda g: (-gm[g], g)):
        if printed(q, gm[gid], q.fmts["value"]) == printed(q, allm, q.fmts["value"]): continue
        f[f"gd_{gid.lower()}"] = {"op": "minus", "a": gk(gid), "b": "gp_all", "fmt": q.change}
        col = "up" if gm[gid] > allm else "down"
        if len(cols[col]) < ROWS_MAX:
            cols[col].append({"label": SW(kept[gid][0]), "a": cell_src(q, "gp_all", q.fmts["value"]), "b": cell_src(q, gk(gid), q.fmts["value"]), "change": [{"src": f"fact:gd_{gid.lower()}"}]})
    rows_ok = bool(cols["up"] and cols["down"])
    names = {"hi": kept[hi][0], "lo": kept[lo][0], "wide": kept[wide][0]}
    bind = dict(names, ghi=gk(hi), glo=gk(lo), whi=whi, wlo=wlo, vhi="gp_vhi", vlo="gp_vlo")
    order = sorted(kept, key=lambda g: (-gm[g], g))
    rows_data = {"up": {"title": ST("story.groups.up"), "rows": cols["up"]}, "down": {"title": ST("story.groups.down"), "rows": cols["down"]},
                 "footnote": ST("story.groups.foot")}
    # numbers the title and text do not print; the widest group's lowest member set against that group's own simple mean (compared:
    # the gap in points on a percent measure, else the mean as a multiple of it; the plain note where the two print alike)
    anns = [note("gp_all", "story.note.groups.all"), compared(q, f, "gp_vlo", "story.note.groups.wide", "gp_vlo", "gp_vlo", gk(wide), at[wlo], gm[wide], **bind)]
    scale = float(q.defs.get(q.fmts["value"], {}).get("scale", 1))
    # the group means as glyphs (area = mean, at most fifteen, none below 0, the smallest still six px across at the largest's 110),
    # the mean of every grouped member as the ghost glyph, labelled by the words' table
    glyph_ok = len(order) <= 15 and gm[lo] >= 0 and allm >= 0 and (gm[lo] == 0 or 110 * math.sqrt(gm[lo] / max(gm[hi], allm)) >= 6)
    glyph = {"title": SW(q.head_name), "unit": q.unit, "accent": hi, "scale": 1, "footnote": ST("story.risk.simple_mean"),
             "items": [{"code": gid, "name": SW(kept[gid][0]), "value": f"fact:{gk(gid)}.n", "text": f"fact:{gk(gid)}.n"} for gid in order],
             "ref": {"value": "fact:gp_all.n", "text": "fact:gp_all.n", "label": ST("story.ref.mean")}}
    # the members by group on one axis (dot_strip: a row a group, its own mean a tick), the members' mean (the leaf's own words)
    # and the registered target as rules, the target labelled from the request's target row
    for c in pool: f[f"gv_{c.lower()}"] = q.value(c, y)
    strip = {"title": SW(q.head_name), "unit": q.unit, "name_kind": "place", "scale": scale,
             "rows": [{"code": c, "a": q.panel[c][y][1], "a_text": f"fact:gv_{c.lower()}.n", "group": gid} for gid in order for c in kept[gid][1]],
             "periods": [f"period:{q.table}:{y}"], "groups": [{"id": gid, "label": SW(kept[gid][0]), "mean": f"fact:{gk(gid)}.n"} for gid in order],
             "refs": [{"kind": "mean", "text": "fact:gp_all.n"}], "lead": [whi, wlo], "footnote": ST("story.risk.simple_mean")}
    tr = q.target_ref()
    if tr:
        f.update(tr[0]); strip["refs"].append({**tr[1], "text": "fact:goal.n"})
    else: strip["legend"] = "dot.legend_plain"
    strip_part = {"layer": "dot_strip", "shows": [q.shows(y, "within_groups")], "data": strip, "style": {"dot_strip": {"lead_set": "given"}}, "kicker": T("story.groups.strip_kicker"), "title": T("story.groups.strip_title", **bind),
                  "text": T("story.groups.strip_text")}
    fallback = {"layer": "winners_losers", "data": rows_data, "anns": anns, "shows": [q.shows(y, "group_means")]} if rows_ok else None
    if glyph_ok: layer, data, more = "glyph_row", glyph, [strip_part]
    elif rows_ok: layer, data, more, fallback = "winners_losers", rows_data, [strip_part], None
    else: layer, data, more = "dot_strip", strip, []
    style = strip_part["style"] if layer == "dot_strip" else None
    if layer == "dot_strip": fallback = None
    big = [{"fact": gk(hi), "label": {"word": "story.big.group_hi"}}, {"fact": gk(lo), "label": {"word": "story.big.group_lo"}},
           {"fact": "gp_gap", "label": {"word": "story.big.group_gap"}}]
    risks = [ST("story.risk.simple_mean")]
    risks += [ST("story.risk.groups_moved", c=m["code"], **{"from": m["from_zh"], "to": m["to_zh"]}) for m in q.moved if m["code"] in pool]
    if left: risks.append(ST("story.risk.groups_left", left=sorted(left)))
    values = list(at.values())
    span = max(values) - min(values)
    size = clamp((gm[hi] - gm[lo]) / span) if span > 0 else 0.0
    surprise = clamp(0.3 + 0.7 * min(1.0, rng[wide] / max(gm[hi] - gm[lo], 1e-9) / 2))
    sturdy = clamp(len(kept) / 4) * clamp(len(pool) / 20)
    ill = illus_groups(q, kept, order, at, allm)
    if ill: q.illus["groups"] = ill
    asked = q.asked("groups")
    score = size * surprise * sturdy + (ASKED_BOOST if asked else 0)
    shows = [q.shows(y, "within_groups" if layer == "dot_strip" else "group_means")]
    return {"angle": "groups", "shows": shows, "about": [whi, wlo], "layer": layer, "kicker": T("story.groups.kicker"), "title": T("story.groups.title", **bind),
            "text": T("story.groups.text", **bind), "facts": f, "data": data, "more": more, "fallback": fallback, "big": big, "style": style,
            "claim": {"num": "fact:gp_gap", "head": T("story.groups.claim", **bind)}, "notes": [], "risks": risks, "members": True, "last": "gp_y",
            "anns": anns,
            "score": round(score, 4),
            "why": {"size": round(size, 3), "surprise": round(surprise, 3), "sturdy": round(sturdy, 3), "groups": len(kept),
                    "highest": hi, "lowest": lo, "widest": wide, "asked": asked},
            "summary": "the members compared by named region groups: each group's average, the gap between the highest and the lowest group, and the spread inside a group"}, None


def angle_below(q):
    """Which members are under the line: the members whose value at the last year they share is under the registered target
    (when some are and some are not), else under the whole's value that year, else under the members' simple mean, named
    lowest first (BELOW_NAMES at most in the title) and counted by layer 1 (op count, below: each member's own value under the
    line, recomputed from the rows), drawn as a flag grid lit by the same line (the leaf rechecks each glyph against the line as
    printed). The finding a "which ones" question asks for (words.zh.json story.ask.below): ASKED_BOOST when the question holds
    one of its words. Needs BELOW_MIN members, each with a value that year, and no member between the line and the line as printed."""
    ends = common_ends(q)
    if not ends: return None, "fewer than two members with two common years"
    y = ends[1]
    at = {c: s_[y][0] for c, s_ in q.panel.items() if y in s_}
    if len(at) < BELOW_MIN: return None, f"fewer than {BELOW_MIN} members at the last year they share"
    if set(q.members) - set(at): return None, "a member has no value at the last year the others share (layer 1 could not count it)"
    fd = q.defs.get(q.fmts["value"], {})
    scale, dec = float(fd.get("scale", 1)), int(fd.get("dec", 0))
    under = lambda t: sorted(c for c, v in at.items() if v < t)
    f, line, g, tr = {}, None, q.goal(), q.target_ref()
    if g and tr and 0 < len(under(g[0])) < len(at):
        f.update(tr[0]); line = ("goal", g[0], "goal", (q.target or {}).get("filter", {}).get(q.by))
    elif q.whole and y in q.wseries and 0 < len(under(q.wseries[y][0])) < len(at):
        f["bl_t"] = q.value(q.whole, y); line = ("whole", q.wseries[y][0], "bl_t", q.whole)
    elif 0 < len(under(sum(at.values()) / len(at))) < len(at):
        f["bl_t"] = q.mean(sorted(at), y); line = ("mean", sum(at.values()) / len(at), "bl_t", None)
    if line is None: return None, "every member holds the same value"
    kind, t, tkey, w = line
    lit = under(t)
    # layer 1 counts against the raw line, the grid lights against the line as printed: the two must light the same members
    shown = round(t * scale, dec) / scale
    if under(shown) != lit or any(abs(v - t) <= 1e-9 * max(abs(t), 1.0) for v in at.values()):
        return None, "a member stands between the line and the line as printed"
    order = sorted(lit, key=lambda c: (at[c], c))
    lo, names = order[0], order[:BELOW_NAMES]
    f["bl_n"] = {"op": "count", "a": {"table": q.table, "filter": dict(q.fixed)}, "by": q.by, "time": y, "below": t, "fmt": "n"}
    f["bl_lo"] = q.value(lo, y)
    title = T(f"story.below.title_{kind}", names=names, w=w, t=tkey)
    if len(order) > len(names): title.append(("w", WD.WORDS["story.below.more"]))
    data = {"title": SW(q.head_name), "unit": q.unit, "name_kind": "place", "mode": "flag", "scale": scale,
            "members": [{"code": c, "value": q.panel[c][y][1], "flag": c in lit} for c in sorted(at)],
            "rule": {"op": "lt", "ref": f"fact:{tkey}.n"}, "key": {"lit": ST("story.below.lit"), "unlit": ST("story.grid.unlit")}}
    line_note = {"goal": ("story.ref.target", {"w": w}), "whole": ("story.below.note_whole", {"w": w}), "mean": ("story.ref.mean", {})}[kind]
    big = [{"fact": "bl_n", "label": {"word": "story.big.below_n", "year": {"src": "fact:bl_lo.t.y"}}},
           {"fact": tkey, "label": {"word": f"story.big.below_{kind}", **({"name": w} if kind == "whole" else {}), **({"year": {"src": "fact:goal.t.y"}} if kind == "goal" else {})}},
           {"fact": "bl_lo", "label": {"word": "story.big.lo", "name": lo, "year": {"src": "fact:bl_lo.t.y"}}}]
    share = len(lit) / len(at)
    size = clamp(1 - abs(share - 0.5) * 2 + 0.2)   # a line that splits the field reads as news; one or all under it does not
    surprise = 0.5
    sturdy = clamp(len(at) / 20)
    asked = q.asked("below")
    score = size * surprise * sturdy * 0.5 + (ASKED_BOOST if asked else 0)
    return {"angle": "below", "shows": [q.shows(y, "rank")], "about": names, "layer": "unit_grid", "big": big,
            "kicker": T("story.below.kicker"), "title": title, "text": T("story.below.text", lo=lo), "facts": f, "data": data,
            "style": {"unit_grid": {"sort": "flag_first"}}, "claim": {"num": "fact:bl_n", "head": T(f"story.below.claim_{kind}", w=w)},
            "notes": [], "members": True, "last": "bl_lo", "anns": [{"num": f"fact:{tkey}", "text": ST(line_note[0], **line_note[1])}],
            "score": round(score, 4),
            "why": {"size": round(size, 3), "surprise": surprise, "sturdy": round(sturdy, 3), "line": kind, "under": len(lit), "asked": asked},
            "summary": "which members are under the line (the target, the whole or the members' average): their names and how many"}, None


ANGLES = [angle_path, angle_need, angle_spread, angle_ends, angle_rank, angle_members, angle_map, angle_movers, angle_overtake, angle_tiles, angle_chain, angle_pace, angle_groups, angle_below]


# ---------------------------------------------------------------- the header's big numbers

BIG = "bignums"


def header(q, arc=None):
    """The three big numbers above the thesis, as ({fact key: query}, [bignums item]) or None when the rows give fewer than two.
    By the page's arc (ARCS): "happened" leads with the whole's last value and the step of the year the chain moved most (the
    chain finding's facts), "lagging" with the highest member, the lowest and the first over the second, any other arc as below.
    Each is a fact this declares (keys b_*, and goal where the page runs to a target), each label a word-table key whose fills
    are a place's code or a ledger entry, so no number and no word is written here:
      with a whole and a target the whole can reach: the whole's last value, what is left to the target, and the value the
        best single year's pace reaches at the target year (the path angle's three numbers);
      with a whole and no such target: its last value, its change from the first to the last year (the larger value less the
        smaller, the word saying rose or fell), and the highest member's value over the lowest's at the last year they share;
      with no whole: the highest member's value, the lowest member's, and the first over the second."""
    items, f = [], {}
    when = lambda key: {"src": f"fact:{key}.t.y"}
    if arc == "lagging": return ends_header(q, when)
    if q.wseries and len(run_years(q.wseries)) >= 2:
        ys = run_years(q.wseries)
        first, last = ys[0], ys[-1]
        before, now = q.wseries[first][0], q.wseries[last][0]
        f["b_now"] = q.value(q.whole, last)
        items.append({"fact": "b_now", "label": {"word": "story.big.now", "name": q.whole, "year": when("b_now")}})
        if arc == "happened":   # the step of the year the chain moved most: the chain finding's facts (m_step, m_hi, m_lo, band_y) are the page's
            items.append({"fact": "m_step", "label": {"word": "story.big.step", "year": when("band_y")}})
            return {"b_now": f["b_now"]}, items
        g, best = q.goal(), 0
        if g and len(ys) >= MIN_YEARS and int(g[1]) > int(last) and g[0] > now:
            best = paces(q.wseries)[3]
        if best > 0:
            f["goal"] = g[2]
            f["b_gap"] = {"op": "minus", "a": "goal", "b": "b_now", "fmt": q.change}
            f["b_best"] = {"op": "step_max", "table": q.table, "filter": q.filt(q.whole), "from": first, "to": last, "fmt": q.fmts["value"]}
            f["b_end"] = {"op": "line_at", "start": "b_now", "rate": "b_best", "at": g[1], "fmt": q.fmts["value"]}
            items.append({"fact": "b_gap", "label": {"word": "story.big.gap", "year": when("goal")}})
            items.append({"fact": "b_end", "label": {"word": "story.big.best", "year": when("goal")}})
        else:
            f["b_first"] = q.value(q.whole, first)
            up = now >= before
            f["b_change"] = {"op": "minus", "a": "b_now" if up else "b_first", "b": "b_first" if up else "b_now", "fmt": q.change}
            items.append({"fact": "b_change", "label": {"word": "story.big.rose" if up else "story.big.fell",
                                                        "year": when("b_first"), "to": when("b_now")}})
    ends = common_ends(q)
    if len(items) < 3 and ends:
        y1 = ends[1]
        at = {c: s_[y1][0] for c, s_ in q.panel.items() if y1 in s_}
        if len(at) >= 2:
            hi = max(at, key=lambda c: (at[c], c)); lo = min(at, key=lambda c: (at[c], c))
            f["b_hi"], f["b_lo"] = q.value(hi, y1), q.value(lo, y1)
            if not q.wseries:
                items.append({"fact": "b_hi", "label": {"word": "story.big.hi", "name": hi, "year": when("b_hi")}})
                items.append({"fact": "b_lo", "label": {"word": "story.big.lo", "name": lo, "year": when("b_lo")}})
            if at[lo] > 0 and at[hi] > at[lo]:
                f["b_ratio"] = {"op": "times", "a": "b_hi", "b": "b_lo", "fmt": q.fmts["times"]}
                items.append({"fact": "b_ratio", "label": {"word": "story.big.ratio", "name": hi}})
    items = items[:3]
    if len(items) < 2: return None
    # only the facts an item prints and those they read stay declared
    reads = {"b_gap": ["goal", "b_now"], "b_end": ["b_now", "b_best", "goal"], "b_change": ["b_now", "b_first"], "b_ratio": ["b_hi", "b_lo"]}
    keep = {k for x in items for k in [x["fact"], *reads.get(x["fact"], [])]}
    return {k: v for k, v in f.items() if k in keep}, items


def ends_header(q, when):
    """The "lagging" arc's three numbers: the highest member's value, the lowest's, and the first over the second, at the last
    year the members share; None when fewer than two members share a year."""
    ends = common_ends(q)
    if not ends: return None
    y1 = ends[1]
    at = {c: s_[y1][0] for c, s_ in q.panel.items() if y1 in s_}
    if len(at) < 2: return None
    hi = max(at, key=lambda c: (at[c], c)); lo = min(at, key=lambda c: (at[c], c))
    f = {"b_hi": q.value(hi, y1), "b_lo": q.value(lo, y1)}
    items = [{"fact": "b_hi", "label": {"word": "story.big.hi", "name": hi, "year": when("b_hi")}},
             {"fact": "b_lo", "label": {"word": "story.big.lo", "name": lo, "year": when("b_lo")}}]
    if at[lo] > 0 and at[hi] > at[lo]:
        f["b_ratio"] = {"op": "times", "a": "b_hi", "b": "b_lo", "fmt": q.fmts["times"]}
        items.append({"fact": "b_ratio", "label": {"word": "story.big.ratio", "name": hi}})
    return f, items


def candidates(r):
    q = Req(r)
    out, dropped = [], []
    for fn in ANGLES:
        try:
            c, why = fn(q)
        except Refused as e:
            c, why = None, str(e)
        name = fn.__name__[len("angle_"):]
        if c is None:
            dropped.append({"angle": name, "why": why}); continue
        c["id"] = name
        out.append(c)
    # best first, the angle's order breaks a tie (two angles may name one leaf: compose keeps the first picked)
    out.sort(key=lambda c: -c["score"])
    return q, out[:TOP_K], dropped


# ---------------------------------------------------------------- the story's arc

# A page tells its findings in one of three arcs (works/story-1122/i34-arcs.md, counted over published long-form data stories). The arc is
# the lead finding's (the one the model picked first, "the one that answers the question"), not the data's score: the same rows asked
# three ways give three arcs. Each arc fixes the order of the other findings, the finding it needs besides the lead and, for the
# header's numbers and the closing line, what the page ends on.
#   happened  what happened: the chain finding leads; what moved and who with it; the outlook (path or need) last
#   in_time   will it be in time: the need or path finding leads, the other of the two next; who lags; then the rest
#   lagging   who is dragging: a spread, rank, ends, members, movers, overtake, map or tiles finding leads; the other comparisons; the whole last
ARC_OF = {"chain": "happened", "need": "in_time", "path": "in_time", "spread": "lagging", "rank": "lagging", "ends": "lagging",
          "members": "lagging", "map": "lagging", "movers": "lagging", "overtake": "lagging", "tiles": "lagging",
          "pace": "happened", "groups": "lagging", "below": "lagging"}
RANK_ANGLES = ("rank", "overtake")   # the findings whose section prints ranks (the closing line of the lagging arc speaks of them)
ARC_ORDER = {"happened": ["chain", "pace", "spread", "rank", "members", "ends", "movers", "overtake", "groups", "below", "map", "tiles", "path", "need"],
             "in_time": ["need", "path", "pace", "below", "rank", "spread", "groups", "members", "ends", "movers", "overtake", "map", "tiles", "chain"],
             "lagging": ["below", "groups", "spread", "rank", "ends", "members", "movers", "overtake", "map", "tiles", "pace", "chain", "need", "path"]}
# the findings an arc needs besides its lead (any one of them): the outlook, who lags, the comparison among the members
ARC_NEEDS = {"happened": ("path", "need"), "in_time": ("rank", "spread", "members", "ends", "movers", "overtake", "map", "tiles", "groups"),
             "lagging": ("spread", "rank", "movers", "overtake", "groups")}
MAX_PICKS = 4
OUTLOOK = ("path", "need")   # the findings an arc may end on: extra parts stand before them


def same_question(a, b):
    """Whether two parts answer one question: an entry of the one's "shows" (measure, year or span, shape) is the other's."""
    key = lambda e: (e.get("measure"), e.get("when"), e.get("shape"))
    return bool({key(e) for e in a or []} & {key(e) for e in b or []})


def blank(part):
    """Whether a part would draw an empty picture: a grid of flags none of which is lit (nothing to read in it)."""
    d = part.get("data") or {}
    return d.get("mode") == "flag" and isinstance(d.get("members"), list) and not any(m.get("flag") for m in d["members"])


def spaced(q, rows, about):
    """The strip rows the lead finding is about that can be named: in its order, LEAD_MAX at most, each at least LABEL_GAP of the
    strip's span from a named one in the same row (a group's, else the strip's), so the names find their tiers."""
    val = {r_["src"]: number(r_.get("value")) for r_ in q.rows if r_.get("src")}
    at = {r_["code"]: (val.get(r_.get("a")), r_.get("group")) for r_ in rows}
    vs = [v for v, _ in at.values() if v is not None]
    gap = LABEL_GAP * (max(vs) - min(vs)) if vs else 0.0
    out = []
    for c in about:
        if c not in at or at[c][0] is None or len(out) >= LEAD_MAX: continue
        if all(at[k][1] != at[c][1] or abs(at[k][0] - at[c][0]) >= gap for k in out): out.append(c)
    return out


def unsaid(anns, *parts):
    """The notes that add something to a section whose title and text are `parts` (segment lists): a note whose numbers (its own and the
    ledger entries in its words) are all facts the title or text already prints is dropped (the page refuses a section that says again,
    story.repeats), the same fact whatever its part (.n and .r are one). A finding that heads the page prints its claim instead of its
    title and a later one prints its title: the same note stands in one place and goes in the other."""
    base = lambda src: re.sub(r"\.(n|r)$", "", src)
    have = {base(f"fact:{v}" if kind == "f" else f"fact:{v}.t.y") for part in parts for kind, v in (part or []) if kind in ("f", "y")}
    return [n for n in anns or [] if not ({base(n["num"])} | {base(x["src"]) for x in n["text"] if "src" in x}) <= have]


def place_leaves(picks, by_id, cands):
    """(picks, {id: (main part, [extra parts])}, why): a leaf stands once on a page, a question is answered once, and a page holds
    MAX_BLOCKS data blocks at most. Each pick in order takes its own leaf, else its fallback leaf, else it goes (the why names it):
    a part goes when its leaf is taken, when it shows what a part placed before it shows (same_question: so the lead's block is the
    one kept), or when it would draw nothing (blank). With fewer than two picks left, the best candidate with a part that stands
    is added. Then, in the same order (the lead's first), each pick's extra parts that stand, while the page has room."""
    used, shown, out, mains, gone = set(), [], [], {}, []
    opts = lambda c: ([{"layer": c["layer"], "data": c["data"], "anns": c.get("anns"), "style": c.get("style"), "shows": c.get("shows")}]
                      + ([{**c["fallback"], "shows": c["fallback"].get("shows", c.get("shows"))}] if c.get("fallback") else []))
    stands = lambda o: o["layer"] not in used and not blank(o) and not any(same_question(o.get("shows"), s_) for s_ in shown)
    def take(o): used.add(o["layer"]); shown.append(o.get("shows"))
    for p in picks:
        m = next((o for o in opts(by_id[p]) if stands(o)), None)
        if m is None: gone.append(p); continue
        take(m); out.append(p); mains[p] = m
    if len(out) < 2:
        free = [c for c in cands if c["id"] not in out and any(stands(o) for o in opts(c))]
        if not free: raise Refused("findings: the picks draw one leaf and no other finding stands")
        add = max(free, key=lambda c: c["score"])
        m = next(o for o in opts(add) if stands(o))
        take(m); out.append(add["id"]); mains[add["id"]] = m
    placed, room = {}, MAX_BLOCKS - len(out)
    for p in out:
        extra = []
        for part in by_id[p].get("more") or []:
            if room > 0 and stands(part): take(part); extra.append(part); room -= 1
        placed[p] = (mains[p], extra)
    return out, placed, (f"{'|'.join(gone)} dropped: its leaf or its question is a pick's before it" if gone else None)


def plan_arc(picks, cands):
    """(arc, picks in the arc's order, why): the arc of the first pick, the others in that arc's order; a page with none of the
    findings the arc needs is given the best candidate of them (the last of its picks goes when four stand), and a request that
    holds none of them keeps its picks, the why saying so."""
    arc = ARC_OF[picks[0]]
    order = ARC_ORDER[arc]
    out, why = list(picks), None
    if not any(p in ARC_NEEDS[arc] for p in out):
        layer = {c["id"]: c["layer"] for c in cands}
        pool = [c for c in cands if c["id"] in ARC_NEEDS[arc] and c["id"] not in out and c["layer"] not in {layer.get(p) for p in out}]
        if pool:
            add = max(pool, key=lambda c: c["score"])["id"]
            if len(out) >= MAX_PICKS: out = sorted(out[1:], key=order.index)[:MAX_PICKS - 2]; out.insert(0, picks[0])
            out.append(add)
            why = f"the {arc} arc needs one of {'|'.join(ARC_NEEDS[arc])}: {add} added"
        else:
            why = f"the {arc} arc needs one of {'|'.join(ARC_NEEDS[arc])} and the request holds none"
    return arc, [out[0]] + sorted(out[1:], key=order.index), why


def closing(arc, facts, ranked=True):
    """The page's closing line (spec.end) as a wording: each arc ends differently, a number only from a fact the page declares. The lagging
    arc's line speaks of ranks: a page with no section of ranks (`ranked` false) says the same of the levels."""
    have = lambda *ks: all(k in facts for k in ks)
    if arc == "happened":
        return wording(T("story.end.happened")) if have("p_past", "goal", "first", "now") else wording(T("story.end.happened_plain"))
    if arc == "in_time":
        if have("need", "past"): return wording(T("story.end.in_time"))
        if have("p_best", "best", "goal"): return wording(T("story.end.in_time_path"))
        return wording(T("story.end.in_time_plain"))
    return wording(T("story.end.lagging" if ranked else "story.end.lagging_level"))


# ---------------------------------------------------------------- compose the picked ones into the page

def compose(r):
    q, cands, _ = candidates(r)
    picks = r.get("picks")
    by_id = {c["id"]: c for c in cands}
    if not isinstance(picks, list) or not 2 <= len(picks) <= 4:
        raise Refused(f"findings: {picks!r} picks; two to four make a story")
    if len(set(picks)) != len(picks): raise Refused("findings: a finding is picked twice")
    for p in picks:
        if p not in by_id: raise Refused(f"findings: {p!r} is not a candidate of this request")
    arc, picks, arc_why = plan_arc(picks, cands)
    picks, placed, twice = place_leaves(picks, by_id, cands)
    if twice: arc_why = "; ".join(w for w in (twice, arc_why) if w)
    chosen = [by_id[p] for p in picks]
    facts, leaves, sections = {}, {}, []
    for c in chosen:
        for k, v in c["facts"].items():
            if k in facts and facts[k] != v:
                raise Refused(f"findings: the fact {k} is declared two ways by two findings")
            facts[k] = v
    style = {}
    told = set()   # the notes an earlier section printed: a later note that says the same again goes
    def says(n):
        """A note as what it says: its number and every entry in its words by the fact each is declared as (two facts declared alike are one
        value), its literal words as they are; two notes of two sections with one `says` are the same note."""
        def val(key, depth=0):   # a fact by what it computes: its operands replaced by theirs, down to the rows
            d = facts.get(key)
            if not isinstance(d, dict) or depth > 8: return d if d is not None else key
            return {k: (val(v, depth + 1) if k in ("a", "b") and isinstance(v, str) and v in facts else v) for k, v in d.items()}
        decl = lambda src: json.dumps(val(re.sub(r"\.[a-z.]+$", "", src[len("fact:"):])), sort_keys=True, default=str) if src.startswith("fact:") else src
        return (decl(n["num"]), tuple(decl(x["src"]) if "src" in x else x.get("w", json.dumps(x, sort_keys=True)) for x in n["text"]))
    def fresh(anns):
        keep = [n for n in anns or [] if says(n) not in told]
        told.update(says(n) for n in keep)
        return keep
    for c in chosen:   # each pick's own leaf (its main part, or its fallback), in the page's order; the extra parts follow every pick's own
        main, extra = placed[c["id"]]
        # the lead's section is headed by its claim's number: a note of that number would only say it again, so it goes
        anns = [n for n in (main.get("anns") or []) if c is not chosen[0] or n["num"] != c["claim"]["num"]]
        if c is not chosen[0]: anns = unsaid(anns, c["title"], c["text"])   # a later finding's section prints its title and text
        anns = fresh(anns)
        leaves[main["layer"]] = {**main["data"], "notes": anns} if anns else main["data"]  # the notes are the story's (story.py reads them; the leaf ignores them)
        for m in [main, *extra]:
            for leaf, kv in (m.get("style") or {}).items(): style[leaf] = {**style.get(leaf, {}), **kv}
    for c in chosen:
        for m in placed[c["id"]][1]:
            ann = fresh(unsaid(m.get("anns"), m["title"], m["text"]))
            leaves[m["layer"]] = {**m["data"], "notes": ann} if ann else m["data"]
    first = chosen[0]
    # a strip of more than LABEL_ALL_MAX points names only the members the lead finding is about (its "about"), the rest unlabelled:
    # any leaf whose knobs take a lead set (the strip's lead_set) and whose rows are that many
    for leaf, d in list(leaves.items()):
        if "lead_set" in style.get(leaf, {}) and len(d.get("rows") or []) > LABEL_ALL_MAX:
            leaves[leaf] = {**d, "lead": spaced(q, d["rows"], first.get("about") or [])}
            style[leaf] = {**style[leaf], "lead_set": "given", "levels": 8}   # the named ones may stand close: every tier the knob allows
    # the page's headline is the lead finding's conclusion and its dek the lead's text, each printed once: the thesis block holds
    # the claims alone, and the lead's own section is headed by its claim (the words, then its number) with no text of its own
    def times(num):   # a claim's number that is a ratio printed with no unit of its own: the times word goes after it
        d = facts.get(num[len("fact:"):]) if num.startswith("fact:") else None
        return isinstance(d, dict) and d.get("op") == "times" and not (q.defs.get(d.get("fmt"), {}).get("suffix") or "").strip()
    def words_unit(num):   # the unit after a claim's number when it is words (no ratio, no percent sign, no digit), else ""
        d = facts.get(num[len("fact:"):]) if num.startswith("fact:") and "." not in num[len("fact:"):] else None
        u = (q.defs.get(d.get("fmt"), {}).get("suffix") or "").strip() if isinstance(d, dict) else ""
        return "" if u in ("", "%") or any(ch.isdigit() for ch in u) else u
    units = {words_unit(c["claim"]["num"]) for c in chosen} - {""}
    one = units.pop() if len(units) == 1 else None
    def claim(num, head):   # a number whose unit is words prints alone: its unit once over the claims (one unit), else in brackets after its lead
        u = words_unit(num)
        if not u: return {"num": num, "head": head}
        return {"num": f"{num}.n", "head": head if one else head + [{"w": WD.WORDS["paren"].replace("{v}", u)}]}
    leaves[THESIS] = {"claims": [{**claim(c["claim"]["num"], segs(c["claim"]["head"])), "section": segs(c["kicker"]),
                                  **({"num_unit": ST("story.times")} if times(c["claim"]["num"]) else {})} for c in chosen],
                      **({"unit_line": [{"w": WD.WORDS["unit.line"].replace("{v}", one)}]} if one else {})}
    # the opening numbers follow the lead: its own three (its facts), else the page's header by the arc
    big = (({}, first["big"]) if first.get("big") and len(first["big"]) == 3 else header(q, arc if arc != "happened" or "chain" in picks else None))
    if big:  # the header's three numbers, a row over the thesis
        for k, v in big[0].items():
            if k in facts and facts[k] != v: raise Refused(f"findings: the fact {k} is declared two ways by two findings")
            facts[k] = v
        leaves[BIG] = {"bignums": big[1]}
        sections.append({"id": "bignums", "layer": BIG})
    sections.append({"id": "thesis", "layer": THESIS})
    for c in chosen:
        if c is first:
            num = c["claim"]["num"]
            if not num.startswith("fact:"): raise Refused(f"findings: the lead finding's claim number {num!r} is no fact")
            lead = [*c["claim"]["head"], ("w", WD.WORDS["story.lead.join"]), ("f", num[len("fact:"):])] + ([("w", WD.WORDS["story.times"])] if times(num) else [])
            # the lead's own rows, for the opening picture: the angle's own subject, and beside it a rate its claim reads off one member as a share of figures
            subject, prop = q.illus.get(c["id"]), illus_proportion(q, c)
            picture = {"subject": subject} if subject else {}
            if prop:   # and the line under that picture, when it is drawn as the share: the member, the claim's own fact, and a slot for the
                # measure's Chinese name, which the page fills from its kicker (the request's measure words may be the table's English title)
                cap = ST("story.opening.proportion", c=[v for kind, v in c["claim"]["head"] if kind == "n"][0], share=num[len("fact:"):], m=MEASURE_SLOT)
                picture = {"subject": {**(subject or {}), "proportion": prop}, "caption": [{"slot": "measure"} if g == {"w": MEASURE_SLOT} else g for g in cap]}
            sections.append({"id": c["id"], "layer": placed[c["id"]][0]["layer"], "kicker": wording(c["kicker"]), "title": wording(lead),
                             **({"picture": picture} if picture else {})})
        else:
            sections.append({"id": c["id"], "layer": placed[c["id"]][0]["layer"], "kicker": wording(c["kicker"]), "title": wording(c["title"]),
                             "text": wording(c["text"])})
    # the extra parts after every pick's own section and before the outlook (path, need) the arc ends on, in the picks' order, so a
    # pick's own neighbour (a pair of pictures) stays beside it
    at = max([i + 1 for i, s_ in enumerate(sections) if s_["id"] in by_id and s_["id"] not in OUTLOOK] or [len(sections)])
    extra = [{"id": f"{c['id']}_{m['layer']}", "layer": m["layer"], "kicker": wording(m["kicker"]), "title": wording(m["title"]),
              "text": wording(m["text"])} for c in chosen for m in placed[c["id"]][1]]
    sections[at:at] = extra
    items = [ST("story.notes.scenario")] if any("scenario" in c["notes"] for c in chosen) else []
    for c in chosen:   # a finding's own caveats (its basis, its split), each once, as many as the list holds beside the last line
        for r_ in c.get("risks", []):
            if r_ not in items and len(items) < 5: items.append(r_)
    last = max(chosen, key=lambda c: c["facts"][c["last"]]["time"])["last"]
    items.append(ST("story.notes.last", last=last))
    leaves[NOTES] = {"title": ST("story.notes.title"), "items": items}
    sections.append({"id": "notes", "layer": NOTES})
    return {"facts": facts, "sections": sections, "leaves": leaves, "style": style, "title": wording(first["title"]), "dek": wording(first["text"]),
            "end": closing(arc, facts, any(c["id"] in RANK_ANGLES for c in chosen)), "arc": {"id": arc, "picks": picks, "why": arc_why}}


def as_fill(page):
    """The composed page as the part of a fill it adds: the spec's facts, sections and leaf data, and nothing else (the flow
    refuses any other key: the rows, the formats and the names are layer 1's, next_run story_page)."""
    hero = {"leaves": page["leaves"], **({"style": page["style"]} if page.get("style") else {})}   # a leaf's knobs the part names (dot_strip periods)
    return {"knobs": {"spec": {"facts": page["facts"], "sections": page["sections"], "hero": hero,
                               "title": page["title"], "dek": page["dek"], "end": page["end"]}}}


def answer(r):
    """One request's reply: the candidates, or the composed page; a refusal says why."""
    try:
        if r.get("mode") == "compose":
            return as_fill(compose(r))
        _, cands, dropped = candidates(r)
        return {"candidates": [{k: c[k] for k in ("id", "angle", "layer", "score", "why", "summary")} for c in cands],
                "dropped": dropped}
    except Refused as e:
        return {"refused": [str(e)]}


def main():
    """One JSON request a line on stdin, one JSON reply a line on stdout (next_leaf's child protocol)."""
    for line in sys.stdin:
        if not line.strip(): continue
        try:
            r = json.loads(line)
        except ValueError as e:
            out = {"refused": [f"findings: the request is not JSON: {e}"]}
        else:
            out = answer(r) if isinstance(r, dict) else {"refused": ["findings: the request is no object"]}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n"); sys.stdout.flush()


if __name__ == "__main__":
    main()
