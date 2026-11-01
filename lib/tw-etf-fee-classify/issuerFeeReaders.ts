// 2026-10-31（使用者核准，006208過期費率事故後定案）: 台股ETF的經理費/保管費/收益分配改成
// 一律以「發行投信官網的商品頁」為官方來源（Yahoo的annualReportExpenseRatio已VERIFIED對真正
// 缺口的112檔完全沒有值，且006208案例證明Yahoo自己的數字也可能是舊的、API本身無從判斷新舊），
// Yahoo只在發行投信官網這條路也查不到時才當最後備援。
//
// 官網URL格式：不是猜測，而是VERIFIED經由每家官網自己的選單/產品清單導覽取得：
//   元大 https://www.yuantaetfs.com/product/detail/{code}/Basic_information
//     （SITCA會員名錄 -> 元大證券投資信託 -> yuantafunds.com -> 站內ETF投資網連結 ->
//       逐檔Profile頁；此pattern是2026-10-31重新走過yuantaetfs.com站內導覽VERIFIED可用）
//   富邦 https://websys.fsit.com.tw/FubonETF/Fund/Profile.aspx?stkId={code}
//     （SITCA會員名錄 -> 富邦證券投資信託 -> fubon.com -> 富邦投信官網 -> ETF投資網
//       websys.fsit.com.tw/fubonetf/ -> 熱門ETF「了解更多」連結 VERIFIED 取得此pattern）
// 其餘發行投信（國泰cathaysite.com.tw、中信ctbcinvestments.com.tw、群益capitalfund.com.tw、
// 復華fhtrust.com.tw）這輪只VERIFIED官方網域本身（來源：SITCA會員名錄查詢
// https://www.sitca.org.tw/ROC/MemData/MD2001N.aspx?PGMID=AS0701），商品頁URL pattern
// 還沒走過站內導覽、沒有實作讀取函式，誠實列為本輪未完成，不是猜測、不是繞過。
//
// 兩種費率揭露型態（兩家發行投信都有，不是發行投信本身的差異，是基金類型的差異）：
//   (a) 槓桿/反向/期貨型：經理費/保管費都是單一固定數字（例如"0.99%"），沒有級距，可直接採用，
//       沒有官方「資料日期」欄位時，資料日期＝本次擷取日。
//   (b) 大型現股型（如0050/006208）：經理費依規模遞減、保管費也依規模遞減，呈現「級距表」而非
//       單一數字；元大官網會額外算好一個「約X% (資料日期：Y)」的當期加權值可直接採用，富邦官網
//       沒有這個算好的加權值，只列級距本身——這種情況不在這支模組裡自動解析出一個數字，標記為
//       NEEDS_MANUAL_BLEND、附上原始級距文字，交由人工核對後決定是否採用自算加權值，不讓管線
//       自己對级距表做加總猜測。

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export class IssuerSiteRateLimitedError extends Error {
  issuer: string;
  httpStatus: number;
  constructor(issuer: string, httpStatus: number) { super(`${issuer}_HTTP_${httpStatus}`); this.issuer = issuer; this.httpStatus = httpStatus; }
}

export type IssuerFeeResult = {
  managementFeePct: number | null;
  custodyFeePct: number | null;
  totalExpenseRatioPct: number | null; // management + custody, 只有兩者都是單一數字（非級距/非區間）時才算，絕不自行加權級距
  asOfDate: string | null; // 官網自己標的資料日期；沒有就是本次擷取日(fetchDate)
  fetchDate: string;
  distributionFreq: string | null; // "NONE" 或官網原文頻率字串（例如"每年兩次"）
  needsManualBlend: boolean; // true=經理費或保管費其中一項是級距表／區間、沒有官網自己算好的單一值
  rawFeeText: { management: string; custody: string }; // needsManualBlend=true時，這是要照抄存檔、在畫面顯示的級距原文
  notFound: boolean;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function fetchHtml(url: string, issuer: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 403 || res.status === 429) throw new IssuerSiteRateLimitedError(issuer, res.status);
  if (!res.ok) throw new IssuerSiteRateLimitedError(issuer, res.status);
  return res.text();
}

