// P0-1 — bounded REAL ingest. Reuses the exact production pipeline modules:
//   fetchSourceCandidates + hydrateBody   (lib/consensus/sourceFetch)
//   attributePerson                       (lib/consensus/attribution)   — unmodified, strict rules
//   persistConsensusEvent + resolveSymbol (lib/consensus/persistEvent, stockMapping) — unmodified,
//     canonical-key dedup + consensus_event_sources fan-out, exactly as production writes it.
// The ONLY substitution: the AI-classification step normally calls Vercel's AI Gateway via an
// OIDC token that only exists inside a live Vercel request (not obtainable locally, and rotating
// CRON_SECRET to call the deployed cron directly would require a redeploy — out of scope this
// round). Per explicit user decision, this step is done by Claude reading each attributed
// candidate's real text and classifying it against the EXACT schema/rules in
// lib/consensus/extractionContract.ts (EXTRACTION_SYSTEM_PROMPT below, unmodified). Written with
// extraction_model='claude-manual-v1' / extraction_version='v1-manual' so this is never confused
// with a real gpt-4o-mini AI Gateway classification in the data.
import 'dotenv/config';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { fetchSourceCandidates, hydrateBody } from '../lib/consensus/sourceFetch';
import { attributePerson, type PersonRef } from '../lib/consensus/attribution';
import { persistConsensusEvent, type QueryFn } from '../lib/consensus/persistEvent';
import type { ClassifyOutcome } from '../lib/consensus/extractionContract';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const query: QueryFn = (sql, params) => q(sql, params as unknown[]) as Promise<never[]>;

const MAX_CANDIDATES = 100;
const LOOKBACK_DAYS = 7;

const people = (await q(
  `select id, slug, display_name as "displayName", country, aliases from consensus_people where is_active order by priority limit 20`
)).map((p) => ({ ...p, aliases: Array.isArray(p.aliases) ? p.aliases : [] })) as PersonRef[];

const sources = await q(
  `select id, slug, source_type, source_name, source_grade, canonical_url, person_id, is_official, fetch_method
   from consensus_sources
   where is_active and status <> 'DISABLED'
     and (slug in ('cnbc','economic-daily-news','wallstreetcn')
          or source_type in ('COMPANY_IR','EARNINGS_CALL','SEC_FILING','GOV_TRANSCRIPT'))
   order by case source_grade when 'A' then 1 when 'B' then 2 else 3 end, slug`
);

const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600_000).toISOString();
let candidatesSeen = 0, attributedCount = 0, notAttributed = 0, eventsCreated = 0, eventsDeduped = 0;
let directCount = 0, inferredCount = 0;
const peopleCovered = new Set<string>();
const stocksCovered = new Set<string>();
const auditLog: Record<string, unknown>[] = [];
const attributedItems: Array<{ person: PersonRef; src: (typeof sources)[number]; title: string | null; text: string; url: string; publishedAt: string | null }> = [];

for (const src of sources) {
  if (candidatesSeen >= MAX_CANDIDATES) break;
  const outcome = await fetchSourceCandidates(src as never, sinceIso);
  if (!outcome.ok) continue;
  const ownerPersonId = src.person_id;
  for (const cand of outcome.candidates) {
    if (candidatesSeen >= MAX_CANDIDATES) break;
    candidatesSeen++;
    let text = cand.text;
    if (text.length < 400) {
      const body = await hydrateBody(cand.url);
      if (body && body.length > text.length) text = body;
    }
    const attr = attributePerson({ title: cand.title, text, people, ownerPersonId, sourceIsOfficial: Boolean(src.is_official), sourceType: src.source_type });
    if (!attr.attributed || !attr.person) { notAttributed++; continue; }
    attributedCount++;
    attributedItems.push({ person: attr.person, src, title: cand.title, text, url: cand.url, publishedAt: cand.publishedAt });
  }
}

console.log(`Fetched ${candidatesSeen} candidates, ${attributedCount} attributed.`);
const { writeFileSync } = await import('node:fs');
writeFileSync('scratch/attributed-items.json', JSON.stringify(attributedItems.map((i, idx) => ({ idx, personSlug: i.person.slug, person: i.person.displayName, personCountry: i.person.country, source: i.src.slug, sourceGrade: i.src.source_grade, sourceName: i.src.source_name, title: i.title, url: i.url, publishedAt: i.publishedAt, text: i.text.slice(0, 4000) })), null, 2));
console.log('wrote scratch/attributed-items.json');

await client.end();
