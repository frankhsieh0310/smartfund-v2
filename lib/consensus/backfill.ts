// SmartMatch 共識雷達 — historical source/event backfill (Phase 9). No AI free-write.
//
// Walks a bounded window of REAL public history (SEC EDGAR 8-K / 6-K / DEF 14A earnings-release
// exhibits + official Fed / White House feeds) for a small Tier-1 set of people, hydrates the
// original document, attributes it strictly, dedups on the canonical event key, and classifies
// cache-first. While the AI Gateway is billing-blocked every genuine historical statement still
// lands as a raw NEEDS_REVIEW event (real URL, real historical event_at, evidence text kept) — it
// is NEVER given a guessed stance and NEVER a synthetic row. When billing clears the existing
// reprocess worker drains the same backlog.
//
// Hard rules honoured here:
//   - NO SOURCE => NO EVENT. Content gone / body too thin => skip, don't guess.
//   - classification only ever sees the ORIGINAL text at the historical time — no future prices,
//     no forward returns, no lookahead. (classifyConsensusEvent's prompt already forbids this.)
//   - bounded: MAX_ITEMS_PER_SOURCE_PER_RUN / MAX_EVENTS_PER_RUN / MAX_AI_CALLS_PER_BACKFILL_RUN.
//   - checkpointed: consensus_meta key `backfill:<source-slug>` keeps
//     { oldest_processed_at, newest_processed_at, processed_count, done }.
//   - a historical flip may be written but must not push (flipDetect ALERT_MAX_AGE_HOURS guard).

import { hydrateBody, decodeEntities } from "./sourceFetch";
import { attributePerson, type PersonRef } from "./attribution";
import {
  classifyConsensusEvent, contentHashFor, EXTRACTION_VERSION, DEFAULT_EXTRACTION_MODEL,
  type CachePort,
} from "./extractionContract";
import { persistConsensusEvent, type QueryFn } from "./persistEvent";

export const BACKFILL_DEFAULT_DAYS = Number(process.env.CONSENSUS_BACKFILL_DAYS) || 180;
export const MAX_ITEMS_PER_SOURCE_PER_RUN = Number(process.env.CONSENSUS_BACKFILL_MAX_ITEMS_PER_SOURCE) || 100;
export const MAX_EVENTS_PER_RUN = Number(process.env.CONSENSUS_BACKFILL_MAX_EVENTS) || 100;
export const MAX_AI_CALLS_PER_BACKFILL_RUN = Number(process.env.CONSENSUS_BACKFILL_MAX_AI_CALLS) || 50;
const TIME_BUDGET_MS = Number(process.env.CONSENSUS_BACKFILL_TIME_BUDGET_MS) || 240_000;

const SEC_UA = "SmartMatchConsensusBot/1.0 (+https://smartfund-v2.vercel.app)";
const SEC_FORMS = new Set(["8-K", "8-K/A", "6-K", "6-K/A", "DEF 14A"]);

// Tier-1 people for round one of the backfill (~14). Not all 44.
export const TIER1_PERSON_SLUGS = [
  "donald-trump", "jerome-powell", "scott-bessent", "jensen-huang", "sundar-pichai",
  "mark-zuckerberg", "elon-musk", "lisa-su", "cc-wei", "jamie-dimon",
  "larry-fink", "warren-buffett", "cathie-wood", "darren-woods", "mike-wirth",
];

// ---------------------------------------------------------------------------
// deterministic keyword priority — spend the scarce AI budget on statements that
// actually carry a market view (earnings call / prepared remarks / speech / press
// conference / interview / shareholder letter / policy remarks), not on routine
// filings / personnel / legal boilerplate / generic CSR.
// ---------------------------------------------------------------------------
const HIGH = /\b(earnings call|prepared remarks|conference call|results? (of operations|for|call)|financial results|quarterly results|shareholder letter|letter to shareholders|annual letter|press conference|fireside chat|keynote|remarks (by|as prepared|at)|speech|testimony|interview|outlook|guidance|forecast|we expect|we anticipate|demand (is|remains|for)|record (revenue|quarter)|raising our|lowering our)\b/i;
const LOW = /\b(appoint|appointment|resignation|resigned|retire(ment)?|elect(ion|ed) of directors|board of directors|by-?laws?|amendment to|credit agreement|indenture|notes? offering|prospectus|registration statement|litigation|settlement of|shell company|item 5\.0[27]|regulation fd|section 16|form of (award|indemn)|equity plan|sustainability report|corporate (social )?responsibility|esg report|diversity report|charitable)\b/i;

