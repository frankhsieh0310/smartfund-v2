// 選股反查：基金持股比對缺口的根因之二（2026-10-25，使用者核准定案）。
// VERIFIED發現：美股主要掛牌（例如MSFT）自己的別名清單裡，根本沒有基金最常用的揭露格式
// （例如"MICROSOFT CORP"），只是純粹缺別名，不是消歧問題。這支模組負責從Yahoo longName
// 產生「能確定」的別名，只補資料，不改比對邏輯。
//
// 規則（使用者核准）：
// 1. 只處理「Yahoo確認是主要掛牌」的股票——掛牌國家(country)等於Yahoo assetProfile總部國家
//    對應的2碼代號。跨市場掛牌一律不加別名。
// 2. 產生的候選別名：
//    (a) longName本身
//    (b) 公司字尾標準縮寫版本：Corporation→Corp、Incorporated→Inc、Company→Co、
//        Limited→Ltd、Public Limited Company→PLC、Holdings→Hldgs、International→Intl
//    (c) 去掉字尾的版本——只有在正規化後，目前「全系統唯一」（沒有其他股票的既有別名
//        正規化後長得一樣）才加入，避免把不同公司的簡稱混在一起
// 3. 寫入方式：securities新增一列(name=別名文字)，stock_security_links連到該股票，
//    mapping_source='YAHOO_LONGNAME'，verification_status='VERIFIED_YAHOO_LONGNAME'
//    （'VERIFIED%'開頭，核心函式的既有別名匹配邏輯本來就會吃進去，不用改核心函式）。
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  "UNITED STATES": "US", GERMANY: "DE", NETHERLANDS: "NL", SWITZERLAND: "CH",
  ITALY: "IT", "UNITED KINGDOM": "GB", CANADA: "CA", TAIWAN: "TW", JAPAN: "JP",
  FRANCE: "FR", CHINA: "CN", "HONG KONG": "HK", "SOUTH KOREA": "KR", SPAIN: "ES",
  BELGIUM: "BE", SWEDEN: "SE", AUSTRALIA: "AU", IRELAND: "IE", LUXEMBOURG: "LU",
};

export function mapHqCountryToCode(hqCountry: string | null): string | null {
  if (!hqCountry) return null;
  return COUNTRY_NAME_TO_CODE[hqCountry.toUpperCase()] ?? null;
}

// 字尾標準縮寫對照——只在「整個字尾詞」相符時替換，不做部分字串替換，避免誤改公司名稱本身。
const SUFFIX_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bCorporation\b\.?$/i, "Corp"],
  [/\bIncorporated\b\.?$/i, "Inc"],
  [/\bCompany\b\.?$/i, "Co"],
  [/\bLimited\b\.?$/i, "Ltd"],
  [/\bPublic Limited Company\b\.?$/i, "PLC"],
  [/\bHoldings\b\.?$/i, "Hldgs"],
  [/\bInternational\b\.?$/i, "Intl"],
];
// 用來產生「去掉字尾」版本的同一組字尾詞（含縮寫跟全名兩種，因為longName可能本來就是縮寫形式）。
const SUFFIX_STRIP_RE = /\s+(Corporation|Corp|Incorporated|Inc|Company|Co|Limited|Ltd|Public Limited Company|PLC|Holdings|Hldgs|International|Intl)\.?$/i;

