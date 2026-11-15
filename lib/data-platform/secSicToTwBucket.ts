// 2026-11-12（使用者回報核實+核准定案，跨市場產業分類一致）: 台積電(2330)顯示「半導體業」，
// 輝達(NVDA)卻顯示「Information Technology」——VERIFIED根因是securities.sector對美股原本
// 存的是SEC SIC代碼逐碼翻成中文的獨立說明文字（見secSicTranslation.ts，例如SIC 3674→
// 「半導體及相關元件」），跟台股securities.sector直接存證交所/櫃買中心官方「產業別」原文
// （VERIFIED官方t187ap05_L/t187ap05_O資料集，固定收錄TWSE 33種、TPEx 28種中文類別名稱，
// 例如2330的「產業別」欄位本身就是「半導體業」）是兩套完全獨立的中文詞彙表，就算語意相近
// 字面也對不起來，portfolioLookThrough()的bucketBy()用字串完全比對分桶，當然被拆成兩類。
// （另外VERIFIED「Information Technology」這個英文字串根本不是SEC SIC翻譯表產出的——是
// secSicClassificationIngest.ts還沒處理到NVDA之前，securities.sector殘留的更早期來源值，
// 不是這份翻譯表的輸出，這份翻譯表本身一直都只輸出中文。）
//
// 這裡新增一層「SIC代碼→台股官方33類」對照（只在能找到合理對應的產業才對照過去；沒有台股
// 等效類別的純美股特有產業，例如礦業、農業、各種零售子類，繼續用secSicTranslation.ts既有的
// 逐碼中文說明，不勉強塞進台股33類、也不留英文)。對照只依照SIC代碼實際描述的產業內容判斷，
// 不是機器翻譯、不是字面相似度比對。
import { translateSicDescription } from "./secSicTranslation";

// TWSE t187ap05_L + TPEx t187ap05_O 官方「產業別」聯集（2026-11-12 VERIFIED 兩邊open data實測
// 取得，TWSE 33種/TPEx 28種，重疊的只列一次）。
export const TW_OFFICIAL_SECTOR_BUCKETS = [
  "水泥工業", "食品工業", "塑膠工業", "紡織纖維", "電機機械", "電器電纜", "化學工業", "生技醫療業",
  "玻璃陶瓷", "造紙工業", "鋼鐵工業", "橡膠工業", "汽車工業", "電子零組件業", "電子通路業", "資訊服務業",
  "其他電子業", "建材營造", "航運業", "觀光餐旅", "金融保險業", "金融業", "貿易百貨", "油電燃氣業",
  "綠能環保", "數位雲端", "運動休閒", "居家生活", "其他", "半導體業", "電腦及週邊設備業", "光電業",
  "通信網路業", "存託憑證", "農業科技", "文化創意業",
] as const;

type SicRule = { test: (code: number) => boolean; bucket: string };