export function backfillPriority(title: string, text: string): { score: number; bucket: "HIGH" | "MEDIUM" | "LOW" } {
  const hay = `${title}\n${text.slice(0, 4000)}`;
  const high = HIGH.test(hay);
  const low = LOW.test(hay);
  if (high && !low) return { score: 3, bucket: "HIGH" };
  if (high && low) return { score: 2, bucket: "MEDIUM" };
  if (low) return { score: 0, bucket: "LOW" };
  return { score: 1, bucket: "MEDIUM" };
}

// ---------------------------------------------------------------------------
// checkpoints — stored in consensus_meta (zero schema change)
// ---------------------------------------------------------------------------
export type BackfillCheckpoint = {
  oldest_processed_at: string | null;
  newest_processed_at: string | null;
  processed_count: number;
  done: boolean;
  updated_at: string;
};

const cpKey = (slug: string) => `backfill:${slug}`;

export async function readBackfillCheckpoint(query: QueryFn, slug: string): Promise<BackfillCheckpoint | null> {
  const rows = await query<{ value: BackfillCheckpoint }>(
    `select value from consensus_meta where key = $1`, [cpKey(slug)],
  );
  return rows[0]?.value ?? null;
}

async function writeBackfillCheckpoint(query: QueryFn, slug: string, cp: BackfillCheckpoint): Promise<void> {
  await query(
    `insert into consensus_meta (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [cpKey(slug), JSON.stringify(cp)],
  );
}

export async function readAllBackfillCheckpoints(query: QueryFn): Promise<Array<{ slug: string } & BackfillCheckpoint>> {
  const rows = await query<{ key: string; value: BackfillCheckpoint }>(
    `select key, value from consensus_meta where key like 'backfill:%' order by key`, [],
  );
  return rows.map((r) => ({ slug: r.key.replace(/^backfill:/, ""), ...r.value }));
}

// ---------------------------------------------------------------------------
// SEC EDGAR historical crawl — recent[] shard covers well over 180 days for a
// single active issuer; bounded + windowed, prefers the EX-99 earnings exhibit.
// ---------------------------------------------------------------------------
type HistItem = { url: string; title: string; text: string; publishedAt: string; form: string };

async function fetchSecHistorical(canonicalUrl: string, sinceMs: number, cap: number): Promise<HistItem[]> {
  const cik = (canonicalUrl.match(/(\d{4,10})/)?.[1] ?? "").padStart(10, "0");
  if (!cik || cik === "0000000000") return [];
  const subRes = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { "user-agent": SEC_UA, accept: "application/json" }, signal: AbortSignal.timeout(20_000),
  });
  if (!subRes.ok) throw new Error(`SEC submissions HTTP ${subRes.status}`);
  const sub = (await subRes.json()) as {
    name?: string;
    filings?: { recent?: { form?: string[]; filingDate?: string[]; accessionNumber?: string[]; primaryDocument?: string[]; primaryDocDescription?: string[] } };
  };
  const r = sub.filings?.recent;
  if (!r?.form) return [];
  const cikInt = String(parseInt(cik, 10));
  const rows: Array<{ i: number; dateIso: string }> = [];
  for (let i = 0; i < r.form.length; i++) {
    if (!SEC_FORMS.has(r.form[i])) continue;
    const dateIso = new Date(`${r.filingDate![i]}T13:00:00Z`).toISOString();
    if (Date.parse(dateIso) < sinceMs) continue;
    rows.push({ i, dateIso });
  }
  // newest-first so an interrupted run still makes forward progress toward `sinceMs`
  rows.sort((a, b) => Date.parse(b.dateIso) - Date.parse(a.dateIso));

  const out: HistItem[] = [];
  for (const { i, dateIso } of rows) {
    if (out.length >= cap) break;
    const acc = (r.accessionNumber![i] ?? "").replace(/-/g, "");
    if (!acc) continue;
    const base = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${acc}/`;
    let docName = r.primaryDocument![i] ?? "";
    try {
      const idxRes = await fetch(`${base}index.json`, { headers: { "user-agent": SEC_UA, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (idxRes.ok) {
        const idx = (await idxRes.json()) as { directory?: { item?: Array<{ name: string; size?: string }> } };
        const items = idx.directory?.item ?? [];
        const ex = items
          .filter((it) => /\.html?$/i.test(it.name) && it.name.toLowerCase() !== docName.toLowerCase())
          .sort((a, b) => {
            const score = (n: string) => (/ex-?99|press|earnings|release/i.test(n) ? 2 : 1);
            return score(b.name) - score(a.name) || Number(b.size ?? 0) - Number(a.size ?? 0);
          })[0];
        if (ex && /ex-?99|press|earnings|release/i.test(ex.name)) docName = ex.name;
      }
    } catch { /* fall back to primary document */ }
    const docUrl = `${base}${docName}`;
    let text = (await hydrateBody(docUrl, SEC_UA)) ?? "";
    const headLine = text.replace(/\s+/g, " ").trim().slice(0, 160);
    const isExhibit = /ex-?99|press|earnings|release/i.test(docName);
    const title = isExhibit && headLine.length > 25
      ? `${headLine} (${sub.name ?? "issuer"})`
      : `${r.form[i]} — ${r.primaryDocDescription?.[i] || "filing"} (${sub.name ?? "issuer"})`;
    if (!text || text.length < 200) continue; // content too thin — skip, don't guess
    out.push({ url: docUrl, title, text: text.slice(0, 12000), publishedAt: dateIso, form: r.form[i] });
  }
  return out;
}

// generic RSS/Atom historical parse (feeds are recent-only; still deduped + bounded)
async function fetchFeedHistorical(url: string, sinceMs: number, cap: number): Promise<HistItem[]> {
  const res = await fetch(url, {
    headers: { "user-agent": SEC_UA, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  const xml = await res.text();
  const strip = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  const chunks = xml.split(/<(?:item|entry)[\s>]/i).slice(1, 80);
  const out: HistItem[] = [];
  for (const chunk of chunks) {
    if (out.length >= cap) break;
    const tag = (t: string) => {
      const m = chunk.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i"));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
    };
    let link = "";
    const lm = chunk.match(/<link[^>]*href=["']([^"']+)["']/i);
    link = lm ? lm[1] : (tag("link").replace(/<[^>]+>/g, "").trim() || tag("guid").replace(/<[^>]+>/g, "").trim());
    if (!link) continue;
    const dateStr = tag("pubDate") || tag("published") || tag("updated") || tag("dc:date");
    const ts = dateStr ? Date.parse(dateStr) : NaN;
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    const title = strip(tag("title"));
    let text = strip([tag("content:encoded"), tag("content"), tag("description"), tag("summary")].filter(Boolean).join(" "));
    if (text.length < 400) {
      const body = await hydrateBody(link.trim());
      if (body && body.length > text.length) text = body;
    }
    if (!text || text.length < 200) continue;
    out.push({ url: link.trim(), title: title || link, text: text.slice(0, 12000), publishedAt: new Date(ts).toISOString(), form: "FEED" });
  }
  return out;
}

// ---------------------------------------------------------------------------
export type BackfillSource = {
  id: string; slug: string; source_type: string; source_grade: "A" | "B" | "C";
  canonical_url: string | null; person_id: string | null; is_official: boolean; fetch_method: string;
};

export type BackfillResult = {
  startDateIso: string;
  endDateIso: string;
  sourcesTried: string[];
  sourcesCompleted: string[];
  sourcesRemaining: string[];
  itemsFetched: number;
  attributed: number;
  notAttributed: number;
  lowPrioritySkipped: number;
  rawEvents: number;
  classified: number;
  needsReview: number;
  deduped: number;
  directLinks: number;
  inferredLinks: number;
  aiCalls: number;
  aiCacheHits: number;
  affectedSymbols: string[];
  oldestProcessedAt: string | null;
  perSource: Array<Record<string, unknown>>;
};

export async function runConsensusBackfill(
  query: QueryFn,
  cache: CachePort,
  opts: {
    days?: number;
    onlySlug?: string | null;
    dry?: boolean;
    maxItemsPerSource?: number;
    maxEvents?: number;
    maxAiCalls?: number;
    aiBlocked?: boolean; // when true, never even attempt a model call — straight to NEEDS_REVIEW
  } = {},
): Promise<BackfillResult> {
  const startedAt = Date.now();
  const days = Math.min(400, Math.max(7, opts.days ?? BACKFILL_DEFAULT_DAYS));
  const sinceMs = Date.now() - days * 86_400_000;
  const startDateIso = new Date(sinceMs).toISOString();
  const endDateIso = new Date().toISOString();
  const maxItems = Math.min(200, opts.maxItemsPerSource ?? MAX_ITEMS_PER_SOURCE_PER_RUN);
  const maxEvents = Math.min(300, opts.maxEvents ?? MAX_EVENTS_PER_RUN);
  const maxAiCalls = Math.min(200, opts.maxAiCalls ?? MAX_AI_CALLS_PER_BACKFILL_RUN);

  const people = (await query<PersonRef & { aliases: unknown }>(
    `select id, slug, display_name as "displayName", country, aliases from consensus_people where is_active`, [],
  )).map((p) => ({ ...p, aliases: Array.isArray(p.aliases) ? (p.aliases as string[]) : [] })) as PersonRef[];
  const tier1Ids = new Set(people.filter((p) => TIER1_PERSON_SLUGS.includes(p.slug)).map((p) => p.id));

  const sources = (await query<BackfillSource>(
    `select id, slug, source_type, source_grade, canonical_url, person_id, is_official, fetch_method
       from consensus_sources
      where is_active and status <> 'DISABLED'
        and source_grade in ('A','B')
        and fetch_method in ('SEC_EDGAR','RSS')
        ${opts.onlySlug ? "and slug = $1" : ""}
      order by case fetch_method when 'SEC_EDGAR' then 0 else 1 end, slug`,
    opts.onlySlug ? [opts.onlySlug] : [],
  )) as BackfillSource[];

  // Round one targets Tier-1: an SEC source whose CEO is Tier-1, or a Fed / White House feed.
  const inScope = sources.filter((s) =>
    (s.person_id && tier1Ids.has(s.person_id)) ||
    /^(fed-|whitehouse-|treasury-)/.test(s.slug));

  const res: BackfillResult = {
    startDateIso, endDateIso, sourcesTried: [], sourcesCompleted: [], sourcesRemaining: [],
    itemsFetched: 0, attributed: 0, notAttributed: 0, lowPrioritySkipped: 0, rawEvents: 0,
    classified: 0, needsReview: 0, deduped: 0, directLinks: 0, inferredLinks: 0,
    aiCalls: 0, aiCacheHits: 0, affectedSymbols: [], oldestProcessedAt: null,
    perSource: [],
  };
  const affected = new Set<string>();
  let oldestOverall: number | null = null;

  for (const src of inScope) {
    if (Date.now() - startedAt > TIME_BUDGET_MS || res.rawEvents >= maxEvents) {
      res.sourcesRemaining.push(src.slug);
      continue;
    }
    res.sourcesTried.push(src.slug);
    const prior = await readBackfillCheckpoint(query, src.slug);
    if (prior?.done && !opts.dry) { res.sourcesCompleted.push(src.slug); continue; }

    let items: HistItem[] = [];
    let fetchErr: string | null = null;
    try {
      if (src.fetch_method === "SEC_EDGAR" && src.canonical_url) items = await fetchSecHistorical(src.canonical_url, sinceMs, maxItems);
      else if (src.fetch_method === "RSS" && src.canonical_url) items = await fetchFeedHistorical(src.canonical_url, sinceMs, maxItems);
    } catch (e) { fetchErr = (e as Error).message.slice(0, 200); }

    if (fetchErr) { res.perSource.push({ slug: src.slug, ok: false, error: fetchErr }); res.sourcesRemaining.push(src.slug); continue; }

    const owner = src.person_id ? people.find((p) => p.id === src.person_id) ?? null : null;
    let srcRaw = 0, srcAttr = 0, srcLow = 0, srcClassified = 0;
    let srcOldest: number | null = prior?.oldest_processed_at ? Date.parse(prior.oldest_processed_at) : null;
    let srcNewest: number | null = prior?.newest_processed_at ? Date.parse(prior.newest_processed_at) : null;

    for (const it of items) {
      if (Date.now() - startedAt > TIME_BUDGET_MS || res.rawEvents >= maxEvents) break;
      res.itemsFetched++;
      const pubMs = Date.parse(it.publishedAt);
      srcOldest = srcOldest == null ? pubMs : Math.min(srcOldest, pubMs);
      srcNewest = srcNewest == null ? pubMs : Math.max(srcNewest, pubMs);
      oldestOverall = oldestOverall == null ? pubMs : Math.min(oldestOverall, pubMs);

      const attr = attributePerson({
        title: it.title, text: it.text, people,
        ownerPersonId: src.person_id, sourceIsOfficial: Boolean(src.is_official), sourceType: src.source_type,
      });
      if (!attr.attributed || !attr.person) { res.notAttributed++; continue; }
      res.attributed++; srcAttr++;
      const person = attr.person;

      const pr = backfillPriority(it.title, it.text);
      if (pr.bucket === "LOW") { res.lowPrioritySkipped++; srcLow++; continue; }
      if (opts.dry) continue;

      // classification: cache-first always; only spend a real AI call when the gateway is not
      // blocked AND we're under the per-run cap. Otherwise the genuine statement is persisted raw.
      let classification;
      const allowAi = !opts.aiBlocked && res.aiCalls < maxAiCalls;
      if (allowAi) {
        classification = await classifyConsensusEvent(
          { personDisplayName: person.displayName, personRole: null, sourceName: src.slug,
            sourceGrade: src.source_grade, sourceUrl: it.url, eventAt: it.publishedAt,
            title: it.title, rawText: it.text },
          cache,
        );
        if ("cached" in classification && classification.cached) res.aiCacheHits++;
        else res.aiCalls++;
      } else {
        // still consult the cache so a previously classified identical statement is reused
        const contentHash = contentHashFor({ personDisplayName: person.displayName, rawText: it.text });
        const hit = await cache.get({ contentHash, version: EXTRACTION_VERSION, model: DEFAULT_EXTRACTION_MODEL });
        if (hit) { classification = hit; res.aiCacheHits++; }
        else classification = {
          status: "NEEDS_REVIEW" as const,
          reason: opts.aiBlocked ? "backfill: AI gateway billing-blocked — raw historical event kept" : "backfill: AI call cap reached",
          model: DEFAULT_EXTRACTION_MODEL, version: EXTRACTION_VERSION, contentHash,
        };
      }

      const persisted = await persistConsensusEvent(query, {
        personId: person.id, personSlug: person.slug, personCountry: person.country,
        sourceId: src.id, sourceGrade: src.source_grade,
        eventAt: it.publishedAt, publishedAt: it.publishedAt, eventType: it.form,
        sourceUrl: it.url, sourceTitle: it.title, rawText: it.text, classification,
      });
      if (persisted.deduped) res.deduped++;
      else { res.rawEvents++; srcRaw++; }
      if (persisted.status === "CLASSIFIED") { res.classified++; srcClassified++; }
      else res.needsReview++;
      res.directLinks += persisted.directLinks;
      res.inferredLinks += persisted.inferredLinks;
      for (const l of [...persisted.unmappedSymbols]) affected.add(l);
    }

    // reached back to (or past) the window edge with the items we had => this source is done
    const done = items.length > 0 && items.length < maxItems &&
      (srcOldest != null && srcOldest <= sinceMs + 7 * 86_400_000);
    if (!opts.dry) {
      await writeBackfillCheckpoint(query, src.slug, {
        oldest_processed_at: srcOldest != null ? new Date(srcOldest).toISOString() : null,
        newest_processed_at: srcNewest != null ? new Date(srcNewest).toISOString() : null,
        processed_count: (prior?.processed_count ?? 0) + srcRaw,
        done,
        updated_at: new Date().toISOString(),
      });
    }
    (done ? res.sourcesCompleted : res.sourcesRemaining).push(src.slug);
    res.perSource.push({
      slug: src.slug, grade: src.source_grade, method: src.fetch_method, ok: true,
      items: items.length, attributed: srcAttr, lowPrioritySkipped: srcLow,
      rawEvents: srcRaw, classified: srcClassified, done,
      oldest: srcOldest != null ? new Date(srcOldest).toISOString() : null,
    });
  }

  // sources we never got to this run
  for (const s of inScope) {
    if (!res.sourcesTried.includes(s.slug) && !res.sourcesRemaining.includes(s.slug)) res.sourcesRemaining.push(s.slug);
  }
  res.affectedSymbols = [...affected];
  res.oldestProcessedAt = oldestOverall != null ? new Date(oldestOverall).toISOString() : null;
  return res;
}

// health snapshot for freshness.ts
export async function consensusBackfillStatus(query: QueryFn) {
  const cps = await readAllBackfillCheckpoints(query);
  const hist = (await query<{ raw: number; classified: number; nr: number; oldest: string | null }>(
    `select
       count(*)::int raw,
       count(*) filter (where extraction_status='CLASSIFIED')::int classified,
       count(*) filter (where extraction_status='NEEDS_REVIEW')::int nr,
       min(event_at) oldest
     from consensus_events
     where event_at < now() - interval '35 days'`, [],
  ))[0] ?? { raw: 0, classified: 0, nr: 0, oldest: null };
  const matured = (await query<{ m1: number; m3: number; m6: number }>(
    `select
       count(*) filter (where hit_1m is not null)::int m1,
       count(*) filter (where hit_3m is not null)::int m3,
       count(*) filter (where hit_6m is not null)::int m6
     from consensus_signal_performance`, [],
  ))[0] ?? { m1: 0, m3: 0, m6: 0 };

  const completed = cps.filter((c) => c.done).map((c) => c.slug);
  const remaining = cps.filter((c) => !c.done).map((c) => c.slug);
  const oldestCp = cps.map((c) => c.oldest_processed_at).filter(Boolean).sort()[0] ?? null;
  const started = cps.length > 0;
  const status = !started ? "NOT_STARTED" : remaining.length === 0 ? "COMPLETE" : "IN_PROGRESS";

  return {
    backfill_status: status,
    backfill_start_date: started ? new Date(Date.now() - BACKFILL_DEFAULT_DAYS * 86_400_000).toISOString().slice(0, 10) : null,
    backfill_oldest_processed_at: oldestCp,
    backfill_sources_completed: completed,
    backfill_sources_remaining: remaining,
    historical_events: Number(hist.raw) || 0,
    historical_classified: Number(hist.classified) || 0,
    historical_needs_review: Number(hist.nr) || 0,
    matured_1m: Number(matured.m1) || 0,
    matured_3m: Number(matured.m3) || 0,
    matured_6m: Number(matured.m6) || 0,
  };
}
