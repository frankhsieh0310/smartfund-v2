// SEC Form 4 insider-ownership 增量擷取（2026-11-11，使用者核准新建）：insider_ownership_transactions
// 這張表原本完全沒有排程寫入過（整個repo查不到任何抓Form4的程式/workflow），資料庫裡的既有資料是
// 某次一次性手動寫入，卡在2026-09-11沒人再更新。範圍限定在insider_ownership_eligible_issuers這份
// 既有、已核准的CIK清單（"目前優先涵蓋大型美股"），不擴大範圍。只解析nonDerivativeTable（Table I）
// ——跟既有資料的transaction_type值（S/M/F/A/P/J/G/C/D/I/X全部是Table I代碼）完全一致，既有資料的
// role欄位本來就一律是null，這裡沿用（不新增role解析，避免偏離既有欄位用途）。
import { prisma } from "@/lib/prisma";
import crypto from "crypto";

const SEC_UA = "SmartMatchApp-InsiderOwnership research-contact@smartmatch-app.example";
const REQUEST_DELAY_MS = 350; // SEC fair-access：遠低於10 req/sec，比既有yahooClient的300ms節流更保守

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

type EligibleIssuer = { cik: string; securityId: string; ticker: string };

async function fetchJson(url: string): Promise<{ status: number; json: unknown } | null> {
  await sleep(REQUEST_DELAY_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": SEC_UA, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      throw new Error(`SEC_BLOCKED_${res.status}`);
    }
    if (!res.ok) return { status: res.status, json: null };
    return { status: res.status, json: await res.json() };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("SEC_BLOCKED_")) throw e;
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  await sleep(REQUEST_DELAY_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": SEC_UA }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403 || res.status === 429) throw new Error(`SEC_BLOCKED_${res.status}`);
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("SEC_BLOCKED_")) throw e;
    return null;
  }
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : null;
}
function nestedValue(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}>[\\s\\S]*?<value>([\\s\\S]*?)</value>[\\s\\S]*?</${name}>`));
  return m ? m[1].trim() : null;
}

type ParsedTx = { transactionDate: string; transactionCode: string; shares: number; price: number | null; ownershipAfter: number | null };

function parseForm4(xml: string): { ownerName: string | null; ownerCik: string | null; transactions: ParsedTx[] } {
  const ownerBlock = xml.match(/<reportingOwner>[\s\S]*?<\/reportingOwner>/)?.[0] ?? "";
  const ownerName = tag(ownerBlock, "rptOwnerName");
  const ownerCik = tag(ownerBlock, "rptOwnerCik");
  const transactions: ParsedTx[] = [];
  const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) ?? [];
  for (const block of blocks) {
    const transactionDate = nestedValue(block, "transactionDate");
    const transactionCode = block.match(/<transactionCode>([\s\S]*?)<\/transactionCode>/)?.[1]?.trim() ?? null;
    const sharesStr = nestedValue(block, "transactionShares");
    const priceStr = nestedValue(block, "transactionPricePerShare");
    const ownedAfterStr = nestedValue(block, "sharesOwnedFollowingTransaction");
    if (!transactionDate || !transactionCode || !sharesStr) continue;
    transactions.push({
      transactionDate,
      transactionCode,
      shares: Number(sharesStr),
      price: priceStr ? Number(priceStr) : null,
      ownershipAfter: ownedAfterStr ? Number(ownedAfterStr) : null,
    });
  }
  return { ownerName, ownerCik, transactions };
}

function toTitleCase(raw: string): string {
  return raw.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

export type Form4IngestResult = {
  issuersProcessed: number;
  filingsFetched: number;
  rowsInserted: number;
  lastCursor: string | null;
  stoppedReason: "TIME_BUDGET" | "EXHAUSTED" | null;
};

/**
 * 一次呼叫：從 afterTicker 之後的下一批 eligible issuer 開始，逐家issuer查submissions JSON，
 * 抓新filing的raw XML解析寫入。bounded by timeBudgetMs，回傳下一次要接續的cursor（issuer ticker）。
 */
export async function runSecForm4IngestBatch(opts: { afterTicker: string | null; timeBudgetMs: number }): Promise<Form4IngestResult> {
  const started = Date.now();
  const issuers = await prisma.$queryRawUnsafe<EligibleIssuer[]>(
    `SELECT e.cik, e.security_id AS "securityId", s.ticker
       FROM insider_ownership_eligible_issuers e JOIN securities s ON s.id = e.security_id
      WHERE s.ticker > $1
      ORDER BY s.ticker ASC`,
    opts.afterTicker ?? "",
  );

  let issuersProcessed = 0, filingsFetched = 0, rowsInserted = 0;
  let lastCursor: string | null = opts.afterTicker;
  let stoppedReason: Form4IngestResult["stoppedReason"] = null;

  for (const issuer of issuers) {
    if (Date.now() - started > opts.timeBudgetMs) { stoppedReason = "TIME_BUDGET"; break; }
    lastCursor = issuer.ticker;
    issuersProcessed++;

    const cikPadded = issuer.cik.padStart(10, "0");
    const sub = await fetchJson(`https://data.sec.gov/submissions/CIK${cikPadded}.json`);
    if (!sub || !sub.json) continue;
    const data = sub.json as { filings?: { recent?: { form: string[]; accessionNumber: string[]; filingDate: string[]; primaryDocument: string[] } } };
    // primaryDocument是「xslF345X06/<原始檔名>」這種XSLT轉換view路徑，不是真正可下載的原始XML
    // 路徑——原始檔名在不同filer agent下不固定（QCOM是edgardoc.xml，AAPL是form4.xml），必須從
    // primaryDocument拆出來，不能假設固定檔名（2026-11-11 VERIFIED：寫死edgardoc.xml時AAPL/4家
    // issuer全部抓不到檔案，filingsFetched=0）。
    const recent = data.filings?.recent;
    if (!recent) continue;

    const lastKnown = await prisma.$queryRawUnsafe<Array<{ max_date: Date | null; existing: string[] }>>(
      `SELECT max(t.transaction_date) AS max_date,
              array_agg(DISTINCT t.filing_id) AS existing
         FROM insider_ownership_transactions t WHERE t.security_id = $1`,
      issuer.securityId,
    );
    const maxDate = lastKnown[0]?.max_date;
    const existingFilingIds = new Set(lastKnown[0]?.existing ?? []);
    // 從未抓過的issuer：只往回補60天，不嘗試重建年資料歷史（範圍控制，見檔案開頭說明）。
    const cutoff = maxDate ? new Date(maxDate.getTime() - 3 * 86_400_000) : new Date(Date.now() - 60 * 86_400_000);

    for (let i = 0; i < recent.form.length; i++) {
      if (Date.now() - started > opts.timeBudgetMs) { stoppedReason = "TIME_BUDGET"; break; }
      if (recent.form[i] !== "4") continue;
      const filingDate = new Date(recent.filingDate[i]);
      if (filingDate < cutoff) continue;
      const accession = recent.accessionNumber[i];
      if (existingFilingIds.has(accession)) continue;

      const cikNum = String(Number(issuer.cik));
      const accessionNoDash = accession.replaceAll("-", "");
      const rawFileName = recent.primaryDocument[i].split("/").pop();
      if (!rawFileName) continue;
      const xml = await fetchText(`https://www.sec.gov/Archives/edgar/data/${cikNum}/${accessionNoDash}/${rawFileName}`);
      if (!xml) continue;
      filingsFetched++;
      const parsed = parseForm4(xml);
      if (!parsed.ownerName || parsed.transactions.length === 0) continue;
      const insiderName = toTitleCase(parsed.ownerName);

      for (let idx = 0; idx < parsed.transactions.length; idx++) {
        const tx = parsed.transactions[idx];
        const sourceKey = crypto.createHash("sha256")
          .update(`${accession}:${parsed.ownerCik}:${tx.transactionDate}:${tx.transactionCode}:${tx.shares}:${tx.price ?? ""}:${idx}`)
          .digest("hex");
        const before = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
          `SELECT count(*)::bigint AS c FROM insider_ownership_transactions WHERE source_key = $1`, sourceKey,
        );
        if (Number(before[0]?.c ?? 0) > 0) continue;
        await prisma.$transaction(async (tx2) => {
          const verify = await tx2.$queryRawUnsafe<Array<{ c: bigint }>>(
            `SELECT count(*)::bigint AS c FROM insider_ownership_transactions WHERE source_key = $1`, sourceKey,
          );
          if (Number(verify[0]?.c ?? 0) > 0) return;
          // 2026-11-13（ChatGPT第三輪審查第7項，使用者已在正式DB核准並自行加好filing_date欄位）:
          // filingDate（SEC申報日）在上面第140行解析時就已經有了，之前只拿來做cutoff篩選就丟棄，
          // 現在一併寫入，不需要新的資料來源/新的抓取。
          await tx2.$executeRawUnsafe(
            `INSERT INTO insider_ownership_transactions
               (id, security_id, insider, role, transaction_date, filing_date, transaction_type, shares, price, ownership_after, source, filing_id, source_key, created_at, updated_at)
             VALUES (gen_random_uuid(), $1, $2, NULL, $3::date, $4::date, $5, $6, $7, $8, 'SEC EDGAR Form 4', $9, $10, now(), now())`,
            issuer.securityId, insiderName, tx.transactionDate, recent.filingDate[i], tx.transactionCode, tx.shares, tx.price, tx.ownershipAfter, accession, sourceKey,
          );
          const after = await tx2.$queryRawUnsafe<Array<{ c: bigint }>>(
            `SELECT count(*)::bigint AS c FROM insider_ownership_transactions WHERE source_key = $1`, sourceKey,
          );
          if (Number(after[0]?.c ?? 0) !== 1) throw new Error(`INSERT_VERIFY_FAILED:${sourceKey}`);
        });
        rowsInserted++;
      }
    }
    if (stoppedReason === "TIME_BUDGET") break;
  }
  if (!stoppedReason) stoppedReason = issuersProcessed >= issuers.length ? "EXHAUSTED" : null;
  return { issuersProcessed, filingsFetched, rowsInserted, lastCursor, stoppedReason };
}
