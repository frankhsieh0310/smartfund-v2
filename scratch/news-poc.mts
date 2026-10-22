// Bounded PoC — reuses the REAL production consensus pipeline modules (fetchSourceCandidates +
// attributePerson from lib/consensus/*), never a second parallel implementation. Read-only: no DB
// writes, no AI Gateway calls (mirrors the deployed cron's own ?dry=1 semantics). Scope: the newly
// registered 經濟日報 / 華爾街見聞 sources plus existing cnbc/reuters/yahoo-finance-news for
// comparison, against the existing 20 highest-priority tracked people, last 7 days.
import 'dotenv/config';
import pg from 'pg';
import { fetchSourceCandidates, hydrateBody } from '../lib/consensus/sourceFetch';
import { attributePerson, type PersonRef } from '../lib/consensus/attribution';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;

const people = (await q(
  `select id, slug, display_name as "displayName", country, aliases from consensus_people where is_active order by priority limit 20`
)).map((p) => ({ ...p, aliases: Array.isArray(p.aliases) ? p.aliases : [] })) as PersonRef[];

const sourceSlugs = ['economic-daily-news', 'wallstreetcn', 'cnbc', 'reuters', 'yahoo-finance-news'];
const sources = await q(
  `select id, slug, source_type, source_name, source_grade, canonical_url, person_id, is_official, fetch_method
   from consensus_sources where slug = any($1::text[])`, [sourceSlugs]
);

const sinceIso = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
let candidateCount = 0, attributedCount = 0, notAttributed = 0;
const personsFound = new Set<string>();
const namedNotAttributed = new Set<string>();
const perSource: Record<string, unknown>[] = [];

for (const src of sources) {
  const outcome = await fetchSourceCandidates(src as never, sinceIso);
  if (!outcome.ok) { perSource.push({ slug: src.slug, ok: false, error: outcome.error, skipped: outcome.skippedReason }); continue; }
  let srcAttributed = 0;
  const srcPersons = new Set<string>();
  for (const cand of outcome.candidates.slice(0, 30)) {
    candidateCount++;
    let text = cand.text;
    if (text.length < 400) {
      const body = await hydrateBody(cand.url);
      if (body && body.length > text.length) text = body;
    }
    const attr = attributePerson({ title: cand.title, text, people, ownerPersonId: src.person_id, sourceIsOfficial: Boolean(src.is_official), sourceType: src.source_type });
    if (attr.attributed && attr.person) { attributedCount++; srcAttributed++; personsFound.add(attr.person.slug); srcPersons.add(attr.person.slug); }
    else { notAttributed++; attr.candidatePeople.forEach((s) => namedNotAttributed.add(s)); }
  }
  perSource.push({ slug: src.slug, grade: src.source_grade, ok: true, candidates: outcome.candidates.length, sampled: Math.min(30, outcome.candidates.length), attributed: srcAttributed, persons: [...srcPersons] });
}

console.log(JSON.stringify({
  scope: { persons_tracked: people.length, sources: sourceSlugs, windowDays: 7 },
  candidate_count: candidateCount,
  attributed_count: attributedCount,
  not_attributed: notAttributed,
  distinct_persons_found: [...personsFound],
  named_but_not_first_person_attributed: [...namedNotAttributed],
  per_source: perSource,
}, null, 2));

await client.end();
