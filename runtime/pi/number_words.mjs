// Numbers written as words in claim and hero templates ("ten", "two-thirds", "十个", "第二大", "三成").
// literalNumberIn refuses typed digits; this refuses the same thing spelled out, since no result row backs it.
// Pure: no imports. numberWordIn(text) returns a short snippet near the first match, or null.
// Placeholders ({max.x}) are masked first; a scale or unit word right after a placeholder or a digit passes.

const D2 = "二两三四五六七八九";
const M = "个|名|位|人|国|家|条|项|款|座|辆|只|件|次|种|类|批|所|户|场|架|艘|岁|年|天|周|小时|分钟|秒|元|块|吨|公里|千米|米|公顷|亩|瓦|届|轮|期|篇|部|笔|枚|份|股|省|市|县|区|城|倍|成|根";
const CN_PASS = /一带一路|两会|三农|十四五|十五五|一国两制|[七二十]+国集团|三国(?:演义|志|杀)|八国联军|二次(?:元|函数|方程|开发|创业|利用|污染)|两国(?:关系|之间|间|元首|领导人)|千万(?=[别不要得小注切莫务记])|半导体|半岛|[〇零一二三四五六七八九]{4}年/g;
// NEWSROOM_NUMWORD_CONTEXT=1 (exact "1", default off, ledger K257): words that are only a number word by their position. 四周 as "all around" (a space word
// before or after it) is not four weeks; 过去四周, 持续四周, 四周内 and the other time uses stay refused. Off: nothing here runs and the result is unchanged.
export function numwordContextEnabled() {
  return process.env.NEWSROOM_NUMWORD_CONTEXT === "1";
}
const CN_PASS_CONTEXT = /(?<=[向朝往绕围环])四周|四周(?=[环围都皆满布])/g;

const CN_REFUSE = [
  /百分之|百分点|[二三四五六七八九十百千万]分之[一二两三四五六七八九十百千]|[一二两三四五六七八九十]分之[一二两三四五六七八九十]/,
  new RegExp(`(?<!第)(?:[${D2}十]|(?<=[十百千万${D2}])一)(?:多|余|几)?(?:${M})`),
  /[二三四五六七八九十一]成(?=[左右以多的，。、；]|$)/,
  /[二三四五六七八九十两百千万几数半双一]倍|翻了?[一两二三]?[番倍]/,
  /一半|半数|过半|近半|减半|对半|折半|大半|小半|半年|半个月|半世纪|半小时/,
  /[一二两三四五六七八九十百千][万亿]|万亿|千万/,
  /[一二两三四五六七八九十]百|[一二两三四五六七八九]千|[二两三四五六七八九]十|十[一二两三四五六七八九]/,
  /[几数]十|[几数]百|[几数]千|[几数]万|[几数]亿|上百|上千|上万|上亿|近百|百余|百多|成百上千|成千上万/,
  /(?:排名|排在|排第|位列|位居|名列|列第|居第)第?[一二两三四五六七八九十]|第[一二两三四五六七八九十百]+(?=[名位大高低多少强])|前[二两三四五六七八九十]+(?=[名大位强家个国人项])/,
  /[二两三四五六七八九十]大(?![爷妈姐伯])|俩|仨/,
];

const CARD = "(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|trillions?|dozens?|tens)";
const ORD = "(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|twentieth)";
const SUP = "(?:largest|biggest|highest|lowest|smallest|most|least|fastest|slowest|richest|poorest|ranked|place|best|worst|greatest|longest|oldest|youngest|busiest|wealthiest)";
const EN_PASS = /\b(?:net|ground)[- ]zero\b|zero[- ](?:sum|tolerance|day|carbon|emissions?)|\b(?:first|second) half\b|half[- ](?:hearted|baked|measure|time)|\bhalfway\b|\btwo-way\b|\bnine-to-five\b|\bsecond-hand\b|\bone-way\b|\bone-off\b|\bone-time\b/gi;
const EN_REFUSE = [
  /\b(?:a|one) (?:hundred|thousand|million|billion|trillion|dozen)\b/i,
  /\b(?:one|two|three|four|five|six|seven|eight|nine)[- ](?:third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|quarter|half|halves)s?\b/i,
  /\bone[- ]in[- ](?:two|three|four|five|six|seven|eight|nine|ten)\b/i,
  /\b(?:about|around|nearly|almost|over|under|only|just|than|at least|roughly|exactly) one\b(?! of\b| another| thing| way| day| more| can)/i,
  /\b(?:twice|thrice|doubled|doubles|doubling|tripled|triples|tripling|quadrupled|quintupled)\b|\bdouble(?= (?:the|that|those|these|its|their|what|as|from)\b)|\b(?:two|three|four|five|six|seven|eight|nine|ten|twenty|hundred|thousand)-?fold\b|\bdouble[- ]digits?|\bsingle[- ]digits?/i,
  /\bhalf\b|\bhalves\b/i,
  /\b(?:a|one) (?:third|fifth|sixth|tenth)\b(?! party| world| time| place| option| quarter| round| wheel| rail| person| country| term)|\b(?:a|three) quarters?\b(?! later| earlier| ago| to| past| after)|(?<!first )(?<!second )(?<!third )(?<!fourth )(?<!last )(?<!next )(?<!this )(?<!previous )\bquarter of\b/i,
  /\bper ?cent\b|\bpercent\b|\bpercentage points?\b|\bbasis points?\b/i,
  new RegExp(`\\b(?:ranked|ranks|placed|came in|comes in|finished|sits|sat|stands|stood)\\s+(?:at |in |as |the )?${ORD}\\b|\\b${ORD}[- ]${SUP}\\b|\\b(?:top|bottom) (?:two|three|four|five|six|seven|eight|nine|ten|twenty)\\b|\\bzero\\b`, "i"),
  /\ba couple of\b/i,
];
const CARD_RE = new RegExp(`\\b${CARD}\\b`, "gi");

