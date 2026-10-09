// Seed / refresh the consensus-radar person + source whitelist from config JSON.
// Idempotent upsert by slug. CLOUD-agnostic maintenance script (run locally or in CI).
//
//   node --env-file=.env scripts/data/consensus/seed-consensus-registry.mjs
//
// Requires a `pg` Client and DIRECT_URL / DATABASE_URL in env. No AI, no external fetch.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const cfgDir = resolve(here, "../../../config/consensus");
const people = JSON.parse(readFileSync(resolve(cfgDir, "people.json"), "utf8")).people;
const sources = JSON.parse(readFileSync(resolve(cfgDir, "sources.json"), "utf8")).sources;
// SEC EDGAR: one structured source per corporate principal (Phase 3 coverage expansion).
const secCompanies = JSON.parse(readFileSync(resolve(cfgDir, "sec-ciks.json"), "utf8")).companies;
for (const co of secCompanies) {
  sources.push({
    slug: co.slug,
    source_type: "SEC_FILING",
    source_name: `SEC EDGAR — ${co.name} (${co.ticker}) 8-K / 6-K / DEF 14A`,
    source_grade: "A",
    canonical_url: `sec:${co.cik}`,
    person_slug: co.ceo_slug,
    is_official: true,
    fetch_method: "SEC_EDGAR",
    refresh_interval_minutes: 720,
  });
}

const conn = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!conn) throw new Error("DIRECT_URL / DATABASE_URL missing");

const client = new pg.Client({ connectionString: conn });
await client.connect();

let pUp = 0;
for (const p of people) {
  await client.query(
    `insert into consensus_people (slug, display_name, name_en, category, organization, role, country, aliases, source_priorities, priority, is_active, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,true, now())
     on conflict (slug) do update set
       display_name=excluded.display_name, name_en=excluded.name_en, category=excluded.category,
       organization=excluded.organization, role=excluded.role, country=excluded.country,
       aliases=excluded.aliases, source_priorities=excluded.source_priorities, priority=excluded.priority,
       is_active=true, updated_at=now()`,
    [p.slug, p.display_name, p.name_en ?? null, p.category, p.organization ?? null, p.role ?? null, p.country ?? null,
     JSON.stringify(p.aliases ?? []), JSON.stringify(p.source_priorities ?? []), p.priority ?? 100],
  );
  pUp++;
}

const idBySlug = new Map(
  (await client.query(`select id, slug from consensus_people`)).rows.map((r) => [r.slug, r.id]),
);

let sUp = 0;
for (const s of sources) {
  const personId = s.person_slug ? idBySlug.get(s.person_slug) ?? null : null;
  await client.query(
    `insert into consensus_sources (slug, source_type, source_name, source_grade, canonical_url, person_id, is_official, fetch_method, refresh_interval_minutes, is_active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
     on conflict (slug) do update set
       source_type=excluded.source_type, source_name=excluded.source_name, source_grade=excluded.source_grade,
       canonical_url=excluded.canonical_url, person_id=excluded.person_id, is_official=excluded.is_official,
       fetch_method=excluded.fetch_method, refresh_interval_minutes=excluded.refresh_interval_minutes, is_active=true`,
    [s.slug, s.source_type, s.source_name, s.source_grade, s.canonical_url ?? null, personId,
     s.is_official ?? false, s.fetch_method ?? "MANUAL", s.refresh_interval_minutes ?? 180],
  );
  sUp++;
}

const byCat = (await client.query(
  `select category, count(*)::int c from consensus_people where is_active group by category order by category`,
)).rows;
const byGrade = (await client.query(
  `select source_grade, count(*)::int c from consensus_sources where is_active group by source_grade order by source_grade`,
)).rows;

console.log(JSON.stringify({ people_upserted: pUp, sources_upserted: sUp, people_by_category: byCat, sources_by_grade: byGrade }, null, 2));
await client.end();
