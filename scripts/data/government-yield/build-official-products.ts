import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.env.GOVERNMENT_YIELD_RUNTIME_ROOT ?? path.join("runtime", "government-yield"));
const PRODUCTS = path.join(ROOT, "products");
const REGISTRY = JSON.parse(await readFile(path.resolve("config", "government-yield-registry.json"), "utf8")) as { countries: Array<Record<string, unknown>> };
type Row = { country: string; seriesId: string; tenor: string; observationDate: string; value: number; unit: string; curveType: string; source: string; sourceUrl: string; fetchedAt: string; publicationDate: string | null; revisionStatus: string; parserVersion: string; qualityStatus: string };

async function filesUnder(directory: string, suffix: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? filesUnder(path.join(directory, entry.name), suffix) : Promise.resolve(entry.name.endsWith(suffix) ? [path.join(directory, entry.name)] : [])));
    return nested.flat();
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function main(): Promise<void> {
  await mkdir(PRODUCTS, { recursive: true });
  const normalizedFiles = (await filesUnder(ROOT, ".json")).filter((file) => file.includes(`${path.sep}normalized${path.sep}`));
  const rows: Row[] = [];
  for (const file of normalizedFiles) {
    const document = JSON.parse(await readFile(file, "utf8")) as { rows?: Row[] };
    if (Array.isArray(document.rows)) for (const row of document.rows) rows.push(row);
  }
  const latestBySeries = new Map<string, Row>();
  const duplicateKeys = new Set<string>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.country}|${row.seriesId}|${row.observationDate}`;
    if (seen.has(key)) duplicateKeys.add(key); else seen.add(key);
    const seriesKey = `${row.country}|${row.seriesId}`;
    const prior = latestBySeries.get(seriesKey);
    if (!prior || row.observationDate > prior.observationDate) latestBySeries.set(seriesKey, row);
  }
  const latest = [...latestBySeries.values()].sort((a, b) => a.country.localeCompare(b.country) || a.tenor.localeCompare(b.tenor));
  const now = Date.now();
  const freshness = latest.map((row) => ({ country: row.country, seriesId: row.seriesId, tenor: row.tenor, observationDate: row.observationDate,
    ageDays: Math.floor((now - Date.parse(`${row.observationDate}T00:00:00Z`)) / 86_400_000), status: Math.floor((now - Date.parse(`${row.observationDate}T00:00:00Z`)) / 86_400_000) <= 10 ? "FRESH" : "STALE", source: row.source }));
  const dateNodes = new Map<string, Map<string, Row>>();
  for (const row of rows) {
    if (!/CURVE|PAR_YIELD|SPOT/.test(row.curveType)) continue;
    const key = `${row.country}|${row.observationDate}|${row.curveType}`;
    const nodes = dateNodes.get(key) ?? new Map<string, Row>(); nodes.set(row.tenor, row); dateNodes.set(key, nodes);
  }
  const spreadDefs = [["2Y","10Y","2s10s"],["5Y","30Y","5s30s"],["10Y","30Y","10s30s"]] as const;
  const spreads = [];
  for (const [key, nodes] of dateNodes) for (const [shortTenor, longTenor, spreadId] of spreadDefs) {
    const short = nodes.get(shortTenor), long = nodes.get(longTenor); if (!short || !long) continue;
    spreads.push({ country: short.country, observationDate: short.observationDate, curveType: short.curveType, spreadId, shortTenor, longTenor,
      valueBasisPoints: (long.value - short.value) * 100, slope: long.value > short.value ? "STEEP" : long.value < short.value ? "INVERTED" : "FLAT",
      sourceSeries: [short.seriesId, long.seriesId], qualityStatus: "PASS" });
  }
  const latestSpreads = new Map<string, (typeof spreads)[number]>();
  for (const spread of spreads) { const key = `${spread.country}|${spread.curveType}|${spread.spreadId}`; const prior = latestSpreads.get(key); if (!prior || spread.observationDate > prior.observationDate) latestSpreads.set(key, spread); }
  const archiveFiles = (await filesUnder(ROOT, "")).filter((file) => !file.includes(`${path.sep}products${path.sep}`) && !file.includes(`${path.sep}extracted${path.sep}`));
  const archiveManifest = [];
  for (const file of archiveFiles) { const bytes = await readFile(file); archiveManifest.push({ path: path.relative(ROOT, file).replaceAll("\\", "/"), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }); }
  const registered = REGISTRY.countries.filter((country) => country.status === "REGISTERED").length;
  const captured = new Set(rows.map((row) => row.country));
  const failures = await filesUnder(ROOT, "failures.jsonl");
  let failureCount = 0; for (const file of failures) failureCount += (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).length;
  const layers = [
    ["L1","Country Universe","COMPLETED"],["L2","Series Identity","COMPLETED_WITH_GAPS"],["L3","Tenor Registry","COMPLETED_WITH_GAPS"],
    ["L4","Official Historical",captured.size === registered ? "COMPLETED" : "PARTIAL"],["L5","Latest",latest.length ? "COMPLETED_WITH_GAPS" : "BLOCKED"],
    ["L6","Freshness",freshness.length ? "COMPLETED_WITH_GAPS" : "BLOCKED"],["L7","Yield Curve",dateNodes.size ? "COMPLETED_WITH_GAPS" : "BLOCKED"],
    ["L8","Curve Spreads",spreads.length ? "COMPLETED_WITH_GAPS" : "BLOCKED"],["L9","Real Yield",rows.some((row) => row.curveType.includes("REAL")) ? "COMPLETED_WITH_GAPS" : "SOURCE_NOT_PROVIDED"],
    ["L10","Revision","SOURCE_NOT_PROVIDED"],["L11","Vintage / Point-in-Time","COMPLETED_WITH_GAPS"],["L12","Release Calendar","COMPLETED_WITH_GAPS"],
    ["L13","Derived Analytics",spreads.length ? "COMPLETED_WITH_GAPS" : "INSUFFICIENT_INPUT"],["L14","Chart-ready",latest.length ? "COMPLETED_WITH_GAPS" : "BLOCKED"],
    ["L15","Comparison-ready",latestSpreads.size ? "COMPLETED_WITH_GAPS" : "INSUFFICIENT_INPUT"],["L16","Incremental","RUNNERS_IDEMPOTENT_NOT_SCHEDULED"],
    ["L17","Scheduler / Production","OWNED_BY_RAILWAY_VERIFY_ONLY"],["L18","Durable Archive",archiveManifest.length ? "COMPLETED" : "BLOCKED"],
    ["L19","Quality / Lineage",duplicateKeys.size ? "COMPLETED_WITH_GAPS" : "COMPLETED"],["L20","Failure / Retry",failureCount ? "RETRY_PENDING" : "COMPLETED"],
    ["L21","Missing Matrix","COMPLETED"],["L22","Maintenance Mode","OFFLINE_PENDING_SCHEDULER_VERIFICATION"]
  ].map(([id, layer, status]) => ({ id, layer, status }));
  await writeFile(path.join(PRODUCTS, "latest.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), rows: latest }, null, 2)}\n`);
  await writeFile(path.join(PRODUCTS, "freshness.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), rows: freshness }, null, 2)}\n`);
  await writeFile(path.join(PRODUCTS, "curve-spreads.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), rows: spreads }, null, 2)}\n`);
  await writeFile(path.join(PRODUCTS, "chart-ready.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), rows: latest }, null, 2)}\n`);
  await writeFile(path.join(PRODUCTS, "comparison-ready.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), rows: [...latestSpreads.values()] }, null, 2)}\n`);
  await writeFile(path.join(PRODUCTS, "archive-manifest.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), files: archiveManifest }, null, 2)}\n`);
  await writeFile(path.join(PRODUCTS, "quality.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), observations: rows.length, series: latest.length, duplicateKeys: [...duplicateKeys], status: duplicateKeys.size ? "PASS_WITH_GAPS" : "PASS" }, null, 2)}\n`);
  await writeFile(path.join(PRODUCTS, "missing-matrix.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), asset: "GOVERNMENT_YIELD", layers, countriesRegistered: registered, countriesCaptured: [...captured].sort(), failureCount }, null, 2)}\n`);
  const completionManifest = {
    asset: "GOVERNMENT_YIELD",
    finalStatus: "BLOCKED_SYSTEM_RISK",
    generatedAt: new Date().toISOString(),
    countries: { universe: REGISTRY.countries.length, registered, captured: [...captured].sort() },
    observations: rows.length,
    series: latest.length,
    spreads: spreads.length,
    archiveFiles: archiveManifest.length,
    quality: { duplicateKeys: duplicateKeys.size, status: duplicateKeys.size ? "PASS_WITH_GAPS" : "PASS" },
    failures: failureCount,
    blockingGaps: [{ layer: "L17_SCHEDULER_PRODUCTION", reasonCode: "OWNERSHIP_COLLISION", evidence: "RAILWAY is ACTIVE for asset-daily, macro-incremental, retry and scheduler; bond_yield-production-daily exists without an explicit scoped split for the official-file pipeline. A second writer/lock/deployment was not started." }],
    nonBlockingGaps: REGISTRY.countries.filter((country) => country.status !== "REGISTERED").map((country) => ({ country: country.id, reasonCode: country.status })),
    layers,
    maintenance: "OFFLINE_PENDING_OWNER_RESOLUTION",
    continuing: false
  };
  await writeFile(path.join(PRODUCTS, "completion-manifest.json"), `${JSON.stringify(completionManifest, null, 2)}\n`);
  console.log(JSON.stringify({ observations: rows.length, series: latest.length, countriesCaptured: [...captured].sort(), spreads: spreads.length, archiveFiles: archiveManifest.length, duplicateKeys: duplicateKeys.size, failureCount, next: "VERIFY_RAILWAY_SCHEDULER_OWNERSHIP" }, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