// A scale or unit word right after a placeholder (or a digit), with at most one space, is not a number word.
const SCALE_AFTER = /(?<=[\u0000\d]) ?(?:个百分点|个基点|百分点|百万|千万|万亿|十亿|百|千|万|亿|倍|成|度|级|(?:hundred|thousand|million|billion|trillion|percent|per cent|percentage points?|basis points?)(?![A-Za-z]))/gi;
const PERCENT_BEFORE = /百分之(?=\u0000)/g;

function first(text, patterns) {
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (m) return { index: m.index, length: m[0].length };
  }
  return null;
}

function englishCardinal(text) {
  CARD_RE.lastIndex = 0;
  for (const m of text.matchAll(CARD_RE)) {
    const word = m[0];
    const prev = text.slice(0, m.index).trimEnd();
    const sentenceStart = prev === "" || /["“(.!?:;]$/.test(prev);
    if (/[A-Z]/.test(word[0]) && !sentenceStart) continue; // mid-sentence capitalised: a proper noun (Group of Seven)
    return { index: m.index, length: word.length };
  }
  return null;
}

// With NEWSROOM_NUMWORD_CONTEXT=1, a form's one-line reason may count a chart part: 一 or 两 plus 个/条/根 plus a part name ("两条线对比走势", "一个点代表一个州").
// That describes the picture, not a value. Every other number word, and 三 and up, stays refused. Off, or any other text: exactly numberWordIn. numberWordIn itself never changes.
const ANATOMY = /(?<![十百千万二两三四五六七八九〇零])[一二两][个条根](?=[点线轴柱块格圈色层列行])/g;
export function numberWordInReason(text) {
  if (!numwordContextEnabled()) return numberWordIn(text);
  return numberWordIn(String(text ?? "").replace(ANATOMY, (m) => "▢".repeat(m.length)));
}

function numberWordCore(text) {
  const masked = String(text ?? "")
    .replace(/\{[^{}]*\}/g, "\u0000")
    .replace(PERCENT_BEFORE, "▢")
    .replace(SCALE_AFTER, "▢");
  let cn = masked.replace(CN_PASS, (m) => "▢".repeat(m.length));
  if (numwordContextEnabled()) cn = cn.replace(CN_PASS_CONTEXT, (m) => "▢".repeat(m.length));
  const en = masked.replace(EN_PASS, (m) => "▢".repeat(m.length));
  // Same-length masks keep the indexes of `masked` valid for the snippet.
  const hit = first(cn, CN_REFUSE) ?? first(en, EN_REFUSE) ?? englishCardinal(en);
  return hit ? { masked, hit } : null;
}

export function numberWordIn(text) {
  const found = numberWordCore(text);
  if (!found) return null;
  const { masked, hit } = found;
  const chars = [...masked];
  const at = [...masked.slice(0, hit.index)].length;
  const len = [...masked.slice(hit.index, hit.index + hit.length)].length;
  return chars.slice(Math.max(0, at - 12), at + len + 12).join("").replace(/\u0000/g, "{...}");
}

// NEWSROOM_FIRST_TRY_WORDING=1 (exact "1", default off): a refusal for a number word also names the exact matched word(s), every one in the text, so one
// rewrite can clear them all. The set of refused texts is exactly numberWordIn's; this only changes the message.
export function firstTryWordingEnabled() {
  return process.env.NEWSROOM_FIRST_TRY_WORDING === "1";
}

/** Every refused word in the text (at most 8), found by the same rules as numberWordIn; each hit is blanked and the text scanned again. */
export function numberWordHits(text) {
  const out = [];
  let rest = String(text ?? "");
  for (let i = 0; i < 8; i += 1) {
    const found = numberWordCore(rest);
    if (!found) break;
    const { masked, hit } = found;
    out.push(masked.slice(hit.index, hit.index + hit.length));
    rest = masked.slice(0, hit.index) + "▢".repeat(hit.length) + masked.slice(hit.index + hit.length);
  }
  return out;
}

/** The message tail naming the exact words, or "" when the switch is off or nothing matched. */
export function numberWordNames(text) {
  if (!firstTryWordingEnabled()) return "";
  const hits = numberWordHits(text);
  return hits.length ? `; the refused word${hits.length > 1 ? "s are" : " is"} ${hits.map((w) => `"${w}"`).join(", ")} (rewrite every one of them)` : "";
}
