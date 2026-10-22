export type PersonDisplay = { title: string; name: string };
export const PEOPLE: Record<string, PersonDisplay> = {
  "Donald Trump": { title: "美國總統", name: "川普" }, "Jerome Powell": { title: "聯準會主席", name: "鮑爾" },
  "Scott Bessent": { title: "美國財政部長", name: "貝森特" }, "Howard Lutnick": { title: "美國商務部長", name: "盧特尼克" },
  "Jamieson Greer": { title: "美國貿易代表", name: "葛里爾" }, "John C. Williams": { title: "紐約聯準銀行總裁", name: "威廉斯" },
  "Christopher Waller": { title: "聯準會理事", name: "沃勒" }, "Michelle Bowman": { title: "聯準會理事", name: "鮑曼" },
  "Jensen Huang": { title: "輝達執行長", name: "黃仁勳" }, "Lisa Su": { title: "超微董事長暨執行長", name: "蘇姿丰" },
  "C.C. Wei": { title: "台積電董事長", name: "魏哲家" }, "Satya Nadella": { title: "微軟執行長", name: "納德拉" },
  "Sundar Pichai": { title: "Alphabet 執行長", name: "皮查伊" }, "Mark Zuckerberg": { title: "Meta 執行長", name: "祖克柏" },
  "Tim Cook": { title: "蘋果執行長", name: "庫克" }, "Andy Jassy": { title: "亞馬遜執行長", name: "賈西" },
  "Elon Musk": { title: "特斯拉執行長", name: "馬斯克" }, "Hock Tan": { title: "博通執行長", name: "陳福陽" },
  "Lip-Bu Tan": { title: "英特爾執行長", name: "陳立武" }, "Cristiano Amon": { title: "高通執行長", name: "阿蒙" },
  "Jamie Dimon": { title: "摩根大通執行長", name: "戴蒙" }, "Larry Fink": { title: "貝萊德董事長", name: "芬克" },
  "Warren Buffett": { title: "波克夏董事長", name: "巴菲特" }, "Bill Ackman": { title: "潘興廣場資本創辦人", name: "艾克曼" },
  "Ray Dalio": { title: "橋水基金創辦人", name: "達利歐" }, "Cathie Wood": { title: "方舟投資執行長", name: "伍德" },
  "Howard Marks": { title: "橡樹資本共同創辦人", name: "馬克斯" },
};
const ORGANIZATIONS: Record<string, string> = { "Federal Reserve": "美國聯準會", "United States Government": "美國政府", "Berkshire Hathaway": "波克夏海瑟威", NVIDIA: "輝達", Alphabet: "Alphabet", "The White House": "白宮", "White House": "白宮" };
const INDUSTRIES: Record<string, string> = { Semiconductors: "半導體", "Interactive Media & Services": "互動媒體與服務", Technology: "科技", Financials: "金融", Energy: "能源", Industrials: "工業", Healthcare: "醫療保健", "Consumer Discretionary": "非必需消費", "Consumer Staples": "民生消費", Communication: "通訊服務", Utilities: "公用事業", "Real Estate": "不動產", Materials: "原物料", Automotive: "汽車" };
export const COMPANIES: Record<string, string> = {
  NVDA: "輝達", GOOGL: "Alphabet（Google 母公司）", GOOG: "Alphabet（Google 母公司）", MSFT: "微軟",
  AAPL: "蘋果", AMZN: "亞馬遜", META: "Meta（臉書母公司）", TSM: "台積電", "2330": "台積電",
  AMD: "超微", AVGO: "博通", MU: "美光", INTC: "英特爾", QCOM: "高通", TSLA: "特斯拉",
  JPM: "摩根大通", "BRK.B": "波克夏", "BRK-B": "波克夏", "BRK.A": "波克夏", BLK: "貝萊德",
  GS: "高盛", MS: "摩根士丹利", BAC: "美國銀行", C: "花旗集團", WFC: "富國銀行",
  XOM: "埃克森美孚", CVX: "雪佛龍", OXY: "西方石油", COP: "康菲石油",
  GM: "通用汽車", F: "福特汽車", WMT: "沃爾瑪", KO: "可口可樂", AXP: "美國運通", BX: "黑石集團",
};
export function personDisplayZh(person: string | null | undefined): string { const p = PEOPLE[person?.trim() ?? ""]; return p ? `${p.title} ${p.name}` : "公開人物"; }
export function personShortNameZh(person: string | null | undefined): string { return PEOPLE[person?.trim() ?? ""]?.name ?? "公開人物"; }
export function organizationDisplayZh(value: string | null | undefined): string | null { if (!value) return null; return ORGANIZATIONS[value.trim()] ?? (/\p{Script=Han}/u.test(value) ? value : null); }
export function industryDisplayZh(value: string | null | undefined): string { if (!value) return "產業未分類"; return INDUSTRIES[value.trim()] ?? (/\p{Script=Han}/u.test(value) ? value : "其他產業"); }
export function companyDisplayZh(symbol: string | null | undefined, value?: string | null): string {
  const ticker = symbol?.trim().toUpperCase() ?? "";
  if (COMPANIES[ticker]) return COMPANIES[ticker];
  if (value && /\p{Script=Han}/u.test(value)) return value;
  return ticker;
}
export function sourceDisplayZh(url: string | null | undefined, title?: string | null): string { let host = ""; try { host = new URL(url ?? "").hostname.replace(/^www\./, "").toLowerCase(); } catch {} const hay = `${host} ${title ?? ""}`.toLowerCase(); if (hay.includes("whitehouse.gov") || hay.includes("white house")) return "白宮"; if (hay.includes("federalreserve.gov") || hay.includes("federal reserve")) return "美國聯準會"; if (hay.includes("nvidia.com") || hay.includes("nvidia")) return "輝達"; if (hay.includes("cnbc")) return "CNBC"; if (hay.includes("udn.com") || hay.includes("經濟日報")) return "經濟日報"; if (hay.includes("wallstreetcn")) return "華爾街見聞"; if (hay.includes("reuters")) return "路透社"; if (hay.includes("sec.gov")) return "美國證券交易委員會"; return "公開來源"; }