export function normalizeForUniqueness(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type AliasCandidate = { text: string; kind: "LONGNAME" | "ABBREVIATION" | "SUFFIX_STRIPPED" };

/** 產生候選別名文字（不含唯一性判斷——去尾版本的唯一性檢查需要查資料庫，留給呼叫端做）。 */
export function generateAliasCandidates(longName: string): AliasCandidate[] {
  const candidates: AliasCandidate[] = [{ text: longName, kind: "LONGNAME" }];
  for (const [re, abbr] of SUFFIX_ABBREVIATIONS) {
    if (re.test(longName)) {
      candidates.push({ text: longName.replace(re, abbr), kind: "ABBREVIATION" });
      break; // 一個名稱只會符合一種字尾
    }
  }
  const stripped = longName.replace(SUFFIX_STRIP_RE, "").trim();
  if (stripped && stripped !== longName) {
    candidates.push({ text: stripped, kind: "SUFFIX_STRIPPED" });
  }
  // 去重（有些名稱縮寫後可能跟去尾版本剛好一樣）
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = normalizeForUniqueness(c.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type PrimaryListingStock = { id: string; ticker: string; country: string; yahooLongName: string };

export async function findPrimaryListingStocksNeedingAlias(): Promise<PrimaryListingStock[]> {
  // 只處理country等於Yahoo總部國家對應代號的（主要掛牌），且還沒有來自YAHOO_LONGNAME的別名。
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; ticker: string; country: string; yahoo_long_name: string; yahoo_hq_country: string }>>(
    `SELECT s.id, s.ticker, s.country, s.yahoo_long_name, s.yahoo_hq_country
       FROM stocks s
      WHERE s.is_active AND s.yahoo_long_name IS NOT NULL AND s.yahoo_hq_country IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM stock_security_links l WHERE l.stock_id = s.id AND l.mapping_source = 'YAHOO_LONGNAME'
        )`,
  );
  return rows
    .filter((r) => mapHqCountryToCode(r.yahoo_hq_country) === r.country)
    .map((r) => ({ id: r.id, ticker: r.ticker, country: r.country, yahooLongName: r.yahoo_long_name }));
}

export type AliasInsertPlan = {
  stockId: string; ticker: string; text: string; kind: AliasCandidate["kind"];
  skippedReason?: "NOT_GLOBALLY_UNIQUE";
};

// 2026-10-26（使用者核准範圍，事後發現並修正）: 全規模ROLLBACK測試VERIFIED一個bug——這個
// 「全系統唯一才加入」的檢查原本只套用在SUFFIX_STRIPPED這一種候選，LONGNAME/ABBREVIATION
// 兩種完全沒檢查、一律無條件寫入。根因：457檔跨市場次要掛牌（多半是法蘭克福.F、米蘭.MI這類
// 冷門重複上市）本來就已經有跟主要掛牌公司同名的別名（資料來源本身的既有瑕疵），新增的
// LONGNAME/ABBREVIATION別名寫到主要掛牌股票上後，這個名稱才變成「兩檔股票共用」——導致它從
// unique_names退場，公司債ETF持有的這家公司債券（country為空、原本靠unique_names配對到
// 次要掛牌）反而配不到任何一檔，造成移除。修法：三種候選一律套用同一個「全系統唯一才加入」
// 檢查，不再只限SUFFIX_STRIPPED——跟SUFFIX_STRIPPED用同一個安全原則，不製造新的名稱衝突。
// 2026-10-28（使用者核准範圍，全規模ROLLBACK測試第3次重跑才VERIFIED發現）: 上面的
// clash check只比對「這批次開始前」reverse_current_securities裡既有的別名，比對不到
// 「同一批次裡，另一檔股票也剛好產生同一個正規化文字」這種情況——兩邊各自覺得自己唯一、
// 各自成功計畫插入，等全部插入完、refresh_reverse_securities重建後，這個名字才變成兩檔
// 股票共用，可能打斷第三者（原本靠這個名字唯一性配對到的其他持股）的比對。實測抓到
// VDV(Samsung Fire & Marine Insurance等)、FLBR(Vale SA等)共7筆這種批次內互撞造成的
// 錯誤移除。修法：產生完整批次候選後，先在記憶體裡統計每個正規化文字被幾檔「不同」股票
// 用到，批次內被兩檔以上股票共用的文字，整批都不插入（不只留最後一個）。
function dedupeAcrossBatch(plans: AliasInsertPlan[]): AliasInsertPlan[] {
  const textOwners = new Map<string, Set<string>>();
  for (const p of plans) {
    if (p.skippedReason) continue;
    const key = normalizeForUniqueness(p.text);
    if (!textOwners.has(key)) textOwners.set(key, new Set());
    textOwners.get(key)!.add(p.stockId);
  }
  const batchCollisions = new Set([...textOwners.entries()].filter(([, ids]) => ids.size > 1).map(([k]) => k));
  return plans.map((p) =>
    !p.skippedReason && batchCollisions.has(normalizeForUniqueness(p.text))
      ? { ...p, skippedReason: "NOT_GLOBALLY_UNIQUE" as const }
      : p,
  );
}

/** 計算每檔主要掛牌股票要新增的別名清單（含唯一性檢查，三種候選一律檢查，並排除批次內互撞），不執行任何寫入。 */
export async function planAliasInserts(stocks: PrimaryListingStock[]): Promise<AliasInsertPlan[]> {
  const plans: AliasInsertPlan[] = [];
  for (const s of stocks) {
    const candidates = generateAliasCandidates(s.yahooLongName);
    for (const c of candidates) {
      const key = normalizeForUniqueness(c.text);
      // 「全系統唯一」用reverse_current_securities目前的names聯集檢查——這是既有別名的權威來源。
      const clash = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int n FROM reverse_current_securities WHERE $1 = ANY(names) AND id <> $2`,
        key, s.id,
      );
      if ((clash[0]?.n ?? 0) > 0) {
        plans.push({ stockId: s.id, ticker: s.ticker, text: c.text, kind: c.kind, skippedReason: "NOT_GLOBALLY_UNIQUE" });
        continue;
      }
      plans.push({ stockId: s.id, ticker: s.ticker, text: c.text, kind: c.kind });
    }
  }
  return dedupeAcrossBatch(plans);
}

export async function applyAliasInserts(plans: AliasInsertPlan[]): Promise<number> {
  let written = 0;
  for (const p of plans) {
    if (p.skippedReason) continue;
    const secId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO securities (id, name, created_at, updated_at) VALUES ($1, $2, now(), now())`,
      secId, p.text,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO stock_security_links (id, stock_id, security_id, mapping_source, verification_status, verified_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'YAHOO_LONGNAME', 'VERIFIED_YAHOO_LONGNAME', now(), now(), now())
       ON CONFLICT (stock_id, security_id) DO NOTHING`,
      randomUUID(), p.stockId, secId,
    );
    written++;
  }
  return written;
}
