// P0-1 persist step — writes the 5 attributed candidates from scratch/attributed-items.json using
// the REAL persistConsensusEvent (canonical-key dedup, consensus_event_sources fan-out, DIRECT vs
// INFERRED stock links via the real resolveSymbol). Classification below was done by Claude reading
// each candidate's actual fetched text against the unmodified EXTRACTION_SYSTEM_PROMPT / schema in
// lib/consensus/extractionContract.ts (see chat for the per-item reasoning) — never invented, and
// conservative: an item is only CLASSIFIED when the tracked person is genuinely the one quoted and
// the statement is market-relevant; otherwise NEEDS_REVIEW, exactly the real pipeline's own designed
// fallback for uncertain cases (no stance forced, no stock links, event still kept as evidence).
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { persistConsensusEvent, type QueryFn } from '../lib/consensus/persistEvent';
import type { ClassifyOutcome } from '../lib/consensus/extractionContract';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const query: QueryFn = (sql, params) => q(sql, params as unknown[]) as Promise<never[]>;

const items = JSON.parse(readFileSync('scratch/attributed-items.json', 'utf8')) as Array<{
  idx: number; personSlug: string; person: string; personCountry: string | null; source: string; sourceGrade: 'A' | 'B' | 'C'; sourceName: string; title: string | null; url: string; publishedAt: string | null; text: string;
}>;

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

// Manual classification, one entry per idx in attributed-items.json — see file header for method.
const classifications: Record<number, ClassifyOutcome> = {
  0: { status: 'NEEDS_REVIEW', reason: 'quoted speaker is a Palantir executive ("said Alex Kar…"), not Jensen Huang himself — official-source attribution matched the NVIDIA newsroom byline, not the actual speaker', model: 'claude-manual-v1', version: 'v1-manual', contentHash: hash(items[0].text) },
  1: { status: 'NEEDS_REVIEW', reason: 'the only direct quotation in the release is Ambassador Greer’s ("said Ambassador Greer"); Trump is discussed in third person only, not quoted', model: 'claude-manual-v1', version: 'v1-manual', contentHash: hash(items[1].text) },
  2: {
    status: 'CLASSIFIED', model: 'claude-manual-v1', version: 'v1-manual', contentHash: hash(items[2].text),
    result: {
      person: 'Donald Trump', event_at: '2026-09-10T17:56:28.000Z',
      summary_zh: '川普宣布若共和黨贏得國會多數，將發放每位成年公民5000美元「紅利」。',
      stance: 'BULLISH', confidence: 0.85, statement_strength: 1.0,
      sector: null, theme: 'fiscal stimulus / US economy',
      direct_mentions: [], inferred_relations: [],
    },
  },
  3: { status: 'NEEDS_REVIEW', reason: 'third-person achievements roundup (immigration/crime/economy) with no direct Trump quotation in the fetched text; title-only "official transcript" match is a weak signal here since the content is not a speech', model: 'claude-manual-v1', version: 'v1-manual', contentHash: hash(items[3].text) },
  4: { status: 'NEEDS_REVIEW', reason: 'commemorative 9/11 tribute speech — no market-relevant content (UNCLEAR per the extraction prompt: no market-relevant view expressed)', model: 'claude-manual-v1', version: 'v1-manual', contentHash: hash(items[4].text) },
};

const personRows = await q(`select id, slug, country from consensus_people where slug = any($1::text[])`, [[...new Set(items.map((i) => i.personSlug))]]);
const personBySlug = new Map(personRows.map((p) => [p.slug, p]));
const sourceRows = await q(`select id, slug, source_grade from consensus_sources where slug = any($1::text[])`, [[...new Set(items.map((i) => i.source))]]);
const sourceBySlug = new Map(sourceRows.map((s) => [s.slug, s]));

const results = [];
for (const item of items) {
  const person = personBySlug.get(item.personSlug);
  const source = sourceBySlug.get(item.source);
  const res = await persistConsensusEvent(query, {
    personId: person.id, personSlug: item.personSlug, personCountry: item.personCountry,
    sourceId: source.id, sourceGrade: source.source_grade,
    eventAt: item.publishedAt ?? new Date().toISOString(), publishedAt: item.publishedAt, eventType: null,
    sourceUrl: item.url, sourceTitle: item.title, rawText: item.text,
    classification: classifications[item.idx],
  });
  results.push({ idx: item.idx, person: item.person, source: item.source, ...res });
}

console.log(JSON.stringify(results, null, 2));
await client.end();
