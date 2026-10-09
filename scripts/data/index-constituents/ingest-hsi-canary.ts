import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const root = resolve(import.meta.dirname, "../../..");
const sourcePath = join(root, "config", "index-constituents-hsi-canary.json");

export async function ingestHsiCanary(prisma = new PrismaClient()) {
  const ownsClient = arguments.length === 0;
  try {
    const spec = JSON.parse(await readFile(sourcePath, "utf8"));
    const response = await fetch(spec.sourceUrl, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "SmartFund-Index-Constituents/1.0" } });
    if (!response.ok) throw new Error(`HSI official factsheet HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const checksum = createHash("sha256").update(bytes).digest("hex");
    if (checksum !== spec.expectedChecksum) throw new Error(`HSI factsheet changed: expected ${spec.expectedChecksum}, received ${checksum}; parser review required`);

    const archivePath = join(root, "runtime", "index-constituents", "archive", "official", "HANG_SENG", `${spec.effectiveDate}-${checksum}.pdf`);
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archivePath, bytes);

    const existing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM index_constituent_snapshots WHERE index_id=$1 AND effective_date=$2::date AND source=$3 AND checksum=$4 LIMIT 1`,
      spec.indexId, spec.effectiveDate, spec.source, checksum,
    );
    if (existing.length) return { result: "NO_OP_CURRENT", snapshotId: existing[0].id, rows: spec.rows.length, checksum, archivePath };

    const isins = spec.rows.map((row: unknown[]) => row[1]);
    const securityRows = await prisma.$queryRawUnsafe<Array<{ id: string; isin: string; country: string | null; currency: string | null }>>(
      `SELECT id, isin, country, currency FROM securities WHERE isin = ANY($1::text[])`, isins,
    );
    const byIsin = new Map<string, typeof securityRows>();
    for (const security of securityRows) byIsin.set(security.isin, [...(byIsin.get(security.isin) ?? []), security]);

    const snapshotId = randomUUID();
    const knownWeightSum = spec.rows.reduce((sum: number, row: unknown[]) => sum + Number(row[5]), 0);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO index_constituent_snapshots
         (id,index_id,effective_date,as_of_date,publication_date,provider_id,source,source_type,source_url,source_record_id,retrieved_at,checksum,source_row_count,parsed_row_count,canonical_row_count,constituent_count,known_weight_count,known_weight_sum,unknown_weight_count,completeness_status,verification_status,license_status,quality_status,created_at,updated_at)
         VALUES ($1,$2,$3::date,$4::date,$5::date,$6,$7,$8,$9,$10,now(),$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,now(),now())`,
        snapshotId, spec.indexId, spec.effectiveDate, spec.asOfDate, spec.publicationDate, "hkex", spec.source,
        spec.sourceType, spec.sourceUrl, spec.sourceRecordId, checksum, spec.sourceConstituentCount, spec.rows.length,
        spec.rows.length, spec.sourceConstituentCount, spec.rows.length, knownWeightSum, 0,
        spec.completenessStatus, "VERIFIED_OFFICIAL", spec.licenseStatus, "PASS_EXPLICIT_PARTIAL",
      );
      for (let position = 0; position < spec.rows.length; position++) {
        const [ticker, isin, constituentName, _industry, _shareType, sourceWeight] = spec.rows[position];
        const matches = byIsin.get(isin) ?? [];
        const security = matches.length === 1 ? matches[0] : null;
        const constituentId = randomUUID();
        await tx.$executeRawUnsafe(
          `INSERT INTO index_constituents
           (id,snapshot_id,index_id,security_id,identity_key,constituent_name,ticker,isin,exchange,country,currency,source_weight,normalized_weight,weight_unit,source_row_id,verification_status,quality_status,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),now())`,
          constituentId, snapshotId, spec.indexId, security?.id ?? null, `ISIN:${isin}`, constituentName, ticker, isin,
          "HKEX", security?.country ?? null, security?.currency ?? null, sourceWeight, Number(sourceWeight) / 100,
          "PERCENT", String(position + 1), "VERIFIED_OFFICIAL_ROW", "PASS",
        );
        const status = matches.length === 1 ? "VERIFIED" : matches.length > 1 ? "MULTIPLE_MATCH" : "NO_SECURITY_RECORD";
        await tx.$executeRawUnsafe(
          `INSERT INTO index_constituent_mapping_queue
           (id,snapshot_id,constituent_id,status,match_method,candidate_security_ids,reason,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,now(),now())`,
          randomUUID(), snapshotId, constituentId, status, matches.length ? "EXACT_ISIN" : null,
          JSON.stringify(matches.map((item) => item.id)), status === "NO_SECURITY_RECORD" ? "No exact ISIN match in canonical securities" : null,
        );
      }
    }, { timeout: 60_000 });
    return { result: "INSERTED", snapshotId, rows: spec.rows.length, checksum, archivePath, mapped: spec.rows.filter((row: unknown[]) => (byIsin.get(String(row[1])) ?? []).length === 1).length };
  } finally {
    if (ownsClient) await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith("ingest-hsi-canary.ts")) {
  ingestHsiCanary().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error); process.exitCode = 1; });
}
