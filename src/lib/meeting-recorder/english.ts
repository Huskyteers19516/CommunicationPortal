// English word statistics for key points, ported from VoiceCollector's localnlp.js (offline lecture analysis,
// tuned on real recordings). Client-safe, no DOM. English only: a transcript in another language simply yields
// few key points, and the admin writes them by hand.

// Function words and filler. Never terms, never part of a topic's vocabulary.
const STOP_WORDS = `
a about above across after again against all almost alone along already also although always am among an and another any
anybody anyone anything anyway are around as aside at away back be became because become becomes been before began begin
behind being below beside besides best better between beyond both but by came can cannot cant come comes coming could
couldnt did didnt do does doesnt doing done dont down during each either else enough especially etc even ever every
everybody everyone everything except far few finally for from further get gets getting give given go goes going gone got
had hadnt has hasnt have havent having he hed her here hers herself hes him himself his how however i id if im in indeed
instead into is isnt it its itself ive just keep kept let lets like likely little ll made make makes many may maybe me
mean means might mine more moreover most mostly much must my myself near need needs neither never nevertheless new next
no nobody none nor not nothing now of off often oh ok okay on once one only onto or other others otherwise ought our ours
ourselves out over own per perhaps please probably quite rather re really right said same saw say saying says see seem
seemed seems seen several shall she shes should shouldnt since so some somebody somehow someone something sometimes
somewhat soon still such sure take taken than that thats the their theirs them themselves then there thereby therefore
these they theyre theyve thing things think this those though through throughout thus to together too toward towards
under unless until up upon us usually ve very was wasnt way we well were werent weve what whatever when whenever where
whereas whether which while who whoever whom whose why will with within without wont would wouldnt yeah yep yes yet you
youd your yours yourself youre youve
um uh uhh er erm ah ahh hmm mhm huh gonna wanna gotta kinda sorta alright anyways basically actually literally obviously
essentially sort kind lot bit stuff guys folks everybody okay yknow
cuz cos gotcha dunno lemme gimme totally definitely certainly whatnot anyhow
`
  .trim()
  .split(/\s+/);
export const STOP = new Set(STOP_WORDS);

/**
 * Spoken intensifiers: only rejected as the FIRST word of a two-word term ("super overwhelming", "pretty much").
 * Not global stop words — "super" or "pretty" can be real words elsewhere.
 */
const INTENSIFIER = new Set("super pretty really very so quite kinda sorta totally like just".split(" "));

