import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient();
const runtimeDir = resolve("runtime/global-fund/documents");
const registry = JSON.parse(readFileSync(resolve("config/fund-documents-registry.json"), "utf8")) as { documents: any[] };
const allowedHosts = new Set(["go.alliancebernstein.com", "www.franklin.com.tw", "api.schroders.com"]);

async function atomicJson(name: string, value: unknown) {
  await mkdir(runtimeDir, { recursive: true });
  const path = resolve(runtimeDir, name);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function main() {
  const completed: any[] = [];
  const failed: any[] = [];
  for (const document of registry.documents) {
    try {
      const url = new URL(document.url);
      if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("DOCUMENT_URL_NOT_OFFICIAL");
      const verified = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT EXISTS (SELECT 1 FROM fund_provider_mappings WHERE fund_id=$1 AND share_class_id=$2 AND source IS NOT NULL AND verified_at IS NOT NULL) ok`, document.fundId, document.shareClassId);
      if (!verified[0]?.ok) throw new Error("DOCUMENT_FUND_IDENTITY_NOT_VERIFIED");
      let response = await fetch(document.url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) response = await fetch(document.url, { headers: { range: "bytes=0-1023" }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`DOCUMENT_HTTP_${response.status}`);
      const action = await prisma.$transaction(async (tx) => {
        const lock = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(`SELECT pg_try_advisory_xact_lock(hashtext('smartfund:fund-documents:latest:v1')) locked`);
        if (!lock[0]?.locked) throw new Error("FUND_DOCUMENTS_SINGLE_WRITER_LOCKED");
        const exists = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM fund_documents WHERE fund_id=$1 AND COALESCE(share_class_id,'')=COALESCE($2,'') AND document_type=$3 AND url=$4 LIMIT 1`, document.fundId, document.shareClassId, document.documentType, document.url);
        if (exists[0]) return "SKIP_CURRENT";
        await tx.$executeRawUnsafe(`UPDATE fund_documents SET is_current=false,updated_at=CURRENT_TIMESTAMP WHERE fund_id=$1 AND COALESCE(share_class_id,'')=COALESCE($2,'') AND document_type=$3 AND is_current=true`, document.fundId, document.shareClassId, document.documentType);
        await tx.$executeRawUnsafe(`INSERT INTO fund_documents (id,fund_id,share_class_id,document_type,document_title,document_date,language,jurisdiction,url,source,source_record_id,is_current,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, randomUUID(), document.fundId, document.shareClassId, document.documentType, document.documentTitle, document.documentDate, document.language, document.jurisdiction, document.url, document.source, document.sourceRecordId);
        return "WRITE_NEW_VERSION";
      });
      completed.push({ ...document, action });
    } catch (error) { failed.push({ fundId: document.fundId, error: error instanceof Error ? error.message : String(error) }); }
  }
  const now = new Date();
  const nextEligibleAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await atomicJson("queue.json", { version: 1, updatedAt: now.toISOString(), active: true, boundedConcurrency: 1, maxRetry: 3, items: registry.documents.map((document) => ({ fundCompany: document.fundCompany, fundId: document.fundId, shareClassId: document.shareClassId, source: document.source, documentType: document.documentType, lastSourceRecord: document.sourceRecordId, nextEligibleAt, status: failed.some((item) => item.fundId === document.fundId) ? "FAILED_ISOLATED" : "HEALTHY_WAITING" })) });
  const last = completed.at(-1);
  await atomicJson("checkpoint.json", { fundCompany: last?.fundCompany ?? null, fundId: last?.fundId ?? null, shareClassId: last?.shareClassId ?? null, documentType: last?.documentType ?? null, lastSourceRecord: last?.sourceRecordId ?? null, lastDocumentDate: last?.documentDate ?? null, lastSuccessfulRun: completed.length ? now.toISOString() : null, nextEligibleAt, status: failed.length ? "PARTIAL_CURRENT" : "HEALTHY_WAITING" });
  await atomicJson("health.json", { owner: "fund-documents-supervisor", runnerPid: process.pid, lastHeartbeat: now.toISOString(), latestPath: true, incremental: true, scheduler: process.env.FUND_DOCUMENTS_SCHEDULER === "1", autoContinuing: process.env.FUND_DOCUMENTS_SCHEDULER === "1", singleWriter: true, completed: completed.length, failed: failed.length, status: failed.length ? "PARTIAL_CURRENT" : "HEALTHY_WAITING" });
  console.log(JSON.stringify({ completed: completed.length, failed }));
  if (failed.length) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
