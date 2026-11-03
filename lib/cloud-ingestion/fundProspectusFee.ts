// 境內基金公開說明書「經理費率／保管費率」原文擷取（2026-11-03使用者核准，野村投信試點）。
//
// 來源：公開資訊觀測站(mops.twse.com.tw) → 基金公開說明書查詢（發行公司代號查詢），VERIFIED
// 用POST真正的查詢表單（不是猜網址）得到 doc.twse.com.tw 的檔案清單，每筆是一個PDF檔名；
// 用readfile2()同一套POST流程換到帶時間戳記的真正下載連結，下載後用pdfjs-dist讀純文字，
// 正則擷取「項 目 計 算 方 式 或 金 額」表格附近「經理費」「保管費」兩段原文——照抄，不計算、
// 不四捨五入、不轉成單一數字（多級距費率會整段保留）。
//
// 已VERIFIED 5檔（野村鴻運/中小/高科技/平衡/貨幣市場）格式一致可解析，但不同投信的公開說明書
// 格式差異很大，這個正則目前只保證對野村投信（E開頭檔名、「項 目 計 算 方 式 或 金 額」固定
// 表頭）有效，延伸到其他投信前需要重新核對格式。

export type ProspectusFeeResult = {
  mgmtFeeText: string;
  custodianFeeText: string;
  inceptionDate: string | null; // YYYY-MM-DD
  sourceUrl: string;
  filedAt: string | null; // 公開說明書刊印日期 YYYY-MM-DD，擷取不到就null
};

// 2026-11-03：手動核對過的5檔試點（dry-run驗證格式正確），自動清單解析見listNomuraFilings()。
export const NOMURA_PROSPECTUS_FILENAME: Record<string, string> = {
  "野村鴻運基金": "202512_A00032_E20_4.pdf",
  "野村中小基金": "202509_A00032_E08_4.pdf",
  "野村高科技基金": "202509_A00032_E29_4.pdf",
  "野村平衡基金": "202512_A00032_E05_4.pdf",
  "野村貨幣市場基金": "202512_A00032_E26_4.pdf",
};

export type NomuraFilingRow = { fundName: string; yearMonth: string; filename: string };

