import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const root = resolve(import.meta.dirname, "../../..");
const fixtureNames = ["index-constituents-hsi-review-20260213.json", "index-constituents-hsi-review-20260522.json"];
const normalize = (value: string) => value.toUpperCase().replace(/\s+\(H\)$/u, "").replace(/[^A-Z0-9]/gu, "");
const tickerKey = (value: string) => value.replace(/^0+/u, "") || "0";

async function insertSnapshot(prisma: PrismaClient, fixture: any, spec: any, retrievedAt: Date) {
  if (spec.rows.length !== spec.expectedCount) throw new Error(`${spec.indexId} ${fixture.effectiveDate}: parsed ${spec.rows.length}, expected ${spec.expectedCount}`);
  const duplicateKeys = new Set<string>();
  for (const row of spec.rows) {
    const key = tickerKey(String(row[0]));
    if (duplicateKeys.has(key)) throw new Error(`${spec.indexId} duplicate ticker ${row[0]}`);
    duplicateKeys.add(key);
    if (!Number.isFinite(Number(row[4])) || Number(row[4]) < 0) throw new Error(`${spec.indexId} invalid weight ${row[4]}`);
  }
  const weightSum = spec.rows.reduce((sum: number, row: unknown[]) => sum + Number(row[4]), 0);
  if (weightSum < 99.5 || weightSum > 100.5) throw new Error(`${spec.indexId} full snapshot weight sum ${weightSum} outside rounding gate`);
  const existing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM index_constituent_snapshots WHERE index_id=$1 AND effective_date=$2::date AND source=$3 AND checksum=$4 LIMIT 1`,
    spec.indexId, fixture.effectiveDate, fixture.source, fixture.checksum,
  );
  if (existing.length) return { snapshotId: existing[0].id, result: "NO_OP_CURRENT", rows: spec.rows.length };

  const tickerValues = spec.rows.map((row: unknown[]) => tickerKey(String(row[0])));
  const candidates = await prisma.$queryRawUnsafe<Array<{ id: string; ticker: string; name: string; name_en: string | null; country: string | null; currency: string | null }>>(
    `SELECT id,ticker,name,name_en,country,currency FROM securities
     WHERE exchange IN ('HKEX','XHKG','SEHK') AND regexp_replace(split_part(ticker,'.',1),'^0+','','g') = ANY($1::text[])`,
    tickerValues,
  );
  const byTicker = new Map<string, typeof candidates>();
  for (const candidate of candidates) byTicker.set(tickerKey(candidate.ticker.split(".")[0]), [...(byTicker.get(tickerKey(candidate.ticker.split(".")[0])) ?? []), candidate]);

  const snapshotId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO index_constituent_snapshots
       (id,index_id,effective_date,as_of_date,publication_date,provider_id,source,source_type,source_url,source_record_id,retrieved_at,checksum,source_row_count,parsed_row_count,canonical_row_count,constituent_count,known_weight_count,known_weight_sum,unknown_weight_count,completeness_status,verification_status,license_status,quality_status,created_at,updated_at)
       VALUES ($1,$2,$3::date,$3::date,$4::date,'hkex',$5,$6,$7,$8,$9,$10,$11,$11,$11,$11,$11,$12,0,'FULL_SOURCE_SNAPSHOT','VERIFIED_OFFICIAL','PUBLIC_REFERENCE_ONLY','PASS_FULL_WEIGHT_ROUNDING',now(),now())`,
      snapshotId, spec.indexId, fixture.effectiveDate, fixture.publicationDate, fixture.source, fixture.sourceType,
      fixture.sourceUrl, fixture.sourceRecordId, retrievedAt, fixture.checksum, spec.expectedCount, weightSum,
    );
    for (let position = 0; position < spec.rows.length; position++) {
      const [ticker, rawName, freeFloatFactor, _beforeWeight, sourceWeight] = spec.rows[position];
      const possible = byTicker.get(tickerKey(String(ticker))) ?? [];
      const exact = possible.filter((item) => normalize(item.nameEn ?? item.name) === normalize(String(rawName)));
      const security = exact.length === 1 ? exact[0] : null;
      const constituentId = randomUUID();
      const status = exact.length === 1 ? "VERIFIED" : exact.length > 1 ? "AMBIGUOUS" : "CANONICAL_SECURITY_MISSING";
      await tx.$executeRawUnsafe(
        `INSERT INTO index_constituents
         (id,snapshot_id,index_id,security_id,identity_key,constituent_name,ticker,exchange,country,currency,source_weight,normalized_weight,weight_unit,free_float_factor,source_row_id,verification_status,quality_status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'HKEX',$8,$9,$10,$11,'PERCENT',$12,$13,'VERIFIED_OFFICIAL_ROW','PASS',now(),now())`,
        constituentId, snapshotId, spec.indexId, security?.id ?? null, `HKEX:${String(ticker).padStart(4, "0")}`,
        rawName, String(ticker).padStart(4, "0"), security?.country ?? null, security?.currency ?? null,
        sourceWeight, Number(sourceWeight) / 100, freeFloatFactor, String(position + 1),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO index_constituent_mapping_queue
         (id,snapshot_id,constituent_id,status,match_method,source_identifier,canonical_identifier,verification_source,verified_at,mapping_version,candidate_security_ids,reason,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'2.0.0',$10::jsonb,$11,now(),now())`,
        randomUUID(), snapshotId, constituentId, status, security ? "EXACT_MIC_PLUS_TICKER_NAME" : null,
        `HKEX:${String(ticker).padStart(4, "0")}`, security ? `${security.id}:${security.ticker}` : null,
        security ? "CANONICAL_SECURITIES" : null, security ? new Date() : null, JSON.stringify(exact.map((item) => item.id)),
        status === "CANONICAL_SECURITY_MISSING" ? "No exact HKEX ticker plus official-name canonical security" : null,
      );
    }
  }, { timeout: 90_000 });
  return { snapshotId, result: "INSERTED", rows: spec.rows.length, weightSum, mapped: spec.rows.filter((row: unknown[]) => {
    const possible = byTicker.get(tickerKey(String(row[0]))) ?? [];
    return possible.filter((item) => normalize(item.nameEn ?? item.name) === normalize(String(row[1]))).length === 1;
  }).length };
}

async function deriveEvents(prisma: PrismaClient, indexId: string) {
  const snapshots = await prisma.$queryRawUnsafe<Array<{ id: string; effective_date: Date }>>(
    `SELECT id,effective_date FROM index_constituent_snapshots
     WHERE index_id=$1 AND verification_status='VERIFIED_OFFICIAL' AND completeness_status='FULL_SOURCE_SNAPSHOT'
     ORDER BY effective_date`, indexId,
  );
  if (snapshots.length < 2) return { result: "WAITING_FOR_SECOND_VERIFIED_FULL_SNAPSHOT" };
  const previous = snapshots.at(-2)!;
  const current = snapshots.at(-1)!;
  const inserted = await prisma.$executeRawUnsafe(
    `WITH prior AS (SELECT * FROM index_constituents WHERE snapshot_id=$1),
     current_rows AS (SELECT * FROM index_constituents WHERE snapshot_id=$2),
     changes AS (
       SELECT coalesce(c.identity_key,p.identity_key) identity_key,coalesce(c.security_id,p.security_id) security_id,
         p.source_weight previous_weight,c.source_weight current_weight,
         CASE WHEN p.id IS NULL THEN 'ENTRY' WHEN c.id IS NULL THEN 'REMOVAL'
              WHEN c.source_weight>p.source_weight THEN 'WEIGHT_INCREASE'
              WHEN c.source_weight<p.source_weight THEN 'WEIGHT_DECREASE' END event_type
       FROM prior p FULL OUTER JOIN current_rows c USING(identity_key)
     )
     INSERT INTO index_constituent_events
       (id,index_id,security_id,constituent_identity_fallback,event_type,effective_date,previous_snapshot_id,current_snapshot_id,previous_weight,current_weight,weight_change,weight_change_pct,source_type,created_at)
     SELECT gen_random_uuid()::text,$3,security_id,identity_key,event_type,$4,$1,$2,previous_weight,current_weight,
       CASE WHEN previous_weight IS NULL OR current_weight IS NULL THEN NULL ELSE current_weight-previous_weight END,
       CASE WHEN previous_weight IS NULL OR previous_weight=0 OR current_weight IS NULL THEN NULL ELSE (current_weight-previous_weight)/previous_weight*100 END,
       'DERIVED_FROM_VERIFIED_FULL_SNAPSHOTS',now()
     FROM changes WHERE event_type IS NOT NULL
     ON CONFLICT (current_snapshot_id,constituent_identity_fallback,event_type) DO NOTHING`,
    previous.id, current.id, indexId, current.effective_date,
  );
  return { result: "DERIVED", previousSnapshotId: previous.id, currentSnapshotId: current.id, inserted };
}

export async function ingestHsiReviews(prisma = new PrismaClient()) {
  const ownsClient = arguments.length === 0;
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE index_constituent_snapshots SET verification_status='SUPERSEDED',quality_status='SUPERSEDED_EFFECTIVE_DATE_SEMANTIC_CORRECTION',updated_at=now()
       WHERE index_id='HANG_SENG' AND effective_date='2026-06-30'::date AND source='Hang Seng Indexes' AND verification_status='VERIFIED_OFFICIAL'`,
    );
    const results = [];
    for (const fixtureName of fixtureNames) {
      const fixture = JSON.parse(await readFile(join(root, "config", fixtureName), "utf8"));
      const response = await fetch(fixture.sourceUrl, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "SmartFund-Index-Constituents/2.0" } });
      if (!response.ok) throw new Error(`${fixture.sourceRecordId} HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const checksum = createHash("sha256").update(bytes).digest("hex");
      if (checksum !== fixture.checksum) throw new Error(`${fixture.sourceRecordId} checksum changed; fail closed`);
      const archivePath = join(root, "runtime", "index-constituents", "archive", "official", "HANG_SENG_INDEXES", `${fixture.publicationDate}-${checksum}.pdf`);
      await mkdir(dirname(archivePath), { recursive: true });
      await writeFile(archivePath, bytes);
      for (const snapshot of fixture.snapshots) results.push({ fixture: fixture.sourceRecordId, indexId: snapshot.indexId, ...(await insertSnapshot(prisma, fixture, snapshot, new Date())) });
    }
    const events = [await deriveEvents(prisma, "HANG_SENG"), await deriveEvents(prisma, "HSCEI")];
    return { results, events };
  } finally {
    if (ownsClient) await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith("ingest-hsi-reviews.ts")) {
  ingestHsiReviews().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error); process.exitCode = 1; });
}