// Everyday English and school/meeting vocabulary: the reference for "how rare is this word". Matching words are
// weighted down (not to zero — a drivetrain meeting's "motor" or "power" can still matter); anything else counts
// as this meeting's own vocabulary. The last line is team-wide words every FTC meeting uses.
const COMMON_WORDS = `
able add addition advance affect age ago agree air allow alone amount analysis analyze answer appear application apply
approach appropriate area argue argument arrive article ask assume attention author available average avoid
bad base basic beat beautiful become begin behavior believe benefit big black blood board body book bottom box boy break
bring brother build building business buy
call car care carry case catch cause center central century certain chance change character charge check chief child
choice choose church city civil claim clear close coach cold collection college color come commercial common community
company compare complete computer concern condition conference consider consumer contain continue contract control cost
country couple course cover create crime cultural culture current customer cut
dark data daughter day dead deal death debate decade decide decision deep defense degree democratic describe design
despite detail determine develop development die difference different difficult dinner direction director discover
discuss discussion disease do doctor dog door draw dream drive drop drug
early east easy eat economic economy edge education effect effort eight either election employee end energy engine
equal equals equation divided multiply multiplied versus approximately roughly plus minus point squared cubed
root power ratio sum total product value variable graph curve axis
english enjoy enter entire environment especially establish event ever evidence exactly example executive exist expect
experience expert explain eye
face fact factor fail fall family father fear federal feel feeling few field fight figure fill film final finally
financial find fine finger finish fire firm first fish five floor fly focus follow food foot football force foreign
forget form former forward four free friend from front full fund future
game garden gas general generation get girl give glass go goal good government great green ground group grow growth
guess gun guy
hair half hand hang happen happy hard head health hear heart heat heavy help her here herself high him himself his
history hit hold home hope hospital hot hotel hour house however huge human hundred husband
idea identify image imagine impact important improve include including increase indeed indicate individual industry
information inside instead institution interest international interview introduce investment involve issue item
job join judge jump just
keep key kid kill kitchen knowledge know
land language large last late later laugh law lawyer lay lead leader learn leave left leg legal less lesson let letter
level lie life light like likely limit line list listen little live local long look lose loss lot love low
machine magazine main maintain major majority make man manage management manager many market marriage material matter
may maybe mayor mean measure media medical meet meeting member memory mention message method middle might military
million mind minute miss mission model modern moment money month morning mother mouth move movement movie much music
must
name nation national natural nature near nearly necessary need network never new news newspaper next nice night none
north note nothing notice now number
occur offer office officer official often oil old once one only open operation opportunity option order organization
other others outside over own
page pain painting paper parent part participant particular particularly partner party pass past patient pattern pay
peace people per percent percentage perform performance perhaps period person personal phone physical pick picture piece place plan plant
play player point police policy political politics poor popular population position positive possible power practice
prepare present president press pressure pretty prevent price private probably problem process produce product
production professional professor program project property protect prove provide public pull purpose push put
quality question quick quickly quite
race radio raise range rate rather reach read ready real reality realize really reason receive recent recently recognize
record red reduce reflect region relate relationship religious remain remember remove report represent republican
require research resource respond response responsibility rest result return reveal rich right rise risk road rock role
room rule run
safe same save say scene school science scientist score sea season seat second section security seek seem sell send
senior sense series serious serve service set seven several sex shake share she shoot short shot should shoulder show
side sign significant similar simple simply since sing single sister sit site situation six size skill skin small smile
social society soldier solution some somebody someone something son song soon sort sound source south southern space
speak special specific speech spend sport spring staff stage stand standard star start state statement station stay step
still stock stop store story strategy street strong structure student study stuff style subject success successful such
suddenly suffer suggest summer support sure surface system
table take talk task tax teach teacher team technology television tell ten tend term test text than thank theory thing
think third thought thousand threat three throw thus time today together tonight top total tough toward town trade
traditional training travel treat treatment tree trial trip trouble true truth try turn tv type
understand union unit united university unless until upon us use usually
value various very victim video view violence visit voice vote
wait walk wall want war watch water way we wear week weight well west western whatever whether while white whole whom
whose wide wife will win wind window wish within without woman wonder word work worker working world worry would write
writer wrong
yard yeah year yes yet young
zero one two three four five six seven eight nine ten eleven twelve thirteen fifteen twenty thirty forty fifty sixty
seventy eighty ninety hundred thousand million billion half double triple once twice
lecture lecturer class classroom course chapter section slide slides syllabus semester quarter term homework assignment
assignments exam exams quiz quizzes midterm midterms final finals test tests problem problems set sets question
questions answer answers example examples note notes topic today tomorrow yesterday week weeks monday tuesday wednesday
thursday friday saturday sunday morning afternoon evening page pages read reading write writing due deadline submit
turn hand study review exercise exercises practice homework office hours
robot robots team teams season meeting meetings agenda update updates sync everyone guys stuff thing awesome cool
`
  .trim()
  .split(/\s+/);
export const COMMON = new Set(COMMON_WORDS);

/**
 * Lower case with contractions resolved, so stop-word lookups work: n't / 'm / 're / 've / 'll / 'd → "" (function
 * words); 's after a pronoun or function word → "" (it's, that's, let's); 's after a real word is a possessive
 * and leaves the word (Alice's → alice).
 */
