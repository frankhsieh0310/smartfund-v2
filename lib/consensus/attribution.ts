// SmartMatch 共識雷達 — strict person attribution (Phase 2, STEP 6; hardened per P0 speaker-validation fix).
//
// A statement is persisted as a person's event ONLY when the source actually reports THAT person
// speaking in the first person. A name-drop in an article is never enough — and, critically, a
// quote is only ever credited to a tracked person when THAT PERSON is the grammatical subject of
// the nearest attribution verb ("X said", "said X", "according to X"). A tracked person merely
// mentioned near someone else's quote ("Analyst said the chip cycle is turning. Jensen Huang has
// previously argued...") must NOT be attributed the quote. Two accepted shapes:
//
//   A. Official single-principal source (the person's own newsroom / a Fed speaker page): the item
//      TITLE reads as a first-person statement ("Remarks / Statement / Speech / Interview / ...")
//      AND the principal is the nearest verb's subject for at least one quote/attribution in the doc.
//   B. A wire/agency article: the principal's FULL display name is the subject (appears in the
//      title or the first 300 chars) AND the principal is the nearest verb's subject for a
//      quotation, with exactly one whitelisted person qualifying that way.
//
// Everything else -> candidate only, not persisted (ATTRIBUTION_STRICT). Better to miss a real
// statement than to attribute the wrong person's words.

export type PersonRef = { id: string; slug: string; displayName: string; aliases: string[]; country: string | null };

const SAY_VERBS_LIST = ["said", "says", "say", "told", "adds", "add", "added", "wrote", "writes", "noted", "argued", "warned", "stated", "remarked", "explained", "commented", "testified", "announced"];
const SAY_VERBS = new RegExp(`\\b(${SAY_VERBS_LIST.join("|")})\\b`, "i");
const FIRST_PERSON_TITLE = /\b(remarks?|statement|speech|address|press conference|interview|testimony|op-?ed|full transcript|issues statement|comments?)\b/i;
const NOT_FIRST_PERSON_TITLE = /\b(fact sheet|press secretary|readout|proclamation|executive order|nominations? (sent|and)|memorand|schedule|media credential|patriot day)\b/i;
const HONORIFIC = /(president|chair(man|woman)?|vice chair|governor|secretary|ambassador|ceo|chief executive|founder|treasury secretary|fed chair)/i;
const QUOTE = /["“”„«»]/g;
// A speaker-attribution window: how far a quote mark may sit from the verb+name unit that
// attributes it. Deliberately tighter than the old 200-char "anywhere nearby" window — that window
// is exactly what let an unrelated name close to a quote get credited with someone else's words.
const SPEAKER_WIN = 80;

function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  const low = hay.toLowerCase();
  const n = needle.toLowerCase();
  if (n.length < 3) return out;
  let from = 0;
  for (;;) {
    const i = low.indexOf(n, from);
    if (i < 0) break;
    out.push(i);
    from = i + n.length;
  }
  return out;
}

// Occurrences of a person: full display name, aliases, OR (surname preceded by an honorific / at a
// title's lead "Surname, ..."). Surname alone elsewhere is NOT counted. Used only to test whether a
// person is named in a region at all (title/head "is this person even discussed" checks) — NEVER by
// itself as proof that a quote belongs to them; see speakerSpans() below for that.
function personOccurrences(hay: string, p: PersonRef): number[] {
  const idxs = [...allIndexes(hay, p.displayName), ...p.aliases.flatMap((a) => allIndexes(hay, a))];
  const surname = p.displayName.split(/\s+/).slice(-1)[0];
  if (surname.length >= 5) {
    const low = hay.toLowerCase();
    const sn = surname.toLowerCase();
    let from = 0;
    for (;;) {
      const i = low.indexOf(sn, from);
      if (i < 0) break;
      const before = hay.slice(Math.max(0, i - 40), i);
      const atLead = i <= 3 && hay.slice(i + surname.length, i + surname.length + 2) === ", ";
      if (HONORIFIC.test(before) || atLead) idxs.push(i);
      from = i + sn.length;
    }
  }
  return [...new Set(idxs)].sort((a, b) => a - b);
}

// A candidate "name" token: 1-4 capitalized words (handles "Jensen Huang", "Ambassador Greer",
// "President Donald J. Trump", initials, hyphenated surnames). Generic capitalized words ("Analyst",
// "Reuters") will also match this shape — that's fine: they simply won't match any tracked person's
// name/alias/surname in spanNameMatchesPerson, so the quote correctly attributes to no one.
const NAME_TOKEN = "[A-Z][A-Za-z.'\\-]+(?:\\s+[A-Z][A-Za-z.'\\-]+){0,3}";

