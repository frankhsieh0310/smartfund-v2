import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { productionProviderRegistry } from "../../../lib/data-platform/providers/ProviderRegistry.ts";

const MAX_DB_CONCURRENCY = 1;
const COUNTRY = "DEU";
const CURRENCY = "EUR";
const SYMBOL = `PPP:${COUNTRY}`;
const SOURCE_URL = `https://sdmx.oecd.org/public/rest/data/OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4,2.0/A.${COUNTRY}...PPP_B1GQ.......?startPeriod=2022&dimensionAtObservation=AllDimensions`;
const runtime = resolve("runtime", "fx-ppp");
const checkpointFile = resolve(runtime, "checkpoint.json");

function pooledUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL_REQUIRED");
  const url = new URL(raw);
  if (url.protocol.startsWith("postgres")) {
    url.searchParams.set("pgbouncer", "true");
    url.searchParams.set("connection_limit", String(MAX_DB_CONCURRENCY));
    url.searchParams.set("pool_timeout", "20");
  }
  return url.toString();
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(runtime, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url: pooledUrl() } } });
  try {
    const adapter = productionProviderRegistry.get("OECD");
    const points = (await adapter.fetchHistorical({ assetClass: "MACRO", instrument: { id: "FX_PPP_DEU", symbol: SYMBOL, latestDate: null }, startDate: new Date("2022-01-01T00:00:00.000Z") })).slice(-3);
    if (!points.length || points.some((point) => point.value === null || !Number.isFinite(Number(point.value)))) throw new Error("OECD_PPP_CANARY_EMPTY_OR_INVALID");
    const series = await prisma.economicSeries.upsert({
      where: { provider_seriesId: { provider: "OECD", seriesId: SYMBOL } },
      create: { provider: "OECD", seriesId: SYMBOL, code: "OECD_PPP_DEU_USD", name: "Germany GDP purchasing power parity", description: JSON.stringify({ official: true, derived: false, dataset: "DSD_NAMAIN10@DF_TABLE4", measure: "PPP_B1GQ", quote: "EUR per USD", country: COUNTRY, currency: CURRENCY }), country: "Germany", category: "PPP", frequency: "ANNUAL", importance: "HIGH", unit: "EUR per USD", source: "OECD", apiUrl: SOURCE_URL, lastUpdate: points.at(-1)!.date },
      update: { code: "OECD_PPP_DEU_USD", name: "Germany GDP purchasing power parity", description: JSON.stringify({ official: true, derived: false, dataset: "DSD_NAMAIN10@DF_TABLE4", measure: "PPP_B1GQ", quote: "EUR per USD", country: COUNTRY, currency: CURRENCY }), category: "PPP", frequency: "ANNUAL", unit: "EUR per USD", source: "OECD", apiUrl: SOURCE_URL, lastUpdate: points.at(-1)!.date, enabled: true },
    });
    for (const point of points) {
      const checksum = createHash("sha256").update(`${SYMBOL}|${point.date.toISOString()}|${point.value}|${SOURCE_URL}`).digest("hex");
      await prisma.economicValue.upsert({ where: { seriesId_date: { seriesId: series.id, date: point.date } }, create: { seriesId: series.id, date: point.date, value: point.value!, sourceUrl: SOURCE_URL, sourceVersion: "OECD_SDMX_JSON:DSD_NAMAIN10@DF_TABLE4:PPP_B1GQ", rawChecksum: checksum, importedAt: new Date() }, update: { value: point.value!, sourceUrl: SOURCE_URL, sourceVersion: "OECD_SDMX_JSON:DSD_NAMAIN10@DF_TABLE4:PPP_B1GQ", rawChecksum: checksum, importedAt: new Date() } });
    }
    const readback = await prisma.economicValue.findMany({ where: { seriesId: series.id, date: { in: points.map((point) => point.date) } }, orderBy: { date: "asc" } });
    if (readback.length !== points.length || readback.some((row) => !row.rawChecksum || row.sourceUrl !== SOURCE_URL)) throw new Error(`OECD_PPP_READBACK_FAILED:${readback.length}/${points.length}`);
    const checkpoint = { asset: "FX", domain: "PPP", source: "OECD", dataset: "DSD_NAMAIN10@DF_TABLE4", measure: "PPP_B1GQ", country: "Germany", currency: CURRENCY, seriesId: SYMBOL, state: "AUTO_CONTINUING", observationsPersisted: readback.length, readback: "PASS", checkpoint: `${SYMBOL}:${readback.at(-1)!.date.getUTCFullYear()}`, lastObservationDate: readback.at(-1)!.date.toISOString(), processId: process.pid, ordinaryWorkerHook: "macro-production-daily", fullBackfillOwner: "ORDINARY_MACRO_NODE_WORKER", maxDbConcurrency: MAX_DB_CONCURRENCY, inputConstrainedFallback: "WORLD_BANK_ICP_FOR_NON_OECD_COUNTRIES", updatedAt: new Date().toISOString() };
    await atomicJson(checkpointFile, checkpoint);
    console.log(JSON.stringify(checkpoint));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
