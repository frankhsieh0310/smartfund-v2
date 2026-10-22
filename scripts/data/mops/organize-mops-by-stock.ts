import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const STAGING = path.join(process.cwd(), "runtime", "mops-staging");
const OUTPUT = path.join(process.cwd(), "runtime", "mops-by-stock");

type Row = Record<string, unknown>;
type Manifest = {
  domain: string;
  source: string;
  sourceReference: string;
  fetchedAt: string;
  contentHash: string;
  objectPath: string;
  provenance?: Record<string, unknown>;
};

const DOMAIN_DIR: Record<string, string> = {
  MONTHLY_REVENUE: "monthly-revenue",
  CORPORATE_STRUCTURE: "corporate-structure",
  RELATED_PARTY_TRANSACTIONS: "related-party",
  CAPITAL_FUNDING_RISK: "capital-funding-risk",
  GOVERNANCE: "governance",
  MOPS_OWNERSHIP: "ownership",
  MATERIAL_EVENTS: "material-events",
  INVESTOR_RELATIONS: "investor-relations",
  ESG: "esg",
  OFFICIAL_DOCUMENTS: "documents",
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stockCode(row: Row) {
  return text(row["公司代號"]) || text(row.companyIdentifier) || text(row.ticker);
}

function companyName(row: Row) {
  return text(row["公司名稱"]) || text(row.companyName);
}

function recordDate(row: Row) {
  const direct = text(row.announcementOrReportDate) || text(row["公告日期"]) || text(row["出表日期"]);
  if (/^\d{7}$/.test(direct)) {
    return `${Number(direct.slice(0, 3)) + 1911}-${direct.slice(3, 5)}-${direct.slice(5, 7)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(direct)) return direct.slice(0, 10);
  const period = text(row.period) || text(row["資料年月"]);
  if (/^\d{5}$/.test(period)) {
    const year = Number(period.slice(0, 3)) + 1911;
    const month = Number(period.slice(3, 5));
    return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  }
  return null;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function main() {
  const grouped = new Map<string, Map<string, Map<string, Map<string, Row>>>>();
  const names = new Map<string, string>();
  const dates = new Map<string, string>();
  const domainCounts = new Map<string, number>();
  let sourceRowsSeen = 0;

  for (const manifestFile of (await readdir(path.join(STAGING, "manifests"))).sort()) {
    const dataset = manifestFile.replace(/\.json$/, "");
    const manifest = JSON.parse(await readFile(path.join(STAGING, "manifests", manifestFile), "utf8")) as Manifest;
    const domain = DOMAIN_DIR[manifest.domain];
    if (!domain) throw new Error(`UNKNOWN_DOMAIN:${manifest.domain}`);
    const payload = JSON.parse(await readFile(path.join(STAGING, manifest.objectPath), "utf8"));
    const rows: Row[] = Array.isArray(payload) ? payload : payload.data ?? [];

    for (const originalPayload of rows) {
      sourceRowsSeen += 1;
      const code = stockCode(originalPayload) || "_unmapped";
      const normalized = {
        companyCode: stockCode(originalPayload) || null,
        companyName: companyName(originalPayload) || null,
        domain,
        dataType: dataset,
        period: text(originalPayload.period) || text(originalPayload["資料年月"]) || null,
        announcementOrReportDate: recordDate(originalPayload),
        source: manifest.source,
        sourceReference: manifest.sourceReference,
        fetchedAt: manifest.fetchedAt,
        officialRecordOrDocumentId: text(originalPayload.documentOrEventId) || null,
        originalNormalizedPayload: originalPayload,
        provenance: manifest.provenance ?? {
          source: manifest.source,
          sourceReference: manifest.sourceReference,
          fetchedAt: manifest.fetchedAt,
          contentHash: manifest.contentHash,
        },
      };
      const recordKey = createHash("sha256").update(`${dataset}:${stable(normalized)}`).digest("hex");
      const domains = grouped.get(code) ?? new Map();
      const datasets = domains.get(domain) ?? new Map();
      const records = datasets.get(dataset) ?? new Map();
      records.set(recordKey, { recordKey, ...normalized });
      datasets.set(dataset, records);
      domains.set(domain, datasets);
      grouped.set(code, domains);
      if (code !== "_unmapped" && normalized.companyName) names.set(code, normalized.companyName);
      if (normalized.announcementOrReportDate && normalized.announcementOrReportDate > (dates.get(code) ?? "")) dates.set(code, normalized.announcementOrReportDate);
    }
  }

  let stockFolders = 0;
  let indexFiles = 0;
  let organized = 0;
  let unmapped = 0;
  for (const [code, domains] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    const recordsByDomain: Record<string, number> = {};
    for (const [domain, datasets] of domains) {
      let domainTotal = 0;
      const domainPath = path.join(OUTPUT, code, domain);
      await mkdir(domainPath, { recursive: true });
      for (const [dataset, records] of datasets) {
        const values = [...records.values()];
        await writeFile(path.join(domainPath, `${dataset}.json`), `${JSON.stringify(values, null, 2)}\n`, "utf8");
        domainTotal += values.length;
      }
      recordsByDomain[domain] = domainTotal;
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + domainTotal);
    }
    const totalRecords = Object.values(recordsByDomain).reduce((sum, count) => sum + count, 0);
    await mkdir(path.join(OUTPUT, code), { recursive: true });
    await writeFile(path.join(OUTPUT, code, "index.json"), `${JSON.stringify({
      stockCode: code.startsWith("_") ? null : code,
      companyName: names.get(code) ?? null,
      totalRecords,
      recordsByDomain,
      latestRecordDate: dates.get(code) ?? null,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    indexFiles += 1;
    if (code === "_unmapped") unmapped += totalRecords;
    else {
      stockFolders += 1;
      organized += totalRecords;
    }
  }

  const summary = {
    status: "COMPLETE",
    sourceStagingRecords: sourceRowsSeen,
    stockFoldersCreated: stockFolders,
    stockRecordsOrganized: organized,
    unmappedRecords: unmapped,
    crossCompanyRecords: 0,
    recordsByDomain: Object.fromEntries([...domainCounts].sort()),
    indexFilesCreated: indexFiles,
    sourceDuplicatesSuppressed: sourceRowsSeen - organized - unmapped,
    duplicatesCreated: 0,
    originalStagingPreserved: true,
  };
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(path.join(OUTPUT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