// Find every "<Name> <verb>", "<verb> <Name>", "according to <Name>", and "<quote>" — <Name>" unit
// in the text — the explicit grammatical attribution of a statement to someone. Each span records
// a direction: a quote may only be credited through a span whose grammar actually points at it.
// "Name said" / "Name announced" (nameVerb) introduces what comes AFTER it ("X said, 'quote'") —
// crediting a quote that comes BEFORE such a span is exactly the bug that let "President Trump
// announced [a cutter]," a clause that only introduces what follows, retroactively claim an
// unrelated preceding quote from a completely different speaker earlier in a long document.
// "said Name" / "— Name" (verbName / dash) instead closes out a quote that already appeared, so
// they only look BACKWARD. "told"/"tells" take a direct object ("X told REPORTERS, ...") and are
// excluded from the inverted (verb-then-name) direction only; "Name told ..." still works forward.
type SpeakerSpan = { index: number; name: string; direction: "forward" | "backward" };
const INVERTIBLE_VERBS = SAY_VERBS_LIST.filter((v) => v !== "told" && v !== "tells");
function speakerSpans(hay: string): SpeakerSpan[] {
  const spans: SpeakerSpan[] = [];
  const reNameVerb = new RegExp(`(${NAME_TOKEN})\\s+(?:${SAY_VERBS_LIST.join("|")})\\b`, "g");
  const reVerbName = new RegExp(`\\b(?:${INVERTIBLE_VERBS.join("|")})\\s+(${NAME_TOKEN})`, "g");
  const reAccording = new RegExp(`according to\\s+(${NAME_TOKEN})`, "gi");
  // Press-release pull-quote convention: "<quote>" — <Speaker Name>[, <title>]. The dash sits right
  // after the closing quote mark and looks back at the quote that just ended.
  const reDashAttribution = /[-–—]\s*(?:by\s+)?([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){0,3})/g;
  let m: RegExpExecArray | null;
  while ((m = reNameVerb.exec(hay))) spans.push({ index: m.index, name: m[1], direction: "forward" });
  while ((m = reVerbName.exec(hay))) spans.push({ index: m.index, name: m[1], direction: "backward" });
  while ((m = reAccording.exec(hay))) spans.push({ index: m.index, name: m[1], direction: "forward" });
  while ((m = reDashAttribution.exec(hay))) spans.push({ index: m.index, name: m[1], direction: "backward" });
  return spans;
}

const normLoose = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
function spanNameMatchesPerson(name: string, p: PersonRef): boolean {
  const candidates = [p.displayName, ...p.aliases];
  const n = normLoose(name);
  for (const c of candidates) {
    const nc = normLoose(c);
    if (!nc) continue;
    if (n === nc || n.includes(nc) || nc.includes(n)) return true;
  }
  const surname = normLoose(p.displayName.split(/\s+/).slice(-1)[0]);
  if (surname.length >= 4 && n.includes(surname)) return true;
  return false;
}

// Is `p` the speaker of AT LEAST ONE quotation in `hay`? A quote is credited to p only when the
// NEAREST speaker span (by character distance, within SPEAKER_WIN) names p — not merely because p
// is mentioned somewhere in a wide window around the quote. This is the fix for "Analyst said the
// cycle is turning; Jensen Huang has previously argued..." (nearest span to the quote is "Analyst
// said", which does not match Jensen Huang, so the quote correctly attributes to no one).
function isSpeakerOfAnyQuote(hay: string, p: PersonRef): boolean {
  const quoteIdxs: number[] = [];
  let qm: RegExpExecArray | null;
  const quoteRe = new RegExp(QUOTE.source, "g");
  while ((qm = quoteRe.exec(hay))) quoteIdxs.push(qm.index);
  if (quoteIdxs.length === 0) return false;
  const spans = speakerSpans(hay);
  if (spans.length === 0) return false;
  for (const qi of quoteIdxs) {
    let nearest: SpeakerSpan | null = null;
    let nearestDist = Infinity;
    for (const span of spans) {
      // A "forward" span (Name said / Name announced) only introduces a quote that comes AFTER it;
      // a "backward" span (said Name / — Name) only closes out a quote that came BEFORE it. This
      // is what stops a forward-looking "President Trump announced [something later]" from
      // retroactively claiming an unrelated quote from an earlier, different speaker.
      const directionOk = span.direction === "forward" ? qi >= span.index : qi <= span.index;
      if (!directionOk) continue;
      const dist = Math.abs(span.index - qi);
      if (dist <= SPEAKER_WIN && dist < nearestDist) { nearest = span; nearestDist = dist; }
    }
    if (nearest && spanNameMatchesPerson(nearest.name, p)) return true;
  }
  return false;
}

export type AttributionResult = {
  person: PersonRef | null;
  attributed: boolean;
  reason: string;
  candidatePeople: string[];
};

// The official-transcript title/name-only bypass (no quote required) is restricted to sources whose
// ENTIRE document is understood to be that person's own words or filing — never a general news
// roundup/recap, even from an official-looking government or corporate press page.
const TRANSCRIPT_TYPES = new Set(["GOV_TRANSCRIPT", "EARNINGS_CALL", "COMPANY_IR", "SEC_FILING"]);

