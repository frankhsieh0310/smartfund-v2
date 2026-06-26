// ============================================================
// lib/engines/holdingsEngine.ts
// SmartMatch Holdings Engine — 個股反查
// 輸入股票代碼，找出包含該股票的 ETF 與基金
// ============================================================

import { ETF_LIST, type Etf } from "@/lib/data/etfData";
import { FUND_LIST, type Fund } from "@/lib/data/fundData";

// ── 持股資料格式 ──────────────────────────────────────────────
export interface HoldingEntry {
  ticker:  string;  // 股票代碼，例如 "2330", "NVDA"
  name:    string;  // 股票名稱，例如 "台積電"
  weight?: number;  // 持股比重 %（可選）
}

export interface EtfHoldings {
  etfCode:   string;
  etfName:   string;
  holdings:  HoldingEntry[];
}

export interface FundHoldings {
  fundId:    string;
  fundName:  string;
  company:   string;
  holdings:  HoldingEntry[];
}

// ── 持股對照表（示意資料）────────────────────────────────────
// 正式版將接入 ETF 發行商公開持股 API
// 格式：etfCode → HoldingEntry[]
const ETF_HOLDINGS_MAP: Record<string, HoldingEntry[]> = {
  "0050":  [
    { ticker:"2330", name:"台積電",   weight:33.2 },
    { ticker:"2317", name:"鴻海",     weight:5.4  },
    { ticker:"2454", name:"聯發科",   weight:4.8  },
    { ticker:"2308", name:"台達電",   weight:3.2  },
    { ticker:"2382", name:"廣達",     weight:2.8  },
    { ticker:"3711", name:"日月光投控",weight:2.4 },
    { ticker:"2412", name:"中華電",   weight:2.1  },
    { ticker:"1303", name:"南亞",     weight:1.8  },
    { ticker:"2002", name:"中鋼",     weight:1.4  },
    { ticker:"2881", name:"富邦金",   weight:1.2  },
  ],
  "006208":[
    { ticker:"2330", name:"台積電",   weight:32.8 },
    { ticker:"2317", name:"鴻海",     weight:5.2  },
    { ticker:"2454", name:"聯發科",   weight:4.6  },
    { ticker:"2308", name:"台達電",   weight:3.0  },
    { ticker:"2382", name:"廣達",     weight:2.6  },
  ],
  "00878": [
    { ticker:"2330", name:"台積電",   weight:8.4  },
    { ticker:"2412", name:"中華電",   weight:6.2  },
    { ticker:"2882", name:"國泰金",   weight:5.8  },
    { ticker:"2886", name:"兆豐金",   weight:5.4  },
    { ticker:"2881", name:"富邦金",   weight:5.2  },
    { ticker:"2891", name:"中信金",   weight:4.8  },
    { ticker:"2884", name:"玉山金",   weight:4.4  },
    { ticker:"5880", name:"合庫金",   weight:4.2  },
  ],
  "00919": [
    { ticker:"2330", name:"台積電",   weight:9.8  },
    { ticker:"2317", name:"鴻海",     weight:6.4  },
    { ticker:"2382", name:"廣達",     weight:5.8  },
    { ticker:"2308", name:"台達電",   weight:5.2  },
    { ticker:"3711", name:"日月光投控",weight:4.6 },
  ],
  "QQQ":   [
    { ticker:"AAPL", name:"Apple",     weight:8.9 },
    { ticker:"MSFT", name:"Microsoft", weight:8.4 },
    { ticker:"NVDA", name:"NVIDIA",    weight:7.2 },
    { ticker:"AMZN", name:"Amazon",    weight:5.1 },
    { ticker:"META", name:"Meta",      weight:4.8 },
    { ticker:"GOOGL",name:"Alphabet",  weight:4.2 },
    { ticker:"TSMC", name:"台積電ADR", weight:2.8 },
    { ticker:"AVGO", name:"Broadcom",  weight:2.4 },
  ],
  "VOO":   [
    { ticker:"AAPL", name:"Apple",     weight:7.1 },
    { ticker:"MSFT", name:"Microsoft", weight:6.8 },
    { ticker:"NVDA", name:"NVIDIA",    weight:5.8 },
    { ticker:"AMZN", name:"Amazon",    weight:3.9 },
    { ticker:"META", name:"Meta",      weight:2.4 },
    { ticker:"GOOGL",name:"Alphabet",  weight:2.1 },
  ],
  "SOXX":  [
    { ticker:"NVDA", name:"NVIDIA",    weight:8.4 },
    { ticker:"AVGO", name:"Broadcom",  weight:8.1 },
    { ticker:"AMD",  name:"AMD",       weight:7.2 },
    { ticker:"TSMC", name:"台積電ADR", weight:6.8 },
    { ticker:"INTC", name:"Intel",     weight:5.4 },
  ],
  "SMH":   [
    { ticker:"NVDA", name:"NVIDIA",    weight:21.4 },
    { ticker:"TSMC", name:"台積電ADR", weight:14.2 },
    { ticker:"AVGO", name:"Broadcom",  weight:7.8  },
    { ticker:"AMD",  name:"AMD",       weight:5.4  },
  ],
};

