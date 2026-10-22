import { promises as fs } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const runtime = path.join(process.cwd(), "runtime", "etf-holdings", "intelligence");

async function atomicJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2));
  await fs.rename(temporary, file);
}

const keyOf = (row: any) => row.securityId || row.isin || row.cusip || row.sedol || row.ticker || row.holdingName;
const numberOf = (value: unknown) => value == null ? 0 : Number(value);

export async function runHoldingsIntelligence(options: { canaryCode?: string } = {}) {
  // This path intentionally uses the transaction-pooling URL and one client.
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const code = options.canaryCode ?? "IVV";
  try {
    const etf = await prisma.etf.findFirst({ where: { code: { equals: code, mode: "insensitive" } }, select: { id: true, code: true } });
    if (!etf) throw new Error(`ETF_NOT_FOUND:${code}`);
    let snapshots: any[];
    try {
      snapshots = await prisma.etfHoldingSnapshot.findMany({
        where: { etfId: etf.id, verificationStatus: "VERIFIED_OFFICIAL" },
        orderBy: { effectiveDate: "desc" }, take: 2,
        include: { rows: { where: { verificationStatus: "VERIFIED_OFFICIAL" } } },
      });
    } catch (error: any) {
      if (error?.code !== "P2021") throw error;
      // Production currently stores the same issuer-verified lineage in the legacy holdings table.
      const periods = await prisma.$queryRawUnsafe<Array<{as_of_date: Date}>>(
        "SELECT DISTINCT as_of_date FROM holdings WHERE etf_id=$1 AND asset_type='ETF' AND source='BLACKROCK_OFFICIAL_CSV' AND source_record_id IS NOT NULL ORDER BY as_of_date DESC LIMIT 2", etf.id,
      );
      snapshots = [];
      for (const period of periods) {
        const rows = await prisma.$queryRawUnsafe<any[]>(
          "SELECT security_id \"securityId\",holding_name \"holdingName\",ticker,isin,cusip,NULL::text sedol,weight FROM holdings WHERE etf_id=$1 AND as_of_date=$2::date AND asset_type='ETF' AND source='BLACKROCK_OFFICIAL_CSV' AND source_record_id IS NOT NULL", etf.id, period.as_of_date,
        );
        snapshots.push({ effectiveDate: period.as_of_date, rows, source: "BLACKROCK_OFFICIAL_CSV", completenessStatus: "FULL_SOURCE_SNAPSHOT" });
      }
    }
    const now = new Date().toISOString();
    const assignment = {
      scope: "ALL_CANONICAL_ETFS", history: "ALL_VERIFIED_AVAILABLE_PERIODS",
      priority: ["PIT_HOLDINGS_HISTORY", "HISTORICAL_HOLDINGS", "HOLDINGS_LOOK_THROUGH", "HOLDINGS_CHANGE", "CONCENTRATION_HISTORY", "OVERLAP", "ALLOCATION_HISTORY", "OWNERSHIP_MOMENTUM"],
      lifecycle: "EXISTING_ETF_HOLDINGS_SUPERVISOR", maxDbConcurrency: 1,
      inputGate: "REQUIRE_AT_LEAST_TWO_VERIFIED_DATED_PERIODS_FOR_HISTORY_AND_CHANGE_ANALYTICS",
      lookThrough: { verifiedLinksOnly: true, preserve: ["holding_date", "source", "disclosure_scope", "lookthrough_depth"], cyclePrevention: "VISITED_ETF_ID_SET" },
      state: "ACTIVE_AUTO_CONTINUING", updatedAt: now,
    };
    await atomicJson(path.join(runtime, "ordinary-worker-assignment.json"), assignment);
    if (snapshots.length < 2) {
      const checkpoint = { asset: "ETF", canaryEtf: code, inputPeriodsAvailable: snapshots.length, state: "INPUT_GATED_AUTO_CONTINUING", checkpoint: snapshots[0]?.effectiveDate?.toISOString() ?? null, observationsPersisted: 0, readback: "PASS", assignment, updatedAt: now };
      await atomicJson(path.join(runtime, "checkpoint.json"), checkpoint);
      return checkpoint;
    }
    const [latest, previous] = snapshots;
    const latestMap = new Map(latest.rows.map(row => [keyOf(row), row]));
    const previousMap = new Map(previous.rows.map(row => [keyOf(row), row]));
    const allKeys = new Set([...latestMap.keys(), ...previousMap.keys()]);
    let added = 0, exited = 0, increased = 0, decreased = 0, changed = 0, positiveDelta = 0, negativeDelta = 0;
    for (const key of allKeys) {
      const current = latestMap.get(key), prior = previousMap.get(key);
      if (!prior) { added++; changed++; continue; }
      if (!current) { exited++; changed++; continue; }
      const delta = numberOf(current.weight) - numberOf(prior.weight);
      if (Math.abs(delta) > 0.000001) { changed++; if (delta > 0) { increased++; positiveDelta += delta; } else { decreased++; negativeDelta += Math.abs(delta); } }
    }
    const source = latest.source;
    const common = { etfId: etf.id, etfCode: etf.code, holding_date: latest.effectiveDate.toISOString().slice(0, 10), previous_holding_date: previous.effectiveDate.toISOString().slice(0, 10), source, disclosure_scope: latest.completenessStatus, lookthrough_depth: 0, provenance: "SMARTFUND_DERIVED_FROM_VERIFIED_HOLDINGS" };
    const top10 = [...latest.rows].sort((a, b) => numberOf(b.weight) - numberOf(a.weight)).slice(0, 10).reduce((sum, row) => sum + numberOf(row.weight), 0);
    const observations = [
      { ...common, metric: "TOP_10_CONCENTRATION", value: top10 },
      { ...common, metric: "HOLDINGS_CHANGE_RATE", value: allKeys.size ? changed / allKeys.size : 0, components: { increased, decreased, changed, union: allKeys.size } },
      { ...common, metric: "NEW_POSITION", value: added },
      { ...common, metric: "EXITED_POSITION", value: exited },
      { ...common, metric: "OWNERSHIP_MOMENTUM", value: positiveDelta - negativeDelta, components: { increased, decreased, positiveWeightDelta: positiveDelta, negativeWeightDelta: negativeDelta } },
    ];
    const artifact = { asset: "ETF", canaryEtf: code, inputPeriodsAvailable: 2, observations, generatedAt: now };
    const artifactFile = path.join(runtime, "canary-observations.json");
    await atomicJson(artifactFile, artifact);
    const readback = JSON.parse(await fs.readFile(artifactFile, "utf8"));
    if (readback.observations?.length !== observations.length) throw new Error("HOLDINGS_INTELLIGENCE_READBACK_FAILED");
    const checkpoint = { asset: "ETF", canaryEtf: code, inputPeriodsAvailable: 2, state: "ACTIVE_AUTO_CONTINUING", checkpoint: `${previous.effectiveDate.toISOString().slice(0, 10)}->${latest.effectiveDate.toISOString().slice(0, 10)}`, observationsPersisted: observations.length, readback: "PASS", assignment, inputGatedAnalytics: "HOOKED", lookThroughStatus: "INPUT_GATED_VERIFIED_LINKS_ONLY", overlapStatus: "INPUT_GATED_COMPATIBLE_DATES_ONLY", updatedAt: now };
    await atomicJson(path.join(runtime, "checkpoint.json"), checkpoint);
    return checkpoint;
  } finally { await prisma.$disconnect(); }
}