// 自動解析MOPS「基金公開說明書」清單頁（co_id=A00032=野村投信），回傳每檔基金最新一期的
// 公開說明書檔名。用POST查詢表單（跟readfile2()同一套流程，不是猜網址）換到doc.twse.com.tw的
// 清單頁，用big5解碼（VERIFIED：原始頁面是big5編碼，直接用UTF-8讀會整頁亂碼）後解析<tr><td>
// 表格列。查114+115兩個年度（ROC年度切換期間新舊兩年都可能有最新一期），同一檔基金取年月最大
// 的那筆。
export async function listNomuraFilings(): Promise<Map<string, NomuraFilingRow>> {
  async function fetchYear(year: string): Promise<NomuraFilingRow[]> {
    const params1 = new URLSearchParams({
      step: "1", firstin: "1", off: "1", pathname: "/mops/web/t57sb01_q7", TYPEK: "all",
      CK: "2", co_id: "A00032", year,
    });
    const res1 = await fetch("https://mopsov.twse.com.tw/mops/web/ajax_t57sb01_q7", {
      method: "POST", body: params1, headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const text1 = await res1.text();
    const m = text1.match(/window\.open\('([^']+)'/);
    if (!m) return [];
    const res2 = await fetch(m[1]);
    const buf = await res2.arrayBuffer();
    const html = new TextDecoder("big5").decode(buf);
    const rows: NomuraFilingRow[] = [];
    const trRe = /<tr>([\s\S]*?)<\/tr>/g;
    let tm: RegExpExecArray | null;
    while ((tm = trRe.exec(html))) {
      const tds = [...tm[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1].replace(/&nbsp;/g, "").trim());
      if (tds.length < 11) continue;
      const fundName = tds[4];
      const yearMonth = tds[5];
      const reportType = tds[6];
      const filenameMatch = tds[10].match(/>([^<]+\.pdf)</);
      if (!fundName || !filenameMatch || reportType !== "基金公開說明書") continue;
      rows.push({ fundName, yearMonth, filename: filenameMatch[1] });
    }
    return rows;
  }

  function yearMonthKey(ym: string): number {
    const m = ym.match(/(\d+)\s*年\s*(\d+)月/);
    return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
  }

  const all = [...(await fetchYear("114")), ...(await fetchYear("115"))];
  const latestByFund = new Map<string, NomuraFilingRow & { key: number }>();
  for (const r of all) {
    const key = yearMonthKey(r.yearMonth);
    const existing = latestByFund.get(r.fundName);
    if (!existing || key > existing.key) latestByFund.set(r.fundName, { ...r, key });
  }
  const result = new Map<string, NomuraFilingRow>();
  for (const [name, row] of latestByFund) result.set(name, { fundName: row.fundName, yearMonth: row.yearMonth, filename: row.filename });
  return result;
}

async function resolveDownloadUrl(filename: string): Promise<string> {
  // 走跟列表頁同一套readfile2() POST流程換出帶時間戳的真正下載連結。
  const params = new URLSearchParams({ colorchg: "1", step: "9", kind: "E", co_id: "A00032", filename });
  const res = await fetch("https://doc.twse.com.tw/server-java/t57sb01", { method: "POST", body: params, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  const text = await res.text();
  const m = text.match(/href='([^']+\.pdf)'/);
  if (!m) throw new Error(`MOPS_DOWNLOAD_URL_NOT_FOUND:${filename}`);
  return `https://doc.twse.com.tw${m[1]}`;
}

function rocToIso(roc: string): string | null {
  // "77年2月3日" / "90年4月11日" 這種格式 -> ISO
  const m = roc.match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const year = Number(m[1]) + 1911;
  return `${year}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

export async function extractNomuraProspectusFee(filename: string, fundNameForLog: string): Promise<ProspectusFeeResult> {
  const pdfUrl = await resolveDownloadUrl(filename);
  const res = await fetch(pdfUrl);
  const buf = new Uint8Array(await res.arrayBuffer());
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;

  // 2026-11-03 VERIFIED：每頁文字之間插入一個換行，不然表格剛好跨頁時，上一頁結尾文字會直接
  // 黏到下一頁開頭的頁首文字（例如"...超過部份之野村投信 | 野村鴻運證券投資信託基金 15項目
  // 計算方式或金額經理費按..."），把頁首/頁尾雜訊混進擷取的費率原文。
  let fullText = "";
  for (let p = 1; p <= Math.min(30, doc.numPages); p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    fullText += "\n" + content.items.map((i: any) => i.str).join("") + "\n";
  }
  // 每頁頁首都是"野村投信 | <基金全名> <頁碼>"或"<頁碼> <基金全名>| 野村投信"，夾在換頁處會
  // 污染正好跨頁的費率段落，統一清掉。
  fullText = fullText.replace(/野村投信\s*\|\s*[^\n]*?證券投資信託基金\s*\d+/g, "\n").replace(/\d+\s*[^\n]*?證券投資信託基金\s*\|\s*野村投信/g, "\n");

  const inceptionMatch = fullText.match(/本基金成立日為(\d{2,3}年\d{1,2}月\d{1,2}日)/);
  const inceptionDate = inceptionMatch ? rocToIso(inceptionMatch[1]) : null;

  const filedMatch = fullText.match(/刊\s*印\s*日\s*期\s*：\s*(\d{2,3})年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const filedAt = filedMatch ? `${Number(filedMatch[1]) + 1911}-${String(filedMatch[2]).padStart(2, "0")}-${String(filedMatch[3]).padStart(2, "0")}` : null;

  // 格式A（多數股權/一般債券型基金）：「項 目 計 算 方 式 或 金 額」表格之後，「經理費」到
  // 「保管費」之間是經理費原文；「保管費」到下一個欄位名稱（申購手續費/買回費用/買回收件手續費）
  // 之間是保管費原文。
  // 2026-11-03 VERIFIED：不同PDF這個表頭的字間距不一致（有的是"計算方式或金額"緊連，有的是
  // "項 目 計 算 方 式 或 金 額"逐字空格），直接比對原字串會漏——用去空白後的版本找位置，
  // 再換算回原始字串的對應索引。
  function tryFormatA(): { mgmtFeeText: string; custodianFeeText: string } | null {
    const compact = fullText.replace(/\s+/g, "");
    const compactIdx = compact.indexOf("計算方式或金額");
    if (compactIdx < 0) return null;
    let nonWsCount = 0, tableIdx = -1;
    for (let i = 0; i < fullText.length; i++) {
      if (!/\s/.test(fullText[i])) {
        if (nonWsCount === compactIdx) { tableIdx = i; break; }
        nonWsCount++;
      }
    }
    if (tableIdx < 0) return null;
    const scope = fullText.slice(tableIdx, tableIdx + 4000);
    const mgmtIdx = scope.indexOf("經理費");
    const custodianIdx = scope.indexOf("保管費", mgmtIdx + 1);
    const nextSectionMatch = scope.slice(custodianIdx + 3).match(/申購手續費|買回費用|買回收件手續費/);
    if (mgmtIdx < 0 || custodianIdx < 0 || !nextSectionMatch) return null;
    // 表格跨頁時，PDF會在新頁重複一次「項目 計算方式或金額」這個表頭列，混進費率原文中間——
    // 跟上面找表格起點用的是同一個字串，這裡原樣清掉（含有無字間空白的兩種寫法）。
    const stripRepeatedHeader = (s: string) => s.replace(/\n*項\s*目\s*計\s*算\s*方\s*式\s*或\s*金\s*額\n*/g, "");
    return {
      mgmtFeeText: stripRepeatedHeader(scope.slice(mgmtIdx + "經理費".length, custodianIdx)).trim(),
      custodianFeeText: stripRepeatedHeader(scope.slice(custodianIdx + "保管費".length, custodianIdx + 3 + nextSectionMatch.index!)).trim(),
    };
  }

  // 格式B（2026-11-04新增，貨幣市場基金／部分債券基金沒有「項目/計算方式或金額」格線表，改用
  // 信託契約條款編號條列：「(二十三)經理費」「(二十四)保管費」這種中文數字編號標題，內容是整段
  // 條款原文，不是表格列——VERIFIED「野村精選貨幣市場基金」「野村亞太複合非投資等級債券基金」
  // 都是這種排版，格式A的「計算方式或金額」anchor在這兩份PDF裡根本不存在（貨幣市場基金的
  // 「計算方式或金額」出現在同文件後段一張無關的表格，不是費率表）。經理費段落取自條款標題到
  // 下一個「(保管費)」標題之間；保管費段落取自其標題到下一個「(中文數字)」編號標題之間（下一條
  // 條款，不限定是哪一條）。
  function tryFormatB(): { mgmtFeeText: string; custodianFeeText: string } | null {
    // 2026-11-04 VERIFIED：有些PDF在編號括號跟標題文字之間多一個空白(例如"(二十三) 經理費")，
    // 用\s*容許中間的空白、不要求緊連。
    const headingRe = /[（(][一二三四五六七八九十廿百]+[）)]\s*/g;
    const mgmtHeadingMatch = fullText.match(/[（(][一二三四五六七八九十廿百]+[）)]\s*經理費/);
    const custHeadingMatch = fullText.match(/[（(][一二三四五六七八九十廿百]+[）)]\s*保管費/);
    if (!mgmtHeadingMatch || !custHeadingMatch) return null;
    const mgmtStart = mgmtHeadingMatch.index! + mgmtHeadingMatch[0].length;
    const custHeadingStart = custHeadingMatch.index!;
    if (custHeadingStart <= mgmtStart) return null;
    const mgmtFeeText = fullText.slice(mgmtStart, custHeadingStart).trim();
    const custStart = custHeadingStart + custHeadingMatch[0].length;
    headingRe.lastIndex = custStart;
    const nextHeadingMatch = headingRe.exec(fullText);
    const custEnd = nextHeadingMatch ? nextHeadingMatch.index : custStart + 2000;
    const custodianFeeText = fullText.slice(custStart, custEnd).trim();
    if (!mgmtFeeText || !custodianFeeText) return null;
    return { mgmtFeeText, custodianFeeText };
  }

  const fees = tryFormatA() ?? tryFormatB();
  if (!fees) throw new Error(`NOMURA_FEE_SECTIONS_NOT_FOUND:${fundNameForLog}`);

  return { mgmtFeeText: fees.mgmtFeeText, custodianFeeText: fees.custodianFeeText, inceptionDate, sourceUrl: pdfUrl, filedAt };
}