// 基金持股對照表（示意）
const FUND_HOLDINGS_MAP: Record<string, HoldingEntry[]> = {
  "NOM-001": [
    { ticker:"AAPL", name:"Apple",   weight:4.2 },
    { ticker:"MSFT", name:"Microsoft",weight:3.8},
    { ticker:"NVDA", name:"NVIDIA",  weight:3.2 },
  ],
  "FTB-001": [
    { ticker:"2330", name:"台積電",  weight:12.4 },
    { ticker:"2317", name:"鴻海",    weight:6.8  },
    { ticker:"NVDA", name:"NVIDIA",  weight:5.2  },
  ],
  "ALZ-001": [
    { ticker:"2330", name:"台積電",  weight:18.4 },
    { ticker:"2454", name:"聯發科",  weight:8.2  },
    { ticker:"3711", name:"日月光",  weight:6.4  },
  ],
  "JPM-004": [
    { ticker:"AAPL", name:"Apple",   weight:8.4  },
    { ticker:"MSFT", name:"Microsoft",weight:7.8 },
    { ticker:"NVDA", name:"NVIDIA",  weight:6.4  },
    { ticker:"AMZN", name:"Amazon",  weight:5.2  },
  ],
};

// ── 正規化 ticker（大小寫/別名統一）─────────────────────────
function normalizeTicker(ticker: string): string[] {
  const t = ticker.toUpperCase().trim();
  const aliases: Record<string, string[]> = {
    "台積電": ["2330", "TSM", "TSMC"],
    "2330":   ["2330", "TSM", "TSMC", "台積電"],
    "TSM":    ["2330", "TSM", "TSMC", "台積電"],
    "TSMC":   ["2330", "TSM", "TSMC", "台積電"],
    "NVDA":   ["NVDA", "輝達"],
    "輝達":   ["NVDA", "輝達"],
    "NVIDIA": ["NVDA", "輝達"],
    "AAPL":   ["AAPL", "蘋果", "APPLE"],
    "蘋果":   ["AAPL", "蘋果"],
    "MSFT":   ["MSFT", "微軟"],
    "微軟":   ["MSFT", "微軟"],
  };
  return aliases[t] ?? aliases[ticker] ?? [t];
}

// ── 單一股票反查 ──────────────────────────────────────────────
export interface HoldingSearchResult {
  etfs:  Array<Etf & { holdingWeight?: number }>;
  funds: Array<Fund & { holdingWeight?: number }>;
}

export function findByHolding(ticker: string): HoldingSearchResult {
  const aliases = normalizeTicker(ticker);

  const matchedEtfs = ETF_LIST
    .filter(etf => {
      const holdings = ETF_HOLDINGS_MAP[etf.code] ?? [];
      return holdings.some(h =>
        aliases.some(a =>
          h.ticker.toUpperCase() === a ||
          h.name.includes(ticker)
        )
      );
    })
    .map(etf => {
      const holdings = ETF_HOLDINGS_MAP[etf.code] ?? [];
      const match = holdings.find(h =>
        aliases.some(a => h.ticker.toUpperCase() === a || h.name.includes(ticker))
      );
      return { ...etf, holdingWeight: match?.weight };
    })
    .sort((a, b) => (b.holdingWeight ?? 0) - (a.holdingWeight ?? 0));

  const matchedFunds = FUND_LIST
    .filter(fund => {
      const holdings = FUND_HOLDINGS_MAP[fund.id] ?? [];
      return holdings.some(h =>
        aliases.some(a =>
          h.ticker.toUpperCase() === a ||
          h.name.includes(ticker)
        )
      );
    })
    .map(fund => {
      const holdings = FUND_HOLDINGS_MAP[fund.id] ?? [];
      const match = holdings.find(h =>
        aliases.some(a => h.ticker.toUpperCase() === a || h.name.includes(ticker))
      );
      return { ...fund, holdingWeight: match?.weight };
    })
    .sort((a, b) => (b.holdingWeight ?? 0) - (a.holdingWeight ?? 0));

  return { etfs: matchedEtfs, funds: matchedFunds };
}

// ── 多股票交集反查 ────────────────────────────────────────────
export function findIntersection(tickers: string[]): HoldingSearchResult {
  if (tickers.length === 0) return { etfs: [], funds: [] };
  if (tickers.length === 1) return findByHolding(tickers[0]);

  // 每個 ticker 的結果集
  const etfSets = tickers.map(t => new Set(findByHolding(t).etfs.map(e => e.code)));
  const fundSets = tickers.map(t => new Set(findByHolding(t).funds.map(f => f.id)));

  // 取交集
  const etfIntersection = [...etfSets[0]].filter(code =>
    etfSets.every(s => s.has(code))
  );
  const fundIntersection = [...fundSets[0]].filter(id =>
    fundSets.every(s => s.has(id))
  );

  const etfs = ETF_LIST.filter(e => etfIntersection.includes(e.code));
  const funds = FUND_LIST.filter(f => fundIntersection.includes(f.id));

  return { etfs, funds };
}

// ── 支援的股票清單（給前端 autocomplete）────────────────────
export function getSupportedTickers(): { ticker: string; name: string }[] {
  const all = new Map<string, string>();
  Object.values(ETF_HOLDINGS_MAP).flat().forEach(h => all.set(h.ticker, h.name));
  Object.values(FUND_HOLDINGS_MAP).flat().forEach(h => all.set(h.ticker, h.name));
  return Array.from(all.entries()).map(([ticker, name]) => ({ ticker, name }));
}