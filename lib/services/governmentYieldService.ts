import { readFile } from "node:fs/promises";
import path from "node:path";

const root = () => path.resolve(process.env.GOVERNMENT_YIELD_RUNTIME_ROOT ?? path.join("runtime", "government-yield"), "serving");
async function json<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")); }

// 2026-11-08（使用者回報：正式網站搜尋固定收益失敗，VERIFIED根因）: 這整支服務讀的是本機檔案
// （runtime/government-yield/serving/*.json），不是資料庫——這個runtime/目錄本身是本機排程產出
// 的工作目錄（desktop-supervisor等既有排程會持續寫入，VERIFIED本機
// C:\Users\User\Desktop\smartfund-v2\runtime\government-yield\serving 底下確實有248MB真實資料），
// 但從未被commit進git、也從未被部署到Vercel——Vercel serverless function讀不到使用者自己電腦上
// 的檔案，所以正式環境這個serving目錄永遠是空的，readFile直接拋ENOENT，導致整個FIXED_INCOME
// 搜尋網域500/503。這是架構層的缺口（本機檔案式serving層 vs. serverless無狀態執行環境），不是
// 這裡能一次改完的——要嘛改成讀資料庫（跟其他資產類別一致的作法），要嘛把serving資料上傳到
// blob/object storage讓serverless function能讀到，需要使用者決定方向，另外排一輪處理。
// 這裡先做安全降級：檔案不存在時回傳空陣列，不讓整個搜尋網域噴錯——type=FIXED_INCOME單獨搜尋
// 會變成「找不到結果」而不是503整頁失敗，搜尋「全部」類型時也不會再跳「部分資料來源暫時無法
// 搜尋」的提示（因為這個網域已經不會失敗，只是正常回傳0筆）。
async function jsonOrEmpty<T>(file: string, empty: T): Promise<T> {
  try {
    return await json<T>(file);
  } catch (e: any) {
    if (e?.code === "ENOENT") return empty;
    throw e;
  }
}

export async function listGovernmentYieldSeries(filters: Record<string, string | null>) {
  const identities = await jsonOrEmpty<{ rows: Array<Record<string, unknown>> }>(path.join(root(), "identities.json"), { rows: [] });
  if (!identities.rows.length) return [];
  const analytics = await jsonOrEmpty<{ rows: Array<Record<string, unknown> & { canonicalId: string }> }>(path.join(root(), "analytics", "series.json"), { rows: [] });
  const analyticsById = new Map(analytics.rows.map((row) => [row.canonicalId, row]));
  const query = filters.query?.toLowerCase();
  return identities.rows.filter((row) => {
    if (query && ![row.canonicalId, row.officialName, row.jurisdiction, row.authority, row.tenor].some((value) => String(value).toLowerCase().includes(query))) return false;
    for (const field of ["jurisdiction", "currency", "tenor", "curveType", "authority", "officialSource"]) if (filters[field] && String(row[field]) !== filters[field]) return false;
    return true;
  }).map((row) => ({ ...row, analytics: analyticsById.get(String(row.canonicalId)) }));
}

export async function getGovernmentYieldDetail(canonicalId: string) {
  const identities = await json<{ rows: Array<Record<string, unknown> & { canonicalId: string }> }>(path.join(root(), "identities.json"));
  const identity = identities.rows.find((row) => row.canonicalId === canonicalId);
  if (!identity) return null;
  const history = await json<Record<string, unknown>>(path.join(root(), "history", `${canonicalId}.json`));
  const analytics = await json<{ rows: Array<Record<string, unknown> & { canonicalId: string }> }>(path.join(root(), "analytics", "series.json"));
  const curves = await json<{ rows: Array<Record<string, unknown> & { points: Array<{ seriesId: string }> }> }>(path.join(root(), "analytics", "curves.json"));
  return { identity, history, analytics: analytics.rows.find((row) => row.canonicalId === canonicalId), curveContext: curves.rows.filter((curve) => curve.points.some((point) => point.seriesId === canonicalId)) };
}

export async function getGovernmentYieldContracts() { return json(path.join(root(), "contracts.json")); }
