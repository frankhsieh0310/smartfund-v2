import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { productionProviderRegistry } from "../../../lib/data-platform/providers/ProviderRegistry.ts";

const MAX_DB_CONCURRENCY = 1;
const COUNTRY = "BRA";
const CURRENCY = "BRL";
const INDICATOR = "DT.DOD.DECT.CD";
const SYMBOL = `${INDICATOR}:${COUNTRY}`;
const SOURCE_URL = `https://api.worldbank.org/v2/country/${COUNTRY}/indicator/${INDICATOR}?format=json&per_page=100`;
const runtime = resolve("runtime", "fx-external-debt");
const checkpointFile = resolve(runtime, "checkpoint.json");

function pooledUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL_REQUIRED");
  const url = new URL(raw);
  url.searchParams.set("pgbouncer", "true");
  url.searchParams.set("connection_limit", String(MAX_DB_CONCURRENCY));
  url.searchParams.set("pool_timeout", "20");
  return url.toString();
}

async function atomicJson(value: unknown): Promise<void> {
  await mkdir(runtime, { recursive: true });
  const temporary = `${checkpointFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, checkpointFile);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url: pooledUrl() } } });
  try {
    const adapter = productionProviderRegistry.get("World Bank");
    const points = (await adapter.fetchHistorical({ assetClass: "MACRO", instrument: { id: "FX_EXTERNAL_DEBT_BRA", symbol: SYMBOL, latestDate: null } })).slice(-3);
    if (!points.length || points.some((point) => point.value === null || !Number.isFinite(Number(point.value)))) throw new Error("WORLD_BANK_EXTERNAL_DEBT_CANARY_INVALID");
    const trust = { source: "World Bank International Debt Statistics", officialStatus: "OFFICIAL_PUBLIC", country: "Brazil", currency: CURRENCY, unit: "current USD", frequency: "ANNUAL", revision: "SOURCE_REVISION_SUPPORTED", pit: "NOT_PROVIDED_BY_SOURCE" };
    const series = await prisma.economicSeries.upsert({
      where: { provider_seriesId: { provider: "World Bank", seriesId: SYMBOL } },
      create: { provider: "World Bank", seriesId: SYMBOL, code: "WB_EXTERNAL_DEBT_BRA_USD", name: "Brazil total external debt stocks", description: JSON.stringify(trust), country: "Brazil", category: "EXTERNAL_DEBT", frequency: "ANNUAL", importance: "HIGH", unit: "current USD", source: "World Bank", apiUrl: SOURCE_URL, lastUpdate: points.at(-1)!.date },
      update: { code: "WB_EXTERNAL_DEBT_BRA_USD", name: "Brazil total external debt stocks", description: JSON.stringify(trust), category: "EXTERNAL_DEBT", frequency: "ANNUAL", unit: "current USD", source: "World Bank", apiUrl: SOURCE_URL, lastUpdate: points.at(-1)!.date, enabled: true },
    });
    for (const point of points) {
      const retrievedAt = new Date();
      const checksum = createHash("sha256").update(`${SYMBOL}|${point.date.toISOString()}|${point.value}|${SOURCE_URL}`).digest("hex");
      await prisma.economicValue.upsert({ where: { seriesId_date: { seriesId: series.id, date: point.date } }, create: { seriesId: series.id, date: point.date, value: point.value!, sourceUrl: SOURCE_URL, sourceVersion: "WORLD_BANK_INDICATORS_V2:IDS:DT.DOD.DECT.CD", rawChecksum: checksum, importedAt: retrievedAt }, update: { value: point.value!, sourceUrl: SOURCE_URL, sourceVersion: "WORLD_BANK_INDICATORS_V2:IDS:DT.DOD.DECT.CD", rawChecksum: checksum, importedAt: retrievedAt } });
    }
    const readback = await prisma.economicValue.findMany({ where: { seriesId: series.id, date: { in: points.map((point) => point.date) } }, orderBy: { date: "asc" } });
    if (readback.length !== points.length || readback.some((row) => !row.rawChecksum || row.sourceUrl !== SOURCE_URL)) throw new Error(`WORLD_BANK_EXTERNAL_DEBT_READBACK_FAILED:${readback.length}/${points.length}`);
    const checkpoint = { asset: "FX", domain: "EXTERNAL_DEBT", source: "World Bank International Debt Statistics", indicator: INDICATOR, country: "Brazil", currency: CURRENCY, state: "AUTO_CONTINUING", observationsPersisted: readback.length, readback: "PASS", checkpoint: `${SYMBOL}:${readback.at(-1)!.date.getUTCFullYear()}`, asOf: readback.at(-1)!.date.toISOString(), retrievedAt: readback.at(-1)!.importedAt.toISOString(), ordinaryWorkerHook: "macro-production-daily", fullBackfillOwner: "ORDINARY_MACRO_NODE_WORKER", maxDbConcurrency: MAX_DB_CONCURRENCY, updatedAt: new Date().toISOString() };
    await atomicJson(checkpoint);
    console.log(JSON.stringify(checkpoint));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
