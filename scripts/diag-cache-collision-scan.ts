// Read-only. Scans the existing 331-ticker fetch cache (no network calls, no refetch) for every
// (snapshot_id, security_code)-equivalent collision — i.e. duplicate securityCode within one cached
// snapshot's positions[] — and prints the full inventory, not just the first hit.
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE_PATH = path.join(ROOT, "runtime", "etf-holdings-fetch-cache", "latest-fetch-batch.json");

type CachedResult = {
  issuer: string;
  ticker: string;
  snapshot?: {
    etfCode: string; issuer: string; dataDate: string; source: string;
    positions: { securityCode: string; securityName: string; positionType: string; positionUnit: string; positionAmount: number; weight: number }[];
  };
};

function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as { writtenAt: string; results: CachedResult[] };
  const inventory: any[] = [];
  let totalCollisionRows = 0;
  const collisionEtfs = new Set<string>();

  for (const r of cache.results) {
    if (!r.snapshot) continue;
    const byCode = new Map<string, typeof r.snapshot.positions>();
    for (const p of r.snapshot.positions) {
      if (!byCode.has(p.securityCode)) byCode.set(p.securityCode, []);
      byCode.get(p.securityCode)!.push(p);
    }
    for (const [code, rows] of byCode) {
      if (rows.length > 1) {
        collisionEtfs.add(r.ticker);
        totalCollisionRows += rows.length;
        inventory.push({
          issuer: r.issuer, ticker: r.ticker, dataDate: r.snapshot.dataDate, source: r.snapshot.source,
          securityCode: code, duplicateCount: rows.length,
          rows: rows.map((p) => ({
            securityName: p.securityName, positionType: p.positionType, positionUnit: p.positionUnit,
            positionAmount: p.positionAmount, weight: p.weight,
          })),
        });
      }
    }
  }

  console.log(JSON.stringify({
    cacheWrittenAt: cache.writtenAt,
    cacheEtfCount: cache.results.length,
    TOTAL_COLLISION_ETFS: collisionEtfs.size,
    TOTAL_COLLISION_KEYS: inventory.length,
    TOTAL_COLLISION_ROWS: totalCollisionRows,
    COLLISION_INVENTORY: inventory,
  }, null, 2));
}
main();
