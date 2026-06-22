"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ETF_LIST } from "../etf/data";
import { FUND_LIST, type Fund } from "../funds/data";
import type { Etf } from "../etf/data";

// ---- unified item type ----
type Item = {
  code: string;
  name: string;
  company?: string;
  type: "ETF" | "基金";
  category: string;
  region: string;
  expenseRatio: number;
  dividendYield: number;
  aum: number;
  return1y: number;
  return3y?: number;
  return5y?: number;
  volatility?: number;
  sharpe?: number;
  currency?: string;
};

function etfToItem(e: Etf): Item {
  return {
    code: e.code,
    name: e.name,
    type: "ETF",
    category: e.sector,
    region: e.region,
    expenseRatio: e.expenseRatio,
    dividendYield: e.dividendYield,
    aum: e.aum,
    return1y: e.return1y,
    currency: "USD",
  };
}

function fundToItem(f: Fund): Item {
  return {
    code: f.id,
    name: f.name,
    company: f.company,
    type: "基金",
    category: f.category,
    region: f.region,
    expenseRatio: f.expenseRatio,
    dividendYield: f.dividendYield,
    aum: f.aum,
    return1y: f.return1y,
    return3y: f.return3y,
    return5y: f.return5y,
    volatility: f.volatility,
    sharpe: f.sharpe,
    currency: f.currency,
  };
}

const ALL_ITEMS: Item[] = [
  ...ETF_LIST.map(etfToItem),
  ...FUND_LIST.map(fundToItem),
];

const LINE_COLORS = [
  "#F5B700", "#0B1220", "#3b82f6", "#16a34a",
  "#dc2626", "#9333ea", "#ea580c", "#0891b2",
  "#65a30d", "#db2777",
];

type Period = "1Y" | "3Y" | "5Y";

function seededRandom(seed: string, index: number): number {
  let hash = 0;
  const str = `${seed}-${index}`;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) % 1000) / 1000;
}

function generateTrend(item: Item, period: Period): number[] {
  const points = period === "1Y" ? 12 : period === "3Y" ? 18 : 20;
  const multiplier = period === "1Y" ? 1 : period === "3Y" ? (item.return3y ? (item.return3y / item.return1y) * 3 : 2.4) : (item.return5y ? (item.return5y / item.return1y) * 5 : 3.6);
  const totalReturn = (item.return1y / 100) * multiplier;
  const start = 100;
  const end = start * (1 + totalReturn);
  const result: number[] = [];
  for (let i = 0; i < points; i++) {
    const progress = i / (points - 1);
    const base = start + (end - start) * progress;
    const noise = (seededRandom(item.code, i) - 0.5) * Math.abs(end - start) * 0.18;
    result.push(Math.round((base + noise) * 100) / 100);
  }
  result[0] = 100;
  result[result.length - 1] = Math.round(end * 100) / 100;
  return result;
}

const MAX = 10;