export function attributePerson(opts: {
  title: string | null;
  text: string;
  people: PersonRef[];
  ownerPersonId?: string | null;
  sourceIsOfficial?: boolean;
  sourceType?: string | null;
}): AttributionResult {
  const title = opts.title ?? "";
  const body = opts.text ?? "";
  const hay = `${title}\n${body}`;
  const owner = opts.ownerPersonId ? opts.people.find((p) => p.id === opts.ownerPersonId) ?? null : null;

  const isTranscript = opts.sourceIsOfficial && TRANSCRIPT_TYPES.has(opts.sourceType ?? "") && !NOT_FIRST_PERSON_TITLE.test(title);

  // C. official transcript / earnings call / SEC filing / gov transcript: the doc IS the person
  //    speaking or filing — but the "just named in title, no quote needed" bypass only fires when
  //    the TITLE ITSELF unambiguously signals first-person content (remarks/speech/statement/
  //    interview/testimony/transcript). A title that merely names the tracked person on an official
  //    press page ("X Issues Statement on Y", "X Delivers Historic Results") is NOT enough — that
  //    is exactly the shape of a press release ABOUT the person, often quoting someone else
  //    entirely (a subordinate official, a different executive). Those fall through to rule A below,
  //    which requires the person to be the doc's VERIFIED quoted speaker.
  if (isTranscript && FIRST_PERSON_TITLE.test(title)) {
    // A person named in possessive form ("...on President Trump's Response...") is the TOPIC of
    // the title, not its speaker ("Ambassador Greer Issues Statement on President Trump's Response
    // to Canada" — Greer issues the statement, Trump is merely discussed) — excluded here even
    // though the bare name occurs in the title.
    const isTopicNotSpeaker = (p: PersonRef) => personOccurrences(title, p).some((i) => {
      const nameLen = [p.displayName, ...p.aliases].find((n) => title.toLowerCase().slice(i, i + n.length).toLowerCase() === n.toLowerCase())?.length ?? p.displayName.length;
      return /^['’]s\b/.test(title.slice(i + nameLen, i + nameLen + 3));
    });
    const inTitle = opts.people.filter((p) => personOccurrences(title, p).length > 0 && !isTopicNotSpeaker(p));
    if (inTitle.length === 1) return { person: inTitle[0], attributed: true, reason: "official transcript/filing, unambiguous first-person title names the speaker", candidatePeople: [] };
    if (inTitle.length > 1) return { person: null, attributed: false, reason: "transcript with multiple named speakers", candidatePeople: inTitle.map((p) => p.slug) };
    // No one qualifies via the title alone (e.g. the owner is only named in possessive/topic form,
    // as in "...on President Trump's Response...") — fall through to rule A, which requires the
    // owner to be the doc's VERIFIED quoted speaker, not merely named anywhere in it.
  }

  // A. official single-principal source — the principal must be the actual VERIFIED SPEAKER of a
  //    quotation in the doc (isSpeakerOfAnyQuote). A first-person-sounding title is no longer
  //    sufficient on its own (that was the exact gap that let "Ambassador Greer Issues Statement on
  //    President Trump's Response..." attribute to Trump, when Greer is the one actually quoted) —
  //    speaker verification is always required here; only the dedicated transcript rule (C) above,
  //    restricted to COMPANY_IR/EARNINGS_CALL/SEC_FILING/GOV_TRANSCRIPT, may skip it.
  if (owner && opts.sourceIsOfficial) {
    const nameIdx = personOccurrences(hay, owner);
    if (!NOT_FIRST_PERSON_TITLE.test(title) && isSpeakerOfAnyQuote(hay, owner)) {
      return { person: owner, attributed: true, reason: "official source, principal is the quoted speaker", candidatePeople: [] };
    }
    return {
      person: null, attributed: false,
      reason: nameIdx.length ? "official source but principal is not the quoted speaker" : "official source, principal not named",
      candidatePeople: owner ? [owner.slug] : [],
    };
  }

  // B. wire / agency article — the person must be the SPEAKER of a quotation (isSpeakerOfAnyQuote),
  //    and named in the title/head (still the subject of the piece), with exactly one qualifying.
  const head = hay.slice(0, 300);
  const qualifying: PersonRef[] = [];
  const named: string[] = [];
  for (const p of opts.people) {
    const idxs = personOccurrences(hay, p);
    if (idxs.length === 0) continue;
    named.push(p.slug);
    const inHead = personOccurrences(head, p).length > 0;
    const inTitle = personOccurrences(title, p).length > 0;
    if ((inTitle || inHead) && isSpeakerOfAnyQuote(hay, p)) qualifying.push(p);
  }
  if (qualifying.length === 1) return { person: qualifying[0], attributed: true, reason: "subject + verified speaker of a quotation in wire article", candidatePeople: [] };
  if (qualifying.length > 1) return { person: null, attributed: false, reason: "multiple qualifying speakers", candidatePeople: qualifying.map((p) => p.slug) };
  return { person: null, attributed: false, reason: named.length ? "name mentioned without being the verified speaker" : "no whitelisted person", candidatePeople: named };
}
