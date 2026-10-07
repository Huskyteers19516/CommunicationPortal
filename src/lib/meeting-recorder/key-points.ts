// Key points for a meeting recap, written in the browser right after a recording is transcribed. Client-safe,
// no DOM, no network: an extractive ranker ported from VoiceCollector (localnlp.js analysis + coach.js "three
// minute recap" picker) with meeting-specific signals added — decisions, to-dos with an owner from the team
// roster and a deadline, emphasis ("the important thing is…"), and the moments an admin marked while recording.
// Chrome's built-in summarizer, when a browser has it, adds narrative bullets on top (mergeKeyPoints).
// The admin always edits the list before saving.
//
// Output lines read like:
//   [2:45] Decision: we decided to go with the four-bar intake for the scrimmage.
//   [3:44] To do (Alice, by Friday): order the 312 RPM motors and two more torque servos.

import {
  buildPlaceWeights,
  buildTermWeights,
  cleanPhrase,
  COMMON,
  cosine,
  extractDates,
  STOP,
  stem,
  termVector,
  tokens,
  wordCount,
} from "./english";

export type KeyPointSegment = { s: number; e?: number | null; text: string };
export type KeyPointKind = "decision" | "action" | "point";
/** `marked`: picked because an admin pressed "Mark key moment" there. */
export type KeyPoint = { atMs: number | null; text: string; kind: KeyPointKind; marked?: boolean };
export type KeyPointOptions = {
  /** First names of the team's active members: a to-do that names one as the doer gets them as its owner. */
  roster?: string[];
  /** "Mark key moment" presses, ms from the start. */
  marks?: number[];
  /** At most this many (default 10; marks with no transcript nearby come on top). */
  max?: number;
  /** At least this many when the transcript is long enough (default 5). */
  min?: number;
};

/** Longest key point, in characters. */
const POINT_MAX = 220;
/** "Mark key moment" is pressed after the moment: look back this far for the sentence that just ended. */
const MARK_LOOKBACK_MS = 15_000;
/** A reply ("Yes, I'll order them today.") answers a request that ended at most this long before it. */
const REPLY_GAP_MS = 15_000;
/**
 * Spread: one key point per window of meeting time (30 s, smaller for short recordings), and none closer than half
 * a window (8 s at most) to another — both relaxed when that leaves too few.
 */
const WINDOW_MS = 30_000;
const NEAR_MS = 8_000;

// ---------------------------------------------------------------------------
// Meeting signals (matched on text with ’ turned into ')
// ---------------------------------------------------------------------------