export function normWord(raw: string): string {
  const w = String(raw || "")
    .toLowerCase()
    .replace(/’/g, "'");
  const k = w.indexOf("'");
  if (k < 0) return w;
  const head = w.slice(0, k);
  const tail = w.slice(k + 1);
  if (/^(?:t|m|re|ve|ll|d)$/.test(tail)) return "";
  if (tail === "s" || tail === "") return head.length < 3 || STOP.has(head) ? "" : head;
  return w.replace(/'/g, ""); // o'clock, rock'n'roll: one word
}

/** A minimal stemmer: the commonest plural and tense endings, enough to match "motors" with "motor". */
export function stem(w: string): string {
  if (w.length <= 4) return w;
  if (w.endsWith("ies") && w.length > 5) return `${w.slice(0, -3)}y`;
  if (w.endsWith("sses") || w.endsWith("shes") || w.endsWith("ches")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 6) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 5) return w.slice(0, -2);
  return w;
}

/**
 * The English words of a text, normalised (normWord). Contractions become "" in place rather than disappearing,
 * so callers still treat them as a break between words (no fake two-word terms across them).
 */
export function tokens(text: string): string[] {
  return (
    String(text || "")
      .toLowerCase()
      .match(/[a-z][a-z'’-]*[a-z]|[a-z]/g) || []
  ).map(normWord);
}

export function wordCount(text: string): number {
  const m = String(text || "").match(/[A-Za-z0-9'’-]+/g);
  return m ? m.length : 0;
}

/** Word forms for the "is this a common word" check only (trying → try, talked → talk, bigger → big). */
function lemmas(w: string): string[] {
  const out = [w, stem(w)];
  const undouble = (b: string) => (/([b-df-hj-np-tv-z])\1$/.test(b) ? b.slice(0, -1) : b);
  if (w.endsWith("ing") && w.length > 5) {
    const b = w.slice(0, -3);
    out.push(b, `${b}e`, undouble(b));
  }
  if (w.endsWith("ed") && w.length > 3) {
    const b = w.slice(0, -2);
    out.push(b, `${b}e`, undouble(b));
    if (b.endsWith("i")) out.push(`${b.slice(0, -1)}y`);
  }
  if (w.endsWith("es") && w.length > 4) out.push(w.slice(0, -2));
  if (w.endsWith("s") && w.length > 3) out.push(w.slice(0, -1));
  if (w.endsWith("ly") && w.length > 5) out.push(w.slice(0, -2));
  if (w.endsWith("er") && w.length > 5) {
    const b = w.slice(0, -2);
    out.push(b, `${b}e`, undouble(b));
  }
  if (w.endsWith("est") && w.length > 6) {
    const b = w.slice(0, -3);
    out.push(b, `${b}e`, undouble(b));
  }
  return out;
}

function isCommonForm(w: string): boolean {
  return lemmas(w).some((x) => COMMON.has(x));
}

/** How rare (= informative) a word is: stop word 0, common word 0.22, otherwise 1 (1.15 when 9+ letters). */
export function rarity(w: string): number {
  if (!w || w.length < 3 || STOP.has(w)) return 0;
  if (isCommonForm(w)) return 0.22;
  return w.length >= 9 ? 1.15 : 1;
}

/** Cosine similarity of two sparse vectors. */
export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, v] of small) {
    const u = big.get(k);
    if (u) dot += v * u;
  }
  if (!dot) return 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function cleanPhrase(s: string): string {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.\-—]+|[\s,;:.\-—]+$/g, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MO = "january february march april may june july august september october november december".split(" ").join("|");
const WD = "monday tuesday wednesday thursday friday saturday sunday".split(" ").join("|");

// Longest patterns first, so "next friday" isn't found as just "friday".
const DATE_PATTERNS: RegExp[] = [
  new RegExp(`\\b(?:next|this|last|coming|following)\\s+(?:${WD}|week|month|meeting|practice|session)\\b`, "gi"),
  new RegExp(`\\b(?:${MO})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)\\s+of\\s+(?:${MO})\\b`, "gi"),
  /\bin\s+(?:a|an|one|two|three|four|five|six|seven|ten|\d+)\s+(?:day|days|week|weeks|hour|hours|month|months)\b/gi,
  /\bend\s+of\s+(?:the\s+)?(?:week|month|day|semester|quarter|term|season|practice)\b/gi,
  new RegExp(
    `\\b(?:by|before|until|till|on)\\s+(?:the\\s+)?(?:next\\s+|this\\s+)?(?:${WD}|end\\s+of\\s+(?:the\\s+)?\\w+|midnight|noon|tonight|tomorrow|practice|then)\\b`,
    "gi",
  ),
  /\b(?:at|by)\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|o'clock)(?![a-z])/gi,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  /\b(?:tomorrow|tonight|this\s+weekend|two\s+weeks\s+from\s+now)\b/gi,
  new RegExp(`\\b(?:${WD})\\b`, "gi"),
];

/** Up to 4 dates or deadlines mentioned in a sentence ("by Friday", "October 31", "next week"), in order. */
export function extractDates(text: string): { raw: string; at: number }[] {
  const found: { raw: string; at: number }[] = [];
  const taken: [number, number][] = [];
  for (const re of DATE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const a = m.index;
      const b = m.index + m[0].length;
      if (taken.some(([x, y]) => a < y && b > x)) continue; // inside a longer match
      taken.push([a, b]);
      found.push({ raw: cleanPhrase(m[0]), at: a });
      if (found.length >= 4) return found.sort((x, y) => x.at - y.at);
    }
  }
  return found.sort((x, y) => x.at - y.at);
}

// ---------------------------------------------------------------------------
// Term weights
// ---------------------------------------------------------------------------

type Term = { key: string; count: number; score: number; n: 1 | 2; parts?: [string, string] };

/**
 * TF-IDF-like term scoring: log-damped counts × rarity (the common-word list stands in for IDF), ×1.35 for proper
 * nouns (capitalised mid-sentence ≥ 40% of the time), ×0.45 for words said once; two-word terms need cohesion ≥
 * 0.55 and 2+ uses. Single words mostly said inside a kept phrase are dropped. At most 60 terms.
 */
function extractTerms(sentences: string[]): { terms: Term[]; tf: Map<string, number>; surface: Map<string, string> } {
  const tf = new Map<string, number>(); // stem → count
  const surface = new Map<string, string>(); // stem → shortest spelling seen
  const capHits = new Map<string, number>();
  const bi = new Map<string, number>();

  for (const text of sentences) {
    const rawWords = String(text).match(/[A-Za-z][A-Za-z'’-]*/g) || [];
    let prev: string | null = null;
    for (let k = 0; k < rawWords.length; k++) {
      const raw = rawWords[k];
      const w = normWord(raw);
      if (!w || STOP.has(w) || w.length < 3) {
        prev = null;
        continue;
      }
      const st = stem(w);
      tf.set(st, (tf.get(st) || 0) + 1);
      const cur = surface.get(st);
      if (!cur || w.length < cur.length) surface.set(st, w);
      if (k > 0 && /^[A-Z]/.test(raw)) capHits.set(st, (capHits.get(st) || 0) + 1);
      if (prev) {
        const key = `${prev} ${st}`;
        bi.set(key, (bi.get(key) || 0) + 1);
      }
      prev = st;
    }
  }

  const scored: Term[] = [];
  for (const [st, c] of tf) {
    const r = rarity(surface.get(st) || st);
    if (r <= 0) continue;
    let sc = (1 + Math.log(c)) * r;
    if ((capHits.get(st) || 0) >= Math.max(2, c * 0.4)) sc *= 1.35;
    if (c === 1) sc *= 0.45;
    scored.push({ key: st, count: c, score: sc, n: 1 });
  }

  for (const [key, c] of bi) {
    if (c < 2) continue;
    const [a, b] = key.split(" ");
    const cohesion = c / Math.min(tf.get(a) || 1, tf.get(b) || 1);
    if (cohesion < 0.55) continue;
    const sa = surface.get(a) || a;
    const sb = surface.get(b) || b;
    if (INTENSIFIER.has(sa) || INTENSIFIER.has(a)) continue;
    const aCommon = COMMON.has(sa) || COMMON.has(a);
    const bCommon = COMMON.has(sb) || COMMON.has(b);
    if (aCommon && bCommon) continue;
    if ((aCommon || bCommon) && c < 3) continue;
    const r = Math.max(rarity(sa), rarity(sb));
    if (r <= 0) continue;
    scored.push({ key, count: c, score: (1 + Math.log(c)) * r * 1.7, n: 2, parts: [a, b] });
  }

  scored.sort((x, y) => y.score - x.score);

  const phraseCount = new Map<string, number>();
  for (const it of scored) {
    if (it.n !== 2 || it.score <= 1.4 || !it.parts) continue;
    for (const p of it.parts) phraseCount.set(p, Math.max(phraseCount.get(p) || 0, it.count));
  }
  const terms: Term[] = [];
  const seen = new Set<string>();
  for (const it of scored) {
    if (seen.has(it.key)) continue;
    if (it.n === 1 && phraseCount.has(it.key) && it.count <= (phraseCount.get(it.key) || 0) * 1.5) continue;
    seen.add(it.key);
    terms.push(it);
    if (terms.length >= 60) break;
  }
  return { terms, tf, surface };
}

/**
 * Weight per stem for scoring sentences and comparing texts: the term score; parts of a two-word term get ×0.8;
 * every other content word (1 + ln count) × rarity × 0.5.
 */
export function buildTermWeights(sentences: string[]): Map<string, number> {
  const { terms, tf, surface } = extractTerms(sentences);
  const weight = new Map<string, number>();
  for (const t of terms) {
    if (t.n === 1) weight.set(t.key, t.score);
    else for (const p of t.parts ?? []) weight.set(p, Math.max(weight.get(p) || 0, t.score * 0.8));
  }
  for (const [st, c] of tf) {
    if (weight.has(st)) continue;
    const r = rarity(surface.get(st) || st);
    if (r > 0) weight.set(st, (1 + Math.log(c)) * r * 0.5);
  }
  return weight;
}

/**
 * Weight per stem for finding WHERE in a transcript something was said: rarity × ln(1 + sentences / sentences
 * using it). A word said in one sentence pins the place down better than one said all meeting long (the opposite
 * of buildTermWeights, which favours what the meeting keeps coming back to). `fallback` is the weight for words
 * the transcript never uses (half the weight of a word used once, before rarity).
 */
export function buildPlaceWeights(sentences: string[]): { weights: Map<string, number>; fallback: number } {
  const df = new Map<string, number>();
  const surface = new Map<string, string>();
  for (const text of sentences) {
    const seen = new Set<string>();
    for (const w of tokens(text)) {
      if (!w || w.length < 3 || STOP.has(w)) continue;
      const st = stem(w);
      if (!surface.has(st)) surface.set(st, w);
      seen.add(st);
    }
    for (const st of seen) df.set(st, (df.get(st) || 0) + 1);
  }
  const n = Math.max(1, sentences.length);
  const weights = new Map<string, number>();
  for (const [st, d] of df) weights.set(st, rarity(surface.get(st) || st) * Math.log(1 + n / d));
  return { weights, fallback: 0.5 * Math.log(1 + n) };
}

/** A text as a stem → weight vector (unknown content words get `fallback` × their rarity), for cosine(). */
export function termVector(text: string, weights: Map<string, number>, fallback = 0.3): Map<string, number> {
  const v = new Map<string, number>();
  for (const w of tokens(text)) {
    if (!w || w.length < 3 || STOP.has(w)) continue;
    const st = stem(w);
    v.set(st, (v.get(st) || 0) + (weights.get(st) ?? rarity(w) * fallback));
  }
  for (const [k, x] of v) if (!x) v.delete(k);
  return v;
}