function parseFeeLi(blockHtml: string): { flat: number | null; computed: { value: number; asOfDate: string } | null; tiered: boolean; raw: string } {
  const liMatches = [...blockHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<!--[\s\S]*?-->/g, "").trim());
  const raw = liMatches.join(" | ");
  if (liMatches.length === 0) return { flat: null, computed: null, tiered: false, raw };
  const computedMatch = liMatches[0].match(/約\s*([\d.]+)%\s*\(資料日期[：:]\s*([\d/]+)\)/);
  if (computedMatch) {
    return { flat: null, computed: { value: Number(computedMatch[1]), asOfDate: computedMatch[2].replace(/\//g, "-") }, tiered: liMatches.length > 1, raw };
  }
  if (liMatches.length === 1) {
    const flatMatch = liMatches[0].match(/^([\d.]+)%$/);
    if (flatMatch) return { flat: Number(flatMatch[1]), computed: null, tiered: false, raw };
  }
  return { flat: null, computed: null, tiered: true, raw };
}

export async function readYuantaFee(code: string): Promise<IssuerFeeResult> {
  const url = `https://www.yuantaetfs.com/product/detail/${encodeURIComponent(code)}/Basic_information`;
  const html = await fetchHtml(url, "YUANTA");
  if (html.includes("查無此商品")) {
    return { managementFeePct: null, custodyFeePct: null, totalExpenseRatioPct: null, asOfDate: null, fetchDate: todayIso(), distributionFreq: null, needsManualBlend: false, rawFeeText: { management: "", custody: "" }, notFound: true };
  }
  const mgmtIdx = html.indexOf("經理費");
  const custIdx = html.indexOf("保管費");
  const distMatch = html.match(/收益分配<\/div>\s*<div[^>]*>([^<]*)<\/div>/);
  const mgmtBlock = mgmtIdx >= 0 ? html.slice(mgmtIdx, custIdx > mgmtIdx ? custIdx : mgmtIdx + 1500) : "";
  const custBlock = custIdx >= 0 ? html.slice(custIdx, custIdx + 1500) : "";
  const mgmt = parseFeeLi(mgmtBlock);
  const cust = parseFeeLi(custBlock);
  const mgmtValue = mgmt.computed?.value ?? mgmt.flat;
  const custValue = cust.flat; // 保管費在元大官網VERIFIED從未出現"約X%"算好值，只有flat或tiered
  const needsManualBlend = mgmt.tiered && mgmt.computed == null || cust.tiered;
  const total = mgmtValue != null && custValue != null ? Number((mgmtValue + custValue).toFixed(4)) : null;
  const distRaw = distMatch ? distMatch[1].trim() : null;
  return {
    managementFeePct: mgmtValue,
    custodyFeePct: custValue,
    totalExpenseRatioPct: total,
    asOfDate: mgmt.computed?.asOfDate ?? (total != null ? todayIso() : null),
    fetchDate: todayIso(),
    // 2026-11-01（使用者核准）: 官網「是」代表契約上可以配息，不代表實際配過息——之前這裡把
    // "是"丟回null，等於跟「根本沒查過這個欄位」無法區分，畫面只能顯示「—」。改存"UNSPECIFIED"
    // 這個專用標記，畫面層再去查有沒有真實配息紀錄，分別顯示「可配息但未曾配息」或實際殖利率。
    distributionFreq: distRaw === "否" ? "NONE" : distRaw === "是" ? "UNSPECIFIED" : null,
    needsManualBlend,
    rawFeeText: { management: mgmt.raw, custody: cust.raw },
    notFound: false,
  };
}

export async function readFubonFee(code: string): Promise<IssuerFeeResult> {
  const url = `https://websys.fsit.com.tw/FubonETF/Fund/Profile.aspx?stkId=${encodeURIComponent(code)}`;
  const html = await fetchHtml(url, "FUBON");
  if (!/經理費/.test(html)) {
    return { managementFeePct: null, custodyFeePct: null, totalExpenseRatioPct: null, asOfDate: null, fetchDate: todayIso(), distributionFreq: null, needsManualBlend: false, rawFeeText: { management: "", custody: "" }, notFound: true };
  }
  // 富邦官網結構：<p>經理費(年)</p>\n<p>0.99%</p> 或級距文字列在同一個<p>裡用換行/頓號分隔
  const mgmtMatch = html.match(/經理費\(年\)<\/p>\s*<p>([\s\S]*?)<\/p>/);
  const custMatch = html.match(/保管費\(年\)<\/p>\s*<p>([\s\S]*?)<\/p>/);
  const distMatch = html.match(/收益分配<\/p>\s*<p>([^<]*)<\/p>/) ?? html.match(/>收益分配<\/[a-z]+>\s*<[a-z]+>([^<]*)</);
  const parseOne = (raw: string | undefined) => {
    if (!raw) return { value: null as number | null, tiered: false, text: "" };
    const text = raw.replace(/<[^>]+>/g, " ").trim();
    const flatMatch = text.match(/^([\d.]+)%$/);
    if (flatMatch) return { value: Number(flatMatch[1]), tiered: false, text };
    return { value: null, tiered: true, text };
  };
  const mgmt = parseOne(mgmtMatch?.[1]);
  const cust = parseOne(custMatch?.[1]);
  const total = mgmt.value != null && cust.value != null ? Number((mgmt.value + cust.value).toFixed(4)) : null;
  const distRaw = distMatch ? distMatch[1].trim() : null;
  return {
    managementFeePct: mgmt.value,
    custodyFeePct: cust.value,
    totalExpenseRatioPct: total,
    asOfDate: total != null ? todayIso() : null, // 富邦官網沒有獨立標示費率資料日期，用擷取日
    fetchDate: todayIso(),
    distributionFreq: distRaw === "無" ? "NONE" : distRaw && distRaw !== "" ? distRaw : null,
    needsManualBlend: mgmt.tiered || cust.tiered,
    rawFeeText: { management: mgmt.text, custody: cust.text },
    notFound: false,
  };
}

// 2026-11-01（使用者核准，延伸至國泰/復華/群益）：
// 國泰 cwapi.cathaysite.com.tw/api/ETF/GetETFCharge?FundCode={internalCode} —— 這是
// www.cathaysite.com.tw 官網商品頁自己載入費率資料時呼叫的同一支公開JSON API（VERIFIED：在官網
// 商品頁用站內搜尋框查到00881/00878，由瀏覽器實際載入該頁時觀察到它呼叫這支API），回傳欄位本身
// 就是官網顯示的原文（flat或「基金規模X億以下：Y%；X億以上：Z%」這種級距文字），不是另一個資料源。
// internalCode對照表來自同一網域的 /api/Fund/GetFundList（公開、不需認證），一次取得全部ETF的
// 證券代碼<->internalCode對照與收益分配頻率(allotPeriod)，這就是「共用同一次讀取」。
//
// 復華 www.fhtrust.com.tw/api/fundList —— 官網「ETF總覽」頁本身載入時呼叫的公開JSON API，單一
// 請求回傳全部復華基金（含ETF）的經理費/保管費(ec012/ec013，可能是單一值或"X%~Y%"區間)、收益
// 分配頻率(disType)、證券代碼(etf002)，一次涵蓋費率+配息兩項，不需逐檔讀取。
//
// 群益 www.capitalfund.com.tw/CFWeb/api/etf/basic/{internalId}、/detail/{internalId} ——
// 官網ETF產品頁本身載入時呼叫的公開JSON API，{internalId}對照表VERIFIED取自官網「ETF總覽」頁
// (/etf/product/overview) 本身DOM中的商品連結(/etf/product/detail/{id}/basic)，不是猜測。
//
// 中信 ctbcinvestments.com.tw 的ETF商品頁是純前端渲染(無SSR內容)，其資料API
// (www.ctbcinvestments.com.tw/API/...) 要求先POST取得一次性AuthToken才能呼叫，VERIFIED
// 直接GET該token端點會被拒絕(「不支援的http方法」)。這屬於需要還原一套session/token機制才能
// 自動化的認證API，不是單純的「从菜单导览找到网址」，跟「429/403就停，不准繞過」的精神相牴觸，
// 這輪不實作中信，誠實列為未完成（不是忘記、不是繞過之後失敗）。

async function fetchJson<T>(url: string, issuer: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 403 || res.status === 429) throw new IssuerSiteRateLimitedError(issuer, res.status);
  if (!res.ok) throw new IssuerSiteRateLimitedError(issuer, res.status);
  return res.json() as Promise<T>;
}

function parsePctText(raw: string | null | undefined): { value: number | null; tiered: boolean; text: string } {
  if (!raw) return { value: null, tiered: false, text: "" };
  const text = raw.trim();
  const flatMatch = text.match(/^([\d.]+)\s*[%％]$/);
  if (flatMatch) return { value: Number(flatMatch[1]), tiered: false, text };
  return { value: null, tiered: true, text }; // 含"~"區間、或整段中文級距敘述，一律視為需要人工比對，不猜
}

let cathayFundListCache: { fetchedAt: number; byCode: Map<string, { internalCode: string; allotPeriod: string }> } | null = null;

async function getCathayFundList(): Promise<Map<string, { internalCode: string; allotPeriod: string }>> {
  if (cathayFundListCache && Date.now() - cathayFundListCache.fetchedAt < 10 * 60_000) return cathayFundListCache.byCode;
  const json = await fetchJson<{ result: Array<{ fundCode: string; stockCode: string; isETF: boolean; allotPeriod: string }> }>(
    "https://cwapi.cathaysite.com.tw/api/Fund/GetFundList?CurrentPage=1&PerPageCount=9999&status=1", "CATHAY",
  );
  const byCode = new Map<string, { internalCode: string; allotPeriod: string }>();
  for (const f of json.result) {
    if (f.isETF && f.stockCode) byCode.set(f.stockCode, { internalCode: f.fundCode, allotPeriod: f.allotPeriod });
  }
  cathayFundListCache = { fetchedAt: Date.now(), byCode };
  return byCode;
}

export async function readCathayFee(code: string): Promise<IssuerFeeResult> {
  const list = await getCathayFundList();
  const entry = list.get(code);
  if (!entry) {
    return { managementFeePct: null, custodyFeePct: null, totalExpenseRatioPct: null, asOfDate: null, fetchDate: todayIso(), distributionFreq: null, needsManualBlend: false, rawFeeText: { management: "", custody: "" }, notFound: true };
  }
  const json = await fetchJson<{ result: { managerCharge: string; storageCharge: string } }>(
    `https://cwapi.cathaysite.com.tw/api/ETF/GetETFCharge?FundCode=${encodeURIComponent(entry.internalCode)}&status=1`, "CATHAY",
  );
  const mgmt = parsePctText(json.result?.managerCharge);
  const cust = parsePctText(json.result?.storageCharge);
  const total = mgmt.value != null && cust.value != null ? Number((mgmt.value + cust.value).toFixed(4)) : null;
  return {
    managementFeePct: mgmt.value,
    custodyFeePct: cust.value,
    totalExpenseRatioPct: total,
    asOfDate: total != null ? todayIso() : null,
    fetchDate: todayIso(),
    distributionFreq: entry.allotPeriod === "不配息" ? "NONE" : entry.allotPeriod || null,
    needsManualBlend: mgmt.tiered || cust.tiered,
    rawFeeText: { management: mgmt.text, custody: cust.text },
    notFound: false,
  };
}

let fhtFundListCache: { fetchedAt: number; byCode: Map<string, { ec012: string; ec013: string; disType: string | null }> } | null = null;

async function getFhtFundList(): Promise<Map<string, { ec012: string; ec013: string; disType: string | null }>> {
  if (fhtFundListCache && Date.now() - fhtFundListCache.fetchedAt < 10 * 60_000) return fhtFundListCache.byCode;
  const json = await fetchJson<{ result: Array<{ etf002: string; ec012: string; ec013: string; disType: string | null }> }>(
    "https://www.fhtrust.com.tw/api/fundList", "FHT",
  );
  const byCode = new Map<string, { ec012: string; ec013: string; disType: string | null }>();
  for (const f of json.result) {
    if (f.etf002 && /^\d{4,6}[A-Z]?$/.test(f.etf002)) byCode.set(f.etf002, { ec012: f.ec012, ec013: f.ec013, disType: f.disType ?? null });
  }
  fhtFundListCache = { fetchedAt: Date.now(), byCode };
  return byCode;
}

export async function readFhtFee(code: string): Promise<IssuerFeeResult> {
  const list = await getFhtFundList();
  const entry = list.get(code);
  if (!entry) {
    return { managementFeePct: null, custodyFeePct: null, totalExpenseRatioPct: null, asOfDate: null, fetchDate: todayIso(), distributionFreq: null, needsManualBlend: false, rawFeeText: { management: "", custody: "" }, notFound: true };
  }
  const mgmt = parsePctText(entry.ec012);
  const cust = parsePctText(entry.ec013);
  const total = mgmt.value != null && cust.value != null ? Number((mgmt.value + cust.value).toFixed(4)) : null;
  return {
    managementFeePct: mgmt.value,
    custodyFeePct: cust.value,
    totalExpenseRatioPct: total,
    asOfDate: total != null ? todayIso() : null,
    fetchDate: todayIso(),
    distributionFreq: entry.disType ?? "NONE",
    needsManualBlend: mgmt.tiered || cust.tiered,
    rawFeeText: { management: mgmt.text, custody: cust.text },
    notFound: false,
  };
}

let capitalFundIdCache: { fetchedAt: number; byCode: Map<string, string> } | null = null;

async function getCapitalFundIds(): Promise<Map<string, string>> {
  if (capitalFundIdCache && Date.now() - capitalFundIdCache.fetchedAt < 10 * 60_000) return capitalFundIdCache.byCode;
  const html = await fetchHtml("https://www.capitalfund.com.tw/etf/product/overview", "CAPITAL");
  const byCode = new Map<string, string>();
  const linkRe = /\/etf\/product\/detail\/(\d+)\/basic[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([0-9]{4,6}[A-Z]?)/g;
  // 官網清單頁的卡片結構把代號放在連結內文字節點中，直接找「detail/{id}」與其後緊接著出現的代號；
  // 若未來改版導致抓不到，byCode會是空表、所有代碼回傳notFound，不會誤判。
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) byCode.set(m[2], m[1]);
  capitalFundIdCache = { fetchedAt: Date.now(), byCode };
  return byCode;
}

export async function readCapitalFee(code: string): Promise<IssuerFeeResult> {
  const ids = await getCapitalFundIds();
  const internalId = ids.get(code);
  if (!internalId) {
    return { managementFeePct: null, custodyFeePct: null, totalExpenseRatioPct: null, asOfDate: null, fetchDate: todayIso(), distributionFreq: null, needsManualBlend: false, rawFeeText: { management: "", custody: "" }, notFound: true };
  }
  const [basic, detail] = await Promise.all([
    fetchJson<{ data: { profitFrequency: string } }>(`https://www.capitalfund.com.tw/CFWeb/api/etf/basic/${internalId}`, "CAPITAL"),
    fetchJson<{ data: { manageCharge: string; storageCharge: string } }>(`https://www.capitalfund.com.tw/CFWeb/api/etf/detail/${internalId}`, "CAPITAL"),
  ]);
  const mgmt = parsePctText(detail.data?.manageCharge?.trim());
  const cust = parsePctText(detail.data?.storageCharge?.trim());
  const total = mgmt.value != null && cust.value != null ? Number((mgmt.value + cust.value).toFixed(4)) : null;
  const freq = basic.data?.profitFrequency?.trim();
  return {
    managementFeePct: mgmt.value,
    custodyFeePct: cust.value,
    totalExpenseRatioPct: total,
    asOfDate: total != null ? todayIso() : null,
    fetchDate: todayIso(),
    distributionFreq: !freq || freq === "不配息" ? "NONE" : freq,
    needsManualBlend: mgmt.tiered || cust.tiered,
    rawFeeText: { management: mgmt.text, custody: cust.text },
    notFound: false,
  };
}