// 規則依SIC代碼（4位數字）判斷，由上而下第一個符合的規則生效——越具體的例外（例如3674半導體）
// 要排在越前面，才不會被後面較寬的範圍規則（例如3670-3679電子零組件業）先攔截。
const RULES: SicRule[] = [
  // 具體例外（比所屬大範圍更精確），務必放在對應大範圍規則之前。
  { test: (c) => c === 3674, bucket: "半導體業" }, // 半導體及相關元件
  { test: (c) => c >= 3570 && c <= 3579, bucket: "電腦及週邊設備業" }, // 電腦及辦公設備
  { test: (c) => c >= 3661 && c <= 3669, bucket: "通信網路業" }, // 電話電報/廣播電視通訊設備
  { test: (c) => c === 3640, bucket: "電器電纜" }, // 電氣照明及配線設備
  { test: (c) => c >= 3611 && c <= 3621, bucket: "電機機械" }, // 變壓器/開關裝置/馬達發電機
  { test: (c) => c >= 3670 && c <= 3679, bucket: "電子零組件業" }, // 印刷電路板/連接器/其他電子零組件
  { test: (c) => c >= 3810 && c <= 3829, bucket: "其他電子業" }, // 量測/控制/導航儀器
  { test: (c) => c >= 3841 && c <= 3851, bucket: "生技醫療業" }, // 醫療器材/眼科用品
  { test: (c) => c === 3651 || c === 3652 || c === 3861 || (c >= 3690 && c <= 3695), bucket: "其他電子業" }, // 消費性視聽/攝影/其他電子
  { test: (c) => c >= 3711 && c <= 3716, bucket: "汽車工業" },
  { test: (c) => c >= 3211 && c <= 3231, bucket: "玻璃陶瓷" },
  { test: (c) => c === 3241, bucket: "水泥工業" },
  { test: (c) => (c >= 3250 && c <= 3272) || c === 3281 || c === 3290, bucket: "建材營造" },
  { test: (c) => (c >= 3310 && c <= 3390), bucket: "鋼鐵工業" }, // 含部分非鐵金屬，台股既有分類慣例也常併入鋼鐵工業
  { test: (c) => c === 3011 || c === 3021, bucket: "橡膠工業" },
  { test: (c) => c >= 3060 && c <= 3089, bucket: "塑膠工業" },
  { test: (c) => c >= 3510 && c <= 3590, bucket: "電機機械" }, // 工業機械設備
  { test: (c) => c >= 1520 && c <= 1731, bucket: "建材營造" },
  { test: (c) => c >= 6500 && c <= 6799, bucket: "建材營造" }, // 不動產開發/經營，台股慣例併入建材營造
  { test: (c) => c >= 2000 && c <= 2099, bucket: "食品工業" },
  { test: (c) => c >= 2200 && c <= 2399, bucket: "紡織纖維" },
  { test: (c) => c >= 2600 && c <= 2699, bucket: "造紙工業" },
  { test: (c) => c >= 2833 && c <= 2836, bucket: "生技醫療業" }, // 藥用化學品/藥品製劑/診斷試劑/生物製品——台股慣例歸生技醫療業，不是化學工業
  { test: (c) => c >= 2800 && c <= 2899, bucket: "化學工業" },
  { test: (c) => c === 2911 || (c >= 2950 && c <= 2999), bucket: "化學工業" }, // 石油煉製/相關製品
  { test: (c) => c >= 4400 && c <= 4522, bucket: "航運業" }, // 水運/空運
  { test: (c) => c === 4610 || (c >= 4700 && c <= 4731), bucket: "航運業" }, // 管線運輸/貨運承攬
  { test: (c) => c >= 4800 && c <= 4899, bucket: "通信網路業" },
  { test: (c) => c >= 4900 && c <= 4999, bucket: "油電燃氣業" },
  { test: (c) => c === 5810 || c === 5812 || c === 7000 || c === 7011, bucket: "觀光餐旅" }, // 必須排在5000-5999批發零售大範圍規則之前，否則會被攔截
  { test: (c) => c >= 5000 && c <= 5999, bucket: "貿易百貨" }, // 批發/零售
  { test: (c) => c >= 6021 && c <= 6411, bucket: "金融保險業" },
  { test: (c) => c >= 7370 && c <= 7379, bucket: "資訊服務業" }, // 電腦程式設計/套裝軟體/系統整合
  { test: (c) => c === 7948 || c === 7990 || c === 7997 || c === 3949, bucket: "運動休閒" },
  { test: (c) => c >= 8000 && c <= 8099, bucket: "生技醫療業" },
];

/** 把SIC代碼對照到台股官方33類其中一類；找不到合理對應就回null（呼叫端退回
 * secSicTranslation.ts既有的逐碼中文說明，不勉強塞、不留英文）。 */
export function sicCodeToTwBucket(sicCode: string | null | undefined): string | null {
  if (!sicCode) return null;
  const code = Number(sicCode);
  if (!Number.isFinite(code)) return null;
  for (const rule of RULES) {
    if (rule.test(code)) return rule.bucket;
  }
  return null;
}

/** 美股sector欄位最終要寫入的中文值：優先對照到台股同一套分類；沒有合理對應的產業，退回
 * 既有SIC逐碼中文翻譯（不是英文、也不是「未分類」）。 */
export function sicCodeToDisplaySector(sicCode: string | null | undefined): string | null {
  return sicCodeToTwBucket(sicCode) ?? translateSicDescription(sicCode);
}