export default function ComparePage() {
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<Item[]>([]);
  const [period, setPeriod] = useState<Period>("1Y");
  const [showDropdown, setShowDropdown] = useState(false);

  const suggestions = useMemo(() => {
    if (!keyword.trim()) return [];
    const kw = keyword.trim().toLowerCase();
    return ALL_ITEMS
      .filter(
        (i) =>
          !selected.find((s) => s.code === i.code) &&
          (i.code.toLowerCase().includes(kw) ||
           i.name.toLowerCase().includes(kw) ||
           (i.company && i.company.toLowerCase().includes(kw)))
      )
      .slice(0, 10);
  }, [keyword, selected]);

  function addItem(item: Item) {
    if (selected.length >= MAX) return;
    setSelected((prev) => [...prev, item]);
    setKeyword("");
    setShowDropdown(false);
  }

  function removeItem(code: string) {
    setSelected((prev) => prev.filter((i) => i.code !== code));
  }

  return (
    <main className="min-h-screen bg-[#0a0f1e] px-6 pt-32 pb-20">

      {/* DARK NAVBAR */}
      <nav className="fixed top-0 left-0 w-full z-50 bg-[#0a0f1e]/90 backdrop-blur-xl border-b border-white/10">
        <div className="max-w-[1700px] mx-auto h-20 px-10 flex items-center justify-between">
          <a href="/">
            <div className="text-[28px] font-black text-white leading-none">Smart<span className="text-[#F5B700]">Match</span></div>
            <div className="text-[11px] text-slate-400 mt-0.5">ETF & 基金資產配置分析平台</div>
          </a>
          <div className="hidden lg:flex gap-7 text-[14px] font-semibold text-slate-300">
            <a href="/quiz" className="hover:text-white transition-colors">投資人格分析</a>
            <a href="/etf" className="hover:text-white transition-colors">ETF篩選器</a>
            <a href="/funds" className="hover:text-white transition-colors">基金篩選器</a>
            <a href="/compare" className="hover:text-white transition-colors">比較中心</a>
            <a href="/clients" className="hover:text-white transition-colors">客戶管理</a>
            <a href="/pricing" className="text-[#F5B700] hover:text-[#e0a800] transition-colors">方案</a>
          </div>
          <div className="flex items-center gap-3">
            <a href="#" className="text-[14px] font-semibold text-slate-300 border border-white/30 px-4 py-2 rounded-lg hover:bg-white/10 transition-colors">登入</a>
            <a href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-5 py-2 rounded-lg font-bold text-[14px] transition-colors">免費註冊</a>
          </div>
        </div>
      </nav>

      <div className="max-w-[1280px] mx-auto">

        {/* HEADER */}
        <div className="mb-10">
          <div className="tracking-[10px] text-[#F5B700] text-[16px] font-semibold mb-4">
            SMARTMATCH
          </div>
          <h1 className="text-[44px] font-black text-white">
            ETF ＋ 基金比較中心
          </h1>
          <p className="text-[16px] text-slate-400 mt-2">
            同時比較 ETF 與基金，最多 {MAX} 檔
          </p>
        </div>

        {/* SEARCH BOX */}
        <div className="relative mb-8">
          <div className="flex gap-3 items-center">
            <div className="relative flex-1 max-w-[480px]">
              <input
                type="text"
                value={keyword}
                onChange={(e) => { setKeyword(e.target.value); setShowDropdown(true); }}
                onFocus={() => setShowDropdown(true)}
                onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                placeholder="搜尋代碼或名稱，例如 QQQ、霸菱、聯博…"
                className="w-full border border-white/20 rounded-xl px-5 py-3.5 text-[16px] text-white placeholder:text-slate-500 focus:outline-none focus:border-[#F5B700]"
                disabled={selected.length >= MAX}
              />
              {showDropdown && suggestions.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-white/10 rounded-xl shadow-xl z-50 overflow-hidden">
                  {suggestions.map((item) => (
                    <button
                      key={item.code}
                      onMouseDown={() => addItem(item)}
                      className="w-full text-left px-5 py-3 hover:bg-[#F5B700]/10 transition-colors flex items-center gap-3"
                    >
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${item.type === "ETF" ? "bg-white/[0.08] text-white" : "bg-blue-100 text-blue-700"}`}>
                        {item.type}
                      </span>
                      {item.type === "ETF" ? (
                        <>
                          <span className="font-bold text-white text-[15px]">{item.code}</span>
                          <span className="text-slate-400 text-[14px] truncate">{item.name}</span>
                        </>
                      ) : (
                        <>
                          <span className="font-bold text-white text-[15px]">{item.company}</span>
                          <span className="text-slate-400 text-[14px] truncate">{item.name}</span>
                        </>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="text-[14px] text-slate-400">
              已選 {selected.length} / {MAX} 檔
            </div>
          </div>
        </div>

        {/* SELECTED TAGS */}
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-8">
            {selected.map((item, i) => (
              <div
                key={item.code}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full border text-[14px] font-semibold"
                style={{ borderColor: LINE_COLORS[i], color: LINE_COLORS[i] }}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: LINE_COLORS[i] }}
                />
                {item.type === "ETF" ? item.code : (item.company || item.code)}
                <span className="text-[12px] font-normal opacity-70 max-w-[120px] truncate">
                  {item.type === "基金" ? item.name : ""}
                </span>
                <button
                  onClick={() => removeItem(item.code)}
                  className="ml-1 opacity-60 hover:opacity-100 transition-opacity"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              onClick={() => setSelected([])}
              className="px-3 py-1.5 rounded-full border border-white/20 text-slate-400 text-[14px] hover:border-red-300 hover:text-red-400 transition-colors"
            >
              清除全部
            </button>
          </div>
        )}

        {selected.length === 0 ? (
          <div className="border border-white/10 rounded-2xl flex items-center justify-center h-[320px] text-slate-400 text-[16px] flex-col gap-3">
            <div className="text-[40px]">↑</div>
            <div>在上方搜尋框輸入代碼或名稱，加入要比較的商品</div>
            <div className="text-[14px] text-slate-300">可同時比較 ETF 與基金</div>
          </div>
        ) : (
          <>
            {/* COMPARISON TABLE */}
            <div className="border border-white/10 rounded-2xl overflow-hidden mb-8">
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="bg-white/[0.08] text-white text-[14px]">
                      <th className="px-5 py-4 font-semibold sticky left-0 bg-[#0B1220] z-10 min-w-[140px]">項目</th>
                      {selected.map((item, i) => (
                        <th key={item.code} className="px-5 py-4 font-semibold min-w-[160px]">
                          <div className="flex items-center gap-2">
                            <span
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: LINE_COLORS[i] }}
                            />
                            <span>{item.code}</span>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <CompareRow label="類型" values={selected.map((i) => (
                      <span className={`text-[12px] font-bold px-2 py-0.5 rounded-full ${i.type === "ETF" ? "bg-white/[0.08] text-white" : "bg-blue-100 text-blue-700"}`}>
                        {i.type}
                      </span>
                    ))} />
                    <CompareRow label="名稱" values={selected.map((i) => <span className="text-[13px]">{i.name}</span>)} highlight />
                    <CompareRow label="地區" values={selected.map((i) => i.region)} />
                    <CompareRow label="類別" values={selected.map((i) => i.category)} highlight />
                    <CompareRow
                      label="費用率"
                      values={selected.map((i) => `${i.expenseRatio.toFixed(2)}%`)}
                      best={findBest(selected.map((i) => i.expenseRatio), "low")}
                    />
                    <CompareRow
                      label="殖利率 / 配息率"
                      values={selected.map((i) => `${i.dividendYield.toFixed(1)}%`)}
                      best={findBest(selected.map((i) => i.dividendYield), "high")}
                      highlight
                    />
                    <CompareRow
                      label="規模"
                      values={selected.map((i) => `${i.aum.toLocaleString()} ${i.currency === "USD" && i.type === "基金" ? "億台幣" : "億美元"}`)}
                    />
                    <CompareRow
                      label="近一年報酬"
                      values={selected.map((i) => (
                        <span className={i.return1y >= 0 ? "text-green-600 font-semibold" : "text-red-500 font-semibold"}>
                          {i.return1y >= 0 ? "+" : ""}{i.return1y.toFixed(1)}%
                        </span>
                      ))}
                      best={findBest(selected.map((i) => i.return1y), "high")}
                      highlight
                    />
                    <CompareRow
                      label="近三年報酬"
                      values={selected.map((i) => i.return3y !== undefined ? (
                        <span className={i.return3y >= 0 ? "text-green-600 font-semibold" : "text-red-500 font-semibold"}>
                          {i.return3y >= 0 ? "+" : ""}{i.return3y.toFixed(1)}%
                        </span>
                      ) : <span className="text-slate-300">—</span>)}
                    />
                    <CompareRow
                      label="近五年報酬"
                      values={selected.map((i) => i.return5y !== undefined ? (
                        <span className={i.return5y >= 0 ? "text-green-600 font-semibold" : "text-red-500 font-semibold"}>
                          {i.return5y >= 0 ? "+" : ""}{i.return5y.toFixed(1)}%
                        </span>
                      ) : <span className="text-slate-300">—</span>)}
                      highlight
                    />
                    <CompareRow
                      label="年化波動度"
                      values={selected.map((i) => i.volatility !== undefined ? `${i.volatility.toFixed(1)}%` : <span className="text-slate-300">—</span>)}
                      best={findBest(selected.map((i) => i.volatility ?? Infinity), "low")}
                    />
                    <CompareRow
                      label="夏普值"
                      values={selected.map((i) => i.sharpe !== undefined ? i.sharpe.toFixed(2) : <span className="text-slate-300">—</span>)}
                      best={findBest(selected.map((i) => i.sharpe ?? -Infinity), "high")}
                      highlight
                    />
                  </tbody>
                </table>
              </div>
            </div>

            {/* TREND CHART */}
            <div className="border border-white/10 rounded-2xl p-8">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                <div className="text-[22px] font-bold text-white">
                  走勢比較（指數化，起點=100）
                </div>
                <div className="flex gap-2">
                  {(["1Y", "3Y", "5Y"] as Period[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => setPeriod(p)}
                      className={`px-4 py-2 rounded-lg text-[14px] font-semibold transition-colors ${period === p ? "bg-[#F5B700] text-white" : "bg-white border border-white/20 text-slate-400 hover:border-[#F5B700]"}`}
                    >
                      {p === "1Y" ? "1年" : p === "3Y" ? "3年" : "5年"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap gap-4 mb-4">
                {selected.map((item, i) => (
                  <div key={item.code} className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full" style={{ backgroundColor: LINE_COLORS[i] }} />
                    <span className="text-[14px] font-semibold text-white">{item.code}</span>
                    <span className="text-[13px] text-slate-400">{item.type}</span>
                  </div>
                ))}
              </div>

              <TrendChart items={selected} period={period} />

              <p className="text-[13px] text-slate-400 mt-4">
                走勢為示意模擬曲線（起點皆為100），非真實逐日歷史價格，僅供功能展示參考。
              </p>
            </div>
          </>
        )}

        <p className="text-[13px] text-slate-400 mt-8 leading-relaxed text-center">
          以上資料為示意範例，非即時市場數據。本頁內容為資料分析結果，不構成投資建議。
        </p>

        <div className="flex justify-center mt-10 gap-4">
          <Link href="/etf" className="border border-white/20 text-white px-8 py-3.5 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[16px]">
            ETF 資料庫
          </Link>
          <Link href="/" className="border border-white/20 text-white px-8 py-3.5 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[16px]">
            回到首頁
          </Link>
        </div>

      </div>
    </main>
  );
}

// ---- helpers ----

function findBest(values: number[], mode: "high" | "low"): number {
  const valid = values.filter((v) => v !== Infinity && v !== -Infinity);
  if (valid.length === 0) return -1;
  const target = mode === "high" ? Math.max(...valid) : Math.min(...valid);
  return values.indexOf(target);
}

function CompareRow({
  label,
  values,
  highlight,
  best,
}: {
  label: string;
  values: (string | number | React.ReactNode)[];
  highlight?: boolean;
  best?: number;
}) {
  return (
    <tr className={`border-b border-white/[0.06] text-[15px] ${highlight ? "bg-white/[0.03]/60" : "bg-white"}`}>
      <td className="px-5 py-3 font-semibold text-slate-400 sticky left-0 bg-inherit z-10">{label}</td>
      {values.map((v, i) => (
        <td
          key={i}
          className={`px-5 py-3 text-white ${best === i ? "bg-[#F5B700]/10" : ""}`}
        >
          <div className="flex items-center gap-1.5">
            {v}
            {best === i && (
              <span className="text-[10px] font-bold text-[#F5B700] bg-[#F5B700]/15 px-1.5 py-0.5 rounded">最佳</span>
            )}
          </div>
        </td>
      ))}
    </tr>
  );
}

function TrendChart({ items, period }: { items: Item[]; period: Period }) {
  const width = 1100;
  const height = 340;
  const pad = { top: 24, right: 24, bottom: 36, left: 56 };

  const series = items.map((item) => generateTrend(item, period));
  const allValues = series.flat();
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const range = maxVal - minVal || 1;

  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  function toX(i: number, total: number) {
    return pad.left + (i / (total - 1)) * chartW;
  }
  function toY(v: number) {
    return pad.top + chartH - ((v - minVal) / range) * chartH;
  }

  return (
    <div className="bg-white/[0.05] border border-white/10 rounded-xl overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-[340px]">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = pad.top + chartH * t;
          const value = maxVal - range * t;
          return (
            <g key={t}>
              <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} stroke="#e2e8f0" strokeWidth="1" />
              <text x={8} y={y + 4} fontSize="11" fill="#94a3b8">{value.toFixed(0)}</text>
            </g>
          );
        })}
        {series.map((data, sIdx) => (
          <polyline
            key={sIdx}
            points={data.map((v, i) => `${toX(i, data.length)},${toY(v)}`).join(" ")}
            fill="none"
            stroke={LINE_COLORS[sIdx]}
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
      </svg>
    </div>
  );
}