const DECISION_RE =
  /\b(?:we(?:'ve|\s+have)?\s+(?:just\s+)?decided|(?:the\s+)?decision\s+is|let's\s+(?:go\s+with|stick\s+with)|we(?:'re|\s+are)\s+(?:going\s+with|sticking\s+with)|we\s+(?:all\s+)?agreed|agreed\s+(?:on|to|that)|we'll\s+go\s+with|settled\s+on|voted?\s+(?:for|to)|(?:is|are)\s+approved|final\s+(?:decision|design|version)|from\s+now\s+on)\b/i;
// Asking or assigning someone to do something.
const ACTION_FIRM_RE =
  /\b(?:action\s+items?|to-?dos?|next\s+steps?|(?:needs?|have|has)\s+to|make\s+sure|follow\s+up|take\s+care\s+of|in\s+charge\s+of|responsible\s+for|assign(?:ed)?\s+to|sign\s+up|(?:can|could|will|would)\s+you|please|submit|(?<!in\s)order(?!\s+of\b)|due(?!\s+to\b)|deadline)\b/i;
// Plans ("I'll…", "Alice is going to…"): a to-do only when a team member is the one doing it.
const ACTION_SOFT_RE = /\b(?:will|going\s+to|gonna|should)\b|'ll\b/i;
// Requests that happen in the meeting itself ("Marcus, can you walk us through…") aren't to-dos.
const IN_MEETING_RE =
  /\b(?:(?:walk|talk|take)\s+(?:us|me|everyone)\s+through|tell\s+(?:us|me|everyone)|show\s+(?:us|me|everyone)|give\s+(?:us|me)\s+(?:an?\s+)?(?:update|quick)|explain|repeat\s+that|say\s+that\s+again|hear\s+me|speak\s+up|see\s+my\s+screen|share\s+(?:your|the|my)\s+screen|go\s+over)\b/i;
// FTC dates that make a plan concrete.
const EVENT_RE =
  /\b(?:qualifiers?|scrimmages?|league\s+meets?|meet\s+day|championships?|states?|regionals?|kickoff|inspection|judging|interviews?|engineering\s+(?:notebook|portfolio)|portfolio|outreach\s+event)\b/i;
const EMPHASIS_RE =
  /\b(?:important|crucial|critical|the\s+key|key\s+(?:point|idea|thing|takeaway)|main\s+point|takeaway|bottom\s+line|the\s+whole\s+point|note\s+that|pay\s+attention|be\s+careful|watch\s+out|make\s+sure|remember|don't\s+forget|keep\s+in\s+mind|to\s+summarize|in\s+summary|to\s+recap|the\s+point\s+is|what\s+matters)\b/i;
// Talk that sounds like chat rather than content.
const FILLER_RE =
  /\b(?:like|you\s+know|kind\s+of|sort\s+of|i\s+mean|okay|ok|right|um+|uh+|yeah|gonna|wanna|gotta|super|really|just|stuff|whatever|crazy|literally|basically|actually|anyway)\b/gi;

// Roster names that are also ordinary words: only a capitalised, mid-sentence mention (or "Will, …") counts.
const AMBIGUOUS_NAMES = new Set(
  "will may mark grace faith hope joy sky rose june april summer autumn max bill sue pat art frank rich chase dawn drew gene glen guy jack jay jean lane lee nick page penny ray reed rob sandy sage skip ty win bob dean miles hunter river".split(
    " ",
  ),
);
// Words that open a sentence with a comma but aren't someone being addressed.
const NOT_A_NAME = new Set(
  "okay ok so yes yeah yep no well alright right now also guys everyone everybody team folks hey oh um uh please sure cool great and but then first second next last finally honestly actually basically wait sorry thanks".split(
    " ",
  ),
);
// Openers skipped before looking for someone being addressed ("Okay, Alice, can you…").
const OPENERS = /^(?:(?:okay|ok|so|and|alright|all right|um+|uh+|yeah|also|then)\b[,.]?\s+)*/i;
// A reply to a request, in the first person: "Yes, I will order them today.", "Sure, I'll do it.", "Okay, will do."
const AFFIRM_RE = /^(?:(?:yes|yeah|yep|yup|sure|okay|ok|alright|all\s+right|absolutely|definitely|of\s+course|no\s+problem|sounds\s+good|got\s+it)\b[,.!]?\s*)+/i;
const COMMIT_RE = /^(?:i(?:'ll|\s+will|\s+can|\s+could|'m\s+going\s+to|\s+am\s+going\s+to|'m\s+gonna|'m\s+on\s+it)|will\s+do|can\s+do|on\s+it)\b/i;
// Words that point back at what was just asked ("order them", "do it", "handle that"; not "print this poster").
const BACK_RE = /\b(?:it|them)\b|\b(?:that|this|those|these)(?=\s*(?:[.!?,;]|$)|\s+(?:too|first|again|as\s+well|right\s+away)\b)/i;
const SOON_RE = /\b(?:today|tonight|tomorrow|right\s+now|now|asap|soon|later)\b/gi;

type Action = { strong: boolean; owner: string | null; due: string | null };

type Sentence = {
  i: number;
  t: number;
  end: number;
  text: string;
  words: number;
  score: number;
  content: number;
  decision: boolean;
  emphasis: boolean;
  action: Action | null;
};

type RosterName = { name: string; re: RegExp; strict: boolean };

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

/**
 * Segments → sentences with a start and end time. Splits on . ! ?; soft-splits run-ons over 45 words at commas
 * and "and then / however / okay so"; hard-splits anything still over 60 words (ASR without punctuation).
 * Times inside a segment are spread by character share when the segment has an end.
 */
function toSentences(segments: KeyPointSegment[]): Sentence[] {
  const out: Sentence[] = [];
  const sorted: KeyPointSegment[] = [];
  for (const seg of segments
    .filter((x) => x && typeof x.text === "string" && x.text.trim())
    .slice()
    .sort((a, b) => (Number(a.s) || 0) - (Number(b.s) || 0))) {
    // A segment cut mid-sentence (a live window's edge, the 40-word cap) continues in the next one.
    const last = sorted[sorted.length - 1];
    if (last && !/[.!?]["')\]]?$/.test(last.text.trim()) && wordCount(last.text) < 80) {
      sorted[sorted.length - 1] = { s: last.s, e: seg.e ?? null, text: `${last.text.trim()} ${seg.text.trim()}` };
    } else sorted.push(seg);
  }
  for (let si = 0; si < sorted.length; si++) {
    const seg = sorted[si];
    const raw = seg.text.normalize("NFC").replace(/\s+/g, " ").trim();
    const t0 = Math.max(0, Number(seg.s) || 0);
    const nextStart = sorted[si + 1] ? Number(sorted[si + 1].s) || 0 : null;
    const segEnd = typeof seg.e === "number" && seg.e > t0 ? seg.e : null;

    const soft: string[] = [];
    // Whisper often joins sentences with a comma; someone being addressed starts a new one ("…full extension,
    // Alice, can you order…").
    for (const p of raw.split(/(?<=[.!?])\s+|,\s+(?=\p{Lu}[\p{L}\p{M}'-]+,\s+(?:(?:can|could|would|will)\s+you|you(?:'re|\s+are)|please)\b)/u)) {
      const s = p.trim();
      if (!s) continue;
      if (wordCount(s) <= 45) {
        soft.push(s);
        continue;
      }
      let buf = "";
      for (const chunk of s.split(/(?<=,)\s+|\s+(?=(?:and then|but then|so then|however|okay so|alright so)\b)/i)) {
        buf = buf ? `${buf} ${chunk}` : chunk;
        if (wordCount(buf) >= 28) {
          soft.push(buf.trim());
          buf = "";
        }
      }
      if (buf.trim()) soft.push(buf.trim());
    }
    const pieces: string[] = [];
    for (const s of soft) {
      if (wordCount(s) <= 60) {
        pieces.push(s);
        continue;
      }
      const ws = s.split(/\s+/);
      for (let k = 0; k < ws.length; k += 30) pieces.push(ws.slice(k, k + 30).join(" "));
    }

    // Without an end (a saved transcript line), assume ~400 ms a word, up to the next segment.
    const spoken = pieces.reduce((n, p) => n + wordCount(p), 0) * 400;
    const span = segEnd !== null ? segEnd - t0 : Math.max(0, Math.min(nextStart === null ? spoken : nextStart - t0, spoken));
    const totalChars = pieces.reduce((n, p) => n + p.length, 0) || 1;
    let acc = 0;
    for (const text of pieces) {
      const t = Math.round(t0 + (span * acc) / totalChars);
      acc += text.length;
      const end = Math.round(t0 + (span * acc) / totalChars);
      out.push({ i: out.length, t, end, text, words: wordCount(text), score: 0, content: 0, decision: false, emphasis: false, action: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Owners and deadlines
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Edges of a name, for regexes with the `u` flag. `\b` only knows ASCII letters, so it never matches after "José"
// or before "Émile". A name may be followed by 's / 'll, but not be the end of "O'Neil" or "Mary-Jo".
const NAME_START = "(?<![\\p{L}\\p{N}\\p{M}_'-])";
const NAME_END = "(?![\\p{L}\\p{N}\\p{M}_])";

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function buildRoster(roster: string[] | undefined): RosterName[] {
  const seen = new Set<string>();
  const out: RosterName[] = [];
  for (const raw of roster ?? []) {
    // NFC, so "José" typed with a combining accent matches the transcript's; the transcript's apostrophes are straight.
    const name = String(raw || "").normalize("NFC").replace(/’/g, "'").trim().split(/\s+/)[0] ?? "";
    const key = name.toLowerCase();
    if (name.length < 2 || !/^\p{L}[\p{L}\p{M}'-]*$/u.test(name) || seen.has(key)) continue;
    seen.add(key);
    const strict = AMBIGUOUS_NAMES.has(key) || STOP.has(key) || COMMON.has(key);
    const display = capitalize(name);
    out.push({
      name: display,
      re: strict
        ? new RegExp(`${NAME_START}${escapeRe(display)}${NAME_END}`, "gu")
        : new RegExp(`${NAME_START}${escapeRe(name)}${NAME_END}`, "giu"),
      strict,
    });
  }
  return out;
}

/** Whether `text` names this person. Ambiguous names must be capitalised and not open the sentence (unless "Will, …"). */
function mentions(r: RosterName, text: string): boolean {
  r.re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = r.re.exec(text)) !== null) {
    if (!r.strict) return true;
    const initial = !/[\p{L}\p{N}]/u.test(text.slice(0, m.index));
    if (!initial || text[m.index + m[0].length] === ",") return true;
  }
  return false;
}

/** Someone addressed at the start: "Alice, can you…", "Okay, Ben, you're in charge of…", "Will, please…". */
function addressee(text: string, roster: RosterName[]): string | null {
  const rest = text.replace(OPENERS, "");
  const m = /^(\p{Lu}[\p{L}\p{M}'-]+),\s+(?:(?:can|could|would|will)\s+you|you(?:'re|\s+are)|please|i\s+need\s+you|make\s+sure)\b/u.exec(rest);
  if (!m || NOT_A_NAME.has(m[1].toLowerCase())) return null;
  return roster.find((r) => r.name.toLowerCase() === m[1].toLowerCase())?.name ?? m[1];
}

/** A team member who is the one doing it: addressed, or the subject ("Alice will…"), or assigned ("ask Ben to…"). */
function doer(text: string, roster: RosterName[]): string | null {
  const addressed = addressee(text, roster);
  if (addressed) return addressed;
  for (const r of roster) {
    if (!mentions(r, text)) continue;
    const n = escapeRe(r.name);
    const doing = new RegExp(
      `${NAME_START}${n}(?:'ll|\\s+(?:will|is\\s+going\\s+to|is\\s+gonna|needs\\s+to|has\\s+to|should|can|could|is\\s+in\\s+charge|is\\s+responsible|takes?|volunteered))\\b|\\b(?:assign(?:ed)?\\s+to|ask(?:ed)?|have|has|let|tell|told|get)\\s+${n}${NAME_END}`,
      r.strict ? "u" : "iu",
    );
    if (doing.test(text)) return r.name;
  }
  return null;
}

/** For an assignment: who does it — the doer, or the one team member it names (two names → "A and B"). */
function owner(text: string, roster: RosterName[]): string | null {
  const d = doer(text, roster);
  if (d) return d;
  const hits = roster.filter((r) => mentions(r, text));
  if (!hits.length || hits.length > 2) return null;
  return hits.map((h) => h.name).join(" and ");
}

const DATE_WORDS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/gi;

/** A deadline for a to-do label: "by Friday", "by October 31", "in two weeks", "before Saturday". */
function deadlineLabel(raw: string): string {
  const d = raw
    .toLowerCase()
    .replace(DATE_WORDS, (w) => capitalize(w))
    .replace(/\s+/g, " ");
  if (/^(?:by|before|in|at)\s/.test(d)) return d;
  if (/^(?:until|till|on)\s/.test(d)) return d.replace(/^\w+\s/, "by ");
  return `by ${d}`;
}

// ---------------------------------------------------------------------------
// Bullet text
// ---------------------------------------------------------------------------

// Fillers, and the room addressed ("Okay team, …", "Everyone, …").
const LEAD =
  /^(?:(?:so|okay|ok|alright|all right|um+|uh+|yeah|yes|well|and|but|right|now|anyway|basically)\b[,.]?\s+|(?:like|you know|i mean|team|guys|everyone|everybody|folks),\s+)+/i;

/** At most `n` characters: cut at a word boundary with "…" (punctuation kept when it fits). */
function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${cleanPhrase(s.slice(0, n).replace(/\s+\S*$/, ""))}…`;
}

/** A transcript sentence as a tidy bullet: no leading "So, okay," or um/uh, no stutters, capitalised, punctuated. */
export function cleanBulletText(text: string): string {
  let x = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEAD, "")
    .replace(/\b(?:um+|uh+|erm?)\b,?\s*/gi, "")
    .replace(/,?\s*\b(?:you know|I mean)\b\s*,\s*/gi, " ")
    .replace(/\b(\w+)(\s+\1\b)+/gi, "$1")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.\-—]+/, "")
    .replace(/[\s,;:\-—]+$/, "")
    .replace(/[,;:]+([.!?])$/, "$1");
  if (!/[\p{L}\p{N}]/u.test(x)) return "";
  x = capitalize(x);
  if (!/[.!?…]$/.test(x)) x += ".";
  return clip(x, POINT_MAX);
}

/**
 * Lower-cases the first letter after a "Decision: " / "To do: " prefix when it's an ordinary word — or, for a
 * request turned into an instruction ("order the motors"), whenever it isn't a name or an acronym.
 */
function lowerFirstWord(text: string, roster: RosterName[], imperative = false): string {
  const m = /^(\p{L}[\p{Ll}\p{M}']*)(?![\p{L}\p{M}\p{N}_])/u.exec(text);
  if (!m) return text;
  const w = m[1];
  const lw = w.toLowerCase();
  const base = lw.replace(/'.*$/, "");
  if (base === "i" || roster.some((r) => r.name.toLowerCase() === base)) return text;
  if (!imperative && !STOP.has(base) && !COMMON.has(lw) && !COMMON.has(stem(lw))) return text;
  return lw + text.slice(w.length);
}

/**
 * "Alice, can you order the motors by Friday?" → "Order the motors." (owner and deadline go in the label).
 * `imperative`: the sentence was rewritten into an instruction.
 */
function actionText(sentence: string, who: string | null, due: string | null): { text: string; imperative: boolean } {
  let x = cleanBulletText(sentence).replace(OPENERS, "");
  if (due) {
    // The deadline is in the label: take it out of the sentence (unless little would be left).
    const raw = escapeRe(due.replace(/^by\s+/i, ""));
    const without = x.replace(new RegExp(`(?:^|,?\\s+)(?:(?:by|before|until|till|on)\\s+)?${raw}\\b,?`, "i"), "").trim();
    if (wordCount(without) >= 3) x = without;
  }
  let imperative = false;
  if (who && !who.includes(" and ")) {
    const n = escapeRe(who);
    const rewritten = x
      .replace(new RegExp(`^${n}(?:,\\s*|\\s+(?=(?:can|could|would|will)\\s+you\\b))(?:(?:can|could|would|will)\\s+you\\s+)?(?:please\\s+)?`, "iu"), "")
      // "Alice will…", or a clause "…, so Alice will…": keep what she'll do.
      .replace(new RegExp(`^(?:.*?,\\s*(?:(?:so|and|then)\\s+)?)?${n}(?:'ll|\\s+(?:will|is\\s+going\\s+to|is\\s+gonna|needs\\s+to|has\\s+to|should))\\s+`, "iu"), "");
    imperative = rewritten !== x;
    x = rewritten.replace(new RegExp(`,?\\s+${n}([.!?])$`, "iu"), "$1");
  }
  const asked = x.replace(/^(?:(?:can|could|would|will)\s+you\s+)?please\s+/i, "").replace(/^(?:can|could|would|will)\s+you\s+/i, "");
  imperative ||= asked !== x;
  return { text: cleanBulletText(asked.replace(/\?$/, ".")), imperative };
}

function stripLabel(text: string): string {
  return text.replace(/^(?:Decision|To do(?: \([^)]*\))?):\s*/i, "");
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** How much a sentence sounds like meeting content rather than chat (0 = not a candidate). */
function contentScore(s: Sentence): number {
  if (s.words < 10 || s.words > 50) return 0;
  const content = tokens(s.text).filter((w) => w && w.length >= 3 && !STOP.has(w)).length;
  const ratio = content / s.words;
  if (ratio < 0.25) return 0;
  const fillers = (s.text.match(FILLER_RE) || []).length;
  let v = (s.score * (0.4 + ratio)) / (1 + 0.45 * fillers);
  if (/\?\s*$/.test(s.text)) v *= 0.4; // a question opens a point, it isn't one
  if (/\b([A-Za-z]+)\s+\1\b/i.test(s.text)) v *= 0.6; // stutter
  if (!/[.!]\s*$/.test(s.text)) v *= 0.8; // trailing off
  return v;
}

function findAction(plain: string, roster: RosterName[]): Action | null {
  const dates = extractDates(plain);
  const due = dates.length ? deadlineLabel(dates[0].raw) : null;
  if (ACTION_FIRM_RE.test(plain) && (!IN_MEETING_RE.test(plain) || due)) {
    const who = owner(plain, roster);
    return { strong: !!who || !!due || EVENT_RE.test(plain), owner: who, due };
  }
  if (ACTION_SOFT_RE.test(plain)) {
    const who = doer(plain, roster);
    if (who) return { strong: true, owner: who, due };
  }
  return null;
}

/** The commitment in a first-person reply ("order them today" from "Yes, I will order them today."), or null. */
function replyCommitment(plain: string): string | null {
  const rest = plain.replace(AFFIRM_RE, "");
  const m = COMMIT_RE.exec(rest);
  return m ? rest.slice(m[0].length).trim() : null;
}

/** A commitment without when it happens ("by Friday", "today"). */
function withoutWhen(text: string): string {
  let x = text.replace(SOON_RE, " ");
  for (const d of extractDates(x)) x = x.split(d.raw).join(" ");
  return x.replace(/\s+/g, " ").trim();
}

/**
 * A reply isn't a to-do of its own: "Alice, can you order the motors by Friday?" — "Yes, I will order them today."
 * A first-person reply without an owner that answers a request just before it (pointing back at it, or only
 * repeating it) is folded into that request, which takes the reply's deadline when it had none. A bare reply
 * ("Sure, I'll do it.", "Okay, will do.") is dropped even with no request in sight. A reply that adds something
 * ("Yes, and I'll order new wheels too.") stays a to-do.
 */
function foldReplies(sents: Sentence[]): void {
  for (let k = 0; k < sents.length; k++) {
    const s = sents[k];
    if (!s.action || s.action.owner) continue;
    const commitment = replyCommitment(s.text.replace(/’/g, "'"));
    if (commitment === null) continue;
    const what = withoutWhen(commitment);
    const words = tokens(what)
      .filter((w) => w && !STOP.has(w))
      .map(stem);
    const pointsBack = BACK_RE.test(what);
    let request: Action | null = null;
    let asked = new Set<string>();
    for (let j = k - 1; j >= Math.max(0, k - 2) && s.t - sents[j].end <= REPLY_GAP_MS; j--) {
      if (sents[j].action) {
        request = sents[j].action;
        asked = new Set(tokens(sents[j].text).map(stem));
        break;
      }
    }
    if (request) {
      if (!pointsBack && words.some((w) => !asked.has(w))) continue;
      if (!request.due && s.action.due) {
        request.due = s.action.due;
        request.strong = true;
      }
      s.action = null;
    } else if (!words.length || (pointsBack && words.length <= 1)) {
      s.action = null;
    }
  }
}

function analyze(segments: KeyPointSegment[], roster: RosterName[]): Sentence[] {
  const sents = toSentences(segments);
  const weights = buildTermWeights(sents.map((s) => s.text));
  for (const s of sents) {
    const plain = s.text.replace(/’/g, "'");
    s.decision = DECISION_RE.test(plain);
    s.emphasis = EMPHASIS_RE.test(plain);
    s.action = findAction(plain, roster);
  }
  foldReplies(sents);
  for (const s of sents) {
    // A decision reads better as a to-do only when it says who does what by when.
    if (s.decision && s.action && !(s.action.owner || s.action.due)) s.action = null;
    if (s.decision && s.action) s.decision = false;

    let v = 0;
    let cnt = 0;
    for (const w of tokens(s.text)) {
      if (!w || STOP.has(w) || w.length < 3) continue;
      v += weights.get(stem(w)) || 0;
      cnt++;
    }
    let sc = cnt ? v / Math.sqrt(cnt) : 0;
    if (s.words < 6) sc *= 0.35;
    if (s.words > 45) sc *= 0.8;
    if (s.decision) sc *= 2.0;
    if (s.action) sc *= 1.8;
    if (s.emphasis) sc *= 1.6;
    s.score = sc;
  }
  for (const s of sents) s.content = contentScore(s);
  return sents;
}

/**
 * Each mark goes to the sentence that had just FINISHED (within 15 s) — people press after hearing it — or, when
 * none had, the one being said or starting within 4 s. Returns sentence index → marks, plus marks with no sentence.
 */
function attachMarks(sents: Sentence[], marks: number[]): { hit: Map<number, number>; loose: number[] } {
  const hit = new Map<number, number>();
  const loose: number[] = [];
  for (const mk of [...marks].filter((m) => Number.isFinite(m) && m >= 0).sort((a, b) => a - b)) {
    let best: Sentence | null = null;
    for (const s of sents) {
      if (s.end > mk) break;
      if (mk - s.end > MARK_LOOKBACK_MS) continue;
      best = s;
    }
    if (!best) {
      for (const s of sents) {
        if ((s.t <= mk + 1200 && s.end >= mk) || (s.t >= mk && s.t - mk <= 4000)) {
          best = s;
          break;
        }
      }
    }
    if (best) hit.set(best.i, (hit.get(best.i) || 0) + 1);
    else if (!loose.length || mk - loose[loose.length - 1] > 5000) loose.push(mk);
  }
  return { hit, loose };
}

function formatPoint(s: Sentence, roster: RosterName[]): { text: string; kind: KeyPointKind } {
  if (s.action) {
    const { owner: who, due } = s.action;
    const label = [who, due].filter(Boolean).join(", ");
    const body = actionText(s.text, who, due);
    return { text: `To do${label ? ` (${label})` : ""}: ${lowerFirstWord(body.text, roster, body.imperative)}`, kind: "action" };
  }
  if (s.decision) return { text: `Decision: ${lowerFirstWord(cleanBulletText(s.text), roster)}`, kind: "decision" };
  return { text: cleanBulletText(s.text), kind: "point" };
}

/**
 * The key points of a transcript: decisions, to-dos (with owner and deadline when said), emphasised points,
 * marked moments, and the most content-rich sentences — spread over the meeting (one per 30 s window, except that
 * decisions, to-dos with an owner and marks may share one; none within 8 s of another), between `min` (5) and `max`
 * (10) when there's enough text, sorted by time. Marks with no transcript near them become "Key moment." placeholders
 * for the admin to fill in.
 */
export function generateKeyPoints(segments: KeyPointSegment[], opts: KeyPointOptions = {}): KeyPoint[] {
  const roster = buildRoster(opts.roster);
  const maxN = Math.max(1, Math.min(20, Math.round(opts.max ?? 10)));
  const sents = analyze(segments, roster);
  const { hit, loose } = attachMarks(sents, opts.marks ?? []);
  const looseMarks: KeyPoint[] = loose.map((atMs) => ({ atMs, text: "Key moment.", kind: "point", marked: true }));
  if (!sents.length) return looseMarks;

  const eligible = sents.filter((s) => s.words >= 5).length;
  const span = sents[sents.length - 1].end - sents[0].t;
  const windowMs = Math.min(WINDOW_MS, Math.max(5000, span / 20));
  const nearMs = Math.min(NEAR_MS, windowMs / 2);
  const minN = Math.min(Math.max(0, Math.round(opts.min ?? 5)), maxN, Math.ceil(eligible / 3));

  // Weights from VoiceCollector's recap picker, re-tuned for meetings.
  const pool = new Map<number, number>();
  const add = (s: Sentence, w: number, minWords = 5) => {
    if (s.words < minWords || w <= 0) return;
    pool.set(s.i, (pool.get(s.i) || 0) + w);
  };
  for (const [i, n] of hit) add(sents[i], 6 * n, 3);
  for (const s of sents) {
    if (s.decision) add(s, 5);
    if (s.action) add(s, s.action.strong ? 5 : 4);
    if (s.emphasis) add(s, 3.5);
  }
  let maxContent = 0;
  for (const s of sents) if (s.content > maxContent) maxContent = s.content;
  if (maxContent > 0) {
    const top = sents
      .filter((s) => s.content > 0)
      .sort((a, b) => b.content - a.content)
      .slice(0, Math.max(10, maxN * 2));
    for (const s of top) add(s, (2 * s.content) / maxContent);
  }

  const cands = [...pool.entries()].map(([i, w]) => ({ s: sents[i], w })).sort((a, b) => b.w - a.w || a.s.t - b.s.t);
  const vectors = new Map<number, Map<string, number>>();
  // Near-duplicates by distinctive words (a topic word said all meeting long doesn't make two sentences the same).
  const place = buildPlaceWeights(sents.map((s) => s.text));
  const vec = (s: Sentence) => {
    let v = vectors.get(s.i);
    if (!v) vectors.set(s.i, (v = termVector(s.text, place.weights, place.fallback)));
    return v;
  };
  const picked: Sentence[] = [];
  const duplicate = (s: Sentence) => picked.some((p) => cosine(vec(p), vec(s)) > 0.8);
  const usedWindow = new Set<number>();
  for (const c of cands) {
    if (picked.length >= maxN) break;
    const win = Math.floor(c.s.t / windowMs);
    // Decisions, to-dos with an owner and marked moments may share a window (two said in a row are both wanted).
    const firm = !!(c.s.decision || c.s.action?.owner || hit.has(c.s.i));
    if (usedWindow.has(win) && picked.length >= minN && !firm) continue;
    if (usedWindow.has(win) && picked.some((p) => Math.abs(p.t - c.s.t) < nearMs)) continue;
    if (duplicate(c.s)) continue;
    usedWindow.add(win);
    picked.push(c.s);
  }
  if (picked.length < minN) {
    for (const c of cands) {
      if (picked.length >= minN) break;
      if (!picked.includes(c.s) && !duplicate(c.s)) picked.push(c.s);
    }
  }

  const points: KeyPoint[] = picked.map((s) => {
    const { text, kind } = formatPoint(s, roster);
    return hit.has(s.i) ? { atMs: s.t, text, kind, marked: true } : { atMs: s.t, text, kind };
  });
  return [...points, ...looseMarks].sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
}

/**
 * Combines Chrome summarizer bullets with the extractive list: the summarizer's narrative points, each linked to
 * the part of the transcript it is closest to (when one is close enough), plus the extractive decisions, to-dos
 * and marked moments. Near-duplicates (cosine > 0.6) keep the extractive version, which carries the owner and
 * deadline. At most `max` (12), sorted by time (points without a time last). No bullets → the extractive list.
 */
export function mergeKeyPoints(
  summarizerBullets: string[],
  extractive: KeyPoint[],
  segments: KeyPointSegment[],
  opts: { max?: number } = {},
): KeyPoint[] {
  const max = Math.max(1, opts.max ?? 12);
  const bullets = summarizerBullets.map((b) => cleanBulletText(b.replace(/\*\*|__/g, ""))).filter(Boolean);
  if (!bullets.length) return extractive.slice(0, max);

  const sents = toSentences(segments);
  const { weights, fallback } = buildPlaceWeights(sents.map((s) => s.text));
  const vector = (text: string) => termVector(text, weights, fallback);
  const sentVecs = sents.map((s) => vector(s.text));
  const keep = extractive.filter((p) => p.kind !== "point" || p.marked);
  const keepVecs = keep.map((p) => vector(stripLabel(p.text)));

  // A bullet usually sums up a few sentences: compare it with each run of up to 3 sentences (within 60 s), then
  // link it to the best-matching sentence of the best run.
  const timeFor = (v: Map<string, number>): number | null => {
    let bestRun = -1;
    let bestScore = 0;
    for (let i = 0; i < sents.length; i++) {
      const run = new Map<string, number>();
      for (let j = i; j < Math.min(sents.length, i + 3) && sents[j].t - sents[i].t <= 60_000; j++) {
        for (const [k, x] of sentVecs[j]) run.set(k, (run.get(k) || 0) + x);
      }
      const c = cosine(run, v);
      if (c > bestScore) {
        bestScore = c;
        bestRun = i;
      }
    }
    if (bestRun < 0 || bestScore < 0.2) return null;
    let best = bestRun;
    for (let j = bestRun + 1; j < Math.min(sents.length, bestRun + 3); j++) {
      if (cosine(sentVecs[j], v) > cosine(sentVecs[best], v)) best = j;
    }
    return sents[best].t;
  };

  const narrative: KeyPoint[] = [];
  const narrativeVecs: Map<string, number>[] = [];
  for (const b of bullets) {
    const v = vector(b);
    if (narrativeVecs.some((x) => cosine(x, v) > 0.6) || keepVecs.some((x) => cosine(x, v) > 0.6)) continue;
    narrative.push({ atMs: timeFor(v), text: b, kind: "point" });
    narrativeVecs.push(v);
  }

  // Room for at least 5 narrative points (or all of them), the rest for decisions and to-dos.
  const narrativeSlots = Math.max(max - keep.length, Math.min(narrative.length, 5));
  const chosenNarrative = narrative.slice(0, narrativeSlots);
  const chosen = [...chosenNarrative, ...keep.slice(0, max - chosenNarrative.length)];
  return chosen
    .map((p, order) => ({ p, order }))
    .sort((a, b) => {
      if (a.p.atMs === null || b.p.atMs === null) {
        if (a.p.atMs === b.p.atMs) return a.order - b.order;
        return a.p.atMs === null ? 1 : -1;
      }
      return a.p.atMs - b.p.atMs || a.order - b.order;
    })
    .map(({ p }) => p);
}
