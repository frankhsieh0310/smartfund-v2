"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { FUND_LIST, COMPANIES, CATEGORIES, REGIONS, type Fund } from "./data";

type SortKey = "return1y" | "return3y" | "return5y" | "dividendYield" | "expenseRatio" | "aum" | "volatility" | "sharpe";
type SortDir = "asc" | "desc";
type Period = "1M" | "3M" | "6M" | "1Y" | "3Y" | "5Y";

const PERIODS: { key: Period; label: string }[] = [
  { key: "1M", label: "1月" },
  { key: "3M", label: "3月" },
  { key: "6M", label: "6月" },
  { key: "1Y", label: "1年" },
  { key: "3Y", label: "3年" },
  { key: "5Y", label: "5年" },
];

const LINE_COLORS = ["#F5B700", "#0B1220", "#3b82f6", "#16a34a", "#dc2626"];
const MAX_CHART = 5;

const STAR_COLORS = ["", "#dc2626", "#ea580c", "#F5B700", "#84cc16", "#16a34a"];

function seededRandom(seed: string, index: number): number {
  let hash = 0;
  const str = `${seed}-${index}`;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) % 1000) / 1000;
}

function generateTrend(fund: Fund, period: Period): number[] {
  const points = { "1M": 22, "3M": 13, "6M": 12, "1Y": 12, "3Y": 18, "5Y": 20 }[period];
  const returnMap: Record<Period, number> = {
    "1M": fund.return1m,
    "3M": fund.return3m,
    "6M": fund.return6m,
    "1Y": fund.return1y,
    "3Y": fund.return3y,
    "5Y": fund.return5y,
  };
  const totalReturn = returnMap[period] / 100;
  const start = 100;
  const end = start * (1 + totalReturn);
  const result: number[] = [];
  for (let i = 0; i < points; i++) {
    const progress = i / (points - 1);
    const base = start + (end - start) * progress;
    const noise = (seededRandom(fund.id, i) - 0.5) * Math.abs(end - start) * 0.2;
    result.push(Math.round((base + noise) * 100) / 100);
  }
  result[0] = 100;
  result[result.length - 1] = Math.round(end * 100) / 100;
  return result;
}

function StarRating({ stars }: { stars: number }) {
  return (
    <span className="text-[14px]">
      {"★".repeat(stars)}<span className="text-slate-200">{"★".repeat(5 - stars)}</span>
    </span>
  );
}

export default function FundsPage() {
  const [keyword, setKeyword] = useState("");
  const [company, setCompany] = useState("全部");
  const [category, setCategory] = useState("全部");
  const [region, setRegion] = useState("全部");
  const [dividendType, setDividendType] = useState("全部");
  const [sortKey, setSortKey] = useState<SortKey>("return1y");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [chartFunds, setChartFunds] = useState<Fund[]>([]);
  const [chartPeriod, setChartPeriod] = useState<Period>("1Y");

  const filtered = useMemo(() => {
    let list = FUND_LIST;
    if (keyword.trim()) {
      const kw = keyword.trim().toLowerCase();
      list = list.filter(f =>
        f.name.toLowerCase().includes(kw) ||
        f.company.toLowerCase().includes(kw) ||
        f.id.toLowerCase().includes(kw)
      );
    }
    if (company !== "全部") list = list.filter(f => f.company === company);
    if (category !== "全部") list = list.filter(f => f.category === category);
    if (region !== "全部") list = list.filter(f => f.region === region);
    if (dividendType !== "全部") list = list.filter(f => f.dividendType === dividendType);
    return [...list].sort((a, b) => {
      const diff = a[sortKey] - b[sortKey];
      return sortDir === "asc" ? diff : -diff;
    });
  }, [keyword, company, category, region, dividendType, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function toggleChart(fund: Fund) {
    setChartFunds(prev => {
      if (prev.find(f => f.id === fund.id)) return prev.filter(f => f.id !== fund.id);
      if (prev.length >= MAX_CHART) return prev;
      return [...prev, fund];
    });
  }

  return (
    <main className="min-h-screen bg-white px-6 py-20">
      <div className="max-w-[1400px] mx-auto">

        <div className="mb-10">
          <div className="tracking-[10px] text-[#F5B700] text-[16px] font-semibold mb-4">SMARTMATCH</div>
          <h1 className="text-[44px] font-black text-[#0B1220]">基金資料庫</h1>
          <p className="text-[16px] text-slate-500 mt-2">
            共 {FUND_LIST.length} 檔基金・前20大基金公司主力商品・支援搜尋、篩選、排序與走勢比較
          </p>
        </div>

        {/* FILTERS */}
        <div className="flex flex-wrap gap-3 mb-6">
          <input
            type="text"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="搜尋基金名稱或公司"
            className="flex-1 min-w-[200px] border border-slate-300 rounded-lg px-4 py-2.5 text-[15px] focus:outline-none focus:border-[#F5B700]"
          />
          <select value={company} onChange={e => setCompany(e.target.value)} className="border border-slate-300 rounded-lg px-3 py-2.5 text-[15px] focus:outline-none focus:border-[#F5B700]">
            <option value="全部">全部公司</option>
            {COMPANIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={category} onChange={e => setCategory(e.target.value)} className="border border-slate-300 rounded-lg px-3 py-2.5 text-[15px] focus:outline-none focus:border-[#F5B700]">
            <option value="全部">全部類型</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={region} onChange={e => setRegion(e.target.value)} className="border border-slate-300 rounded-lg px-3 py-2.5 text-[15px] focus:outline-none focus:border-[#F5B700]">
            <option value="全部">全部地區</option>
            {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={dividendType} onChange={e => setDividendType(e.target.value)} className="border border-slate-300 rounded-lg px-3 py-2.5 text-[15px] focus:outline-none focus:border-[#F5B700]">
            <option value="全部">配息/不配息</option>
            <option value="配息">配息</option>
            <option value="不配息">不配息</option>
          </select>
        </div>

        <div className="flex items-center justify-between mb-4">
          <div className="text-[14px] text-slate-500">符合條件：{filtered.length} 檔</div>
          {chartFunds.length > 0 && (
            <div className="text-[14px] text-[#F5B700] font-semibold">
              已選 {chartFunds.length} 檔加入走勢比較
            </div>
          )}
        </div>

        {/* TABLE */}
        <div className="border border-slate-200 rounded-2xl overflow-hidden mb-8">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-[#0B1220] text-white text-[13px]">
                  <th className="px-3 py-3 w-[32px]"></th>
                  <th className="px-4 py-3 font-semibold min-w-[80px]">公司</th>
                  <th className="px-4 py-3 font-semibold min-w-[220px]">基金名稱</th>
                  <th className="px-4 py-3 font-semibold">類型</th>
                  <th className="px-4 py-3 font-semibold">地區</th>
                  <th className="px-4 py-3 font-semibold">配息</th>
                  <th className="px-4 py-3 font-semibold">晨星</th>
                  <th className="px-4 py-3 font-semibold">風險</th>
                  <SortTh label="費用率" active={sortKey === "expenseRatio"} dir={sortDir} onClick={() => handleSort("expenseRatio")} />
                  <SortTh label="配息率" active={sortKey === "dividendYield"} dir={sortDir} onClick={() => handleSort("dividendYield")} />
                  <SortTh label="規模(億)" active={sortKey === "aum"} dir={sortDir} onClick={() => handleSort("aum")} />
                  <SortTh label="近1年" active={sortKey === "return1y"} dir={sortDir} onClick={() => handleSort("return1y")} />
                  <SortTh label="近3年" active={sortKey === "return3y"} dir={sortDir} onClick={() => handleSort("return3y")} />
                  <SortTh label="近5年" active={sortKey === "return5y"} dir={sortDir} onClick={() => handleSort("return5y")} />
                  <SortTh label="波動度" active={sortKey === "volatility"} dir={sortDir} onClick={() => handleSort("volatility")} />
                  <SortTh label="夏普值" active={sortKey === "sharpe"} dir={sortDir} onClick={() => handleSort("sharpe")} />
                </tr>
              </thead>
              <tbody>
                {filtered.map((fund, i) => {
                  const inChart = chartFunds.find(f => f.id === fund.id);
                  const chartIdx = chartFunds.indexOf(fund);
                  return (
                    <tr
                      key={fund.id}
                      className={`text-[13px] border-b border-slate-100 transition-colors ${
                        i % 2 === 1 ? "bg-slate-50/60" : "bg-white"
                      } ${inChart ? "bg-[#F5B700]/8" : ""} hover:bg-[#F5B700]/5`}
                    >
                      <td className="px-3 py-2.5">
                        <button
                          onClick={() => toggleChart(fund)}
                          disabled={!inChart && chartFunds.length >= MAX_CHART}
                          title={inChart ? "移除走勢比較" : "加入走勢比較"}
                          className={`w-5 h-5 rounded-full border-2 transition-colors flex items-center justify-center text-[10px] font-bold ${
                            inChart
                              ? "border-transparent text-white"
                              : "border-slate-300 hover:border-[#F5B700] disabled:opacity-30"
                          }`}
                          style={inChart ? { backgroundColor: LINE_COLORS[chartIdx] } : {}}
                        >
                          {inChart ? "✓" : ""}
                        </button>
                      </td>
                      <td className="px-4 py-2.5 font-semibold text-[#0B1220]">{fund.company}</td>
                      <td className="px-4 py-2.5 text-[#0B1220]">{fund.name}</td>
                      <td className="px-4 py-2.5">
                        <span className={`text-[11px] px-1.5 py-0.5 rounded font-semibold ${
                          fund.category === "股票型" ? "bg-blue-100 text-blue-700" :
                          fund.category === "債券型" ? "bg-slate-100 text-slate-600" :
                          fund.category === "平衡型" ? "bg-purple-100 text-purple-700" :
                          "bg-green-100 text-green-700"
                        }`}>
                          {fund.category}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-500">{fund.region}</td>
                      <td className="px-4 py-2.5">
                        <span className={`text-[11px] px-1.5 py-0.5 rounded font-semibold ${
                          fund.dividendType === "配息" ? "bg-[#F5B700]/20 text-[#b38600]" : "bg-slate-100 text-slate-500"
                        }`}>
                          {fund.dividendType}
                        </span>
                      </td>
                      <td className="px-4 py-2.5" style={{ color: STAR_COLORS[fund.morningstar] }}>
                        <StarRating stars={fund.morningstar} />
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`text-[11px] px-1.5 py-0.5 rounded font-semibold ${
                          fund.riskLevel <= 2 ? "bg-green-100 text-green-700" :
                          fund.riskLevel === 3 ? "bg-yellow-100 text-yellow-700" :
                          "bg-red-100 text-red-600"
                        }`}>
                          RR{fund.riskLevel}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">{fund.expenseRatio.toFixed(2)}%</td>
                      <td className="px-4 py-2.5 font-semibold text-[#F5B700]">
                        {fund.dividendYield > 0 ? `${fund.dividendYield.toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-4 py-2.5">{fund.aum}</td>
                      <td className={`px-4 py-2.5 font-semibold ${fund.return1y >= 0 ? "text-green-600" : "text-red-500"}`}>
                        {fund.return1y >= 0 ? "+" : ""}{fund.return1y.toFixed(1)}%
                      </td>
                      <td className={`px-4 py-2.5 ${fund.return3y >= 0 ? "text-green-600" : "text-red-500"}`}>
                        {fund.return3y >= 0 ? "+" : ""}{fund.return3y.toFixed(1)}%
                      </td>
                      <td className={`px-4 py-2.5 ${fund.return5y >= 0 ? "text-green-600" : "text-red-500"}`}>
                        {fund.return5y >= 0 ? "+" : ""}{fund.return5y.toFixed(1)}%
                      </td>
                      <td className="px-4 py-2.5">{fund.volatility.toFixed(1)}%</td>
                      <td className="px-4 py-2.5">{fund.sharpe.toFixed(2)}</td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={16} className="px-5 py-12 text-center text-slate-400">
                      找不到符合條件的基金，請調整篩選條件
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* TREND CHART */}
        {chartFunds.length > 0 && (
          <div className="border border-slate-200 rounded-2xl p-8 mb-8">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
              <div className="text-[22px] font-bold text-[#0B1220]">走勢比較（指數化，起點=100）</div>
              <div className="flex gap-2">
                {PERIODS.map(p => (
                  <button
                    key={p.key}
                    onClick={() => setChartPeriod(p.key)}
                    className={`px-4 py-2 rounded-lg text-[14px] font-semibold transition-colors ${
                      chartPeriod === p.key
                        ? "bg-[#F5B700] text-[#0B1220]"
                        : "bg-white border border-slate-300 text-slate-600 hover:border-[#F5B700]"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-4 mb-4">
              {chartFunds.map((fund, i) => (
                <div key={fund.id} className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: LINE_COLORS[i] }} />
                  <span className="text-[14px] font-semibold text-[#0B1220]">{fund.company}</span>
                  <span className="text-[13px] text-slate-500">{fund.name}</span>
                  <button onClick={() => toggleChart(fund)} className="text-slate-300 hover:text-red-400 text-[12px] ml-1">✕</button>
                </div>
              ))}
              <button onClick={() => setChartFunds([])} className="text-slate-400 text-[13px] hover:text-red-400 transition-colors">清除全部</button>
            </div>

            <TrendChart funds={chartFunds} period={chartPeriod} />

            <p className="text-[13px] text-slate-400 mt-4">
              走勢為示意模擬曲線（起點=100），非真實逐日歷史淨值，僅供功能展示參考。
            </p>
          </div>
        )}

        {chartFunds.length === 0 && (
          <div className="border border-dashed border-slate-300 rounded-2xl p-8 mb-8 text-center text-slate-400">
            <div className="text-[20px] mb-2">📊</div>
            <div className="text-[15px]">點擊表格左側的圓圈，加入最多 {MAX_CHART} 檔基金進行走勢比較</div>
          </div>
        )}

        <p className="text-[13px] text-slate-400 mt-4 text-center leading-relaxed">
          以上資料為示意範例，非即時市場數據。本頁內容為資料分析結果，不構成投資建議。
        </p>

        <div className="flex justify-center mt-10 gap-4">
          <Link href="/compare" className="border border-slate-300 text-[#0B1220] px-8 py-3.5 rounded-lg hover:bg-slate-50 transition-colors font-semibold text-[16px]">
            ETF+基金比較中心
          </Link>
          <Link href="/" className="border border-slate-300 text-[#0B1220] px-8 py-3.5 rounded-lg hover:bg-slate-50 transition-colors font-semibold text-[16px]">
            回到首頁
          </Link>
        </div>

      </div>
    </main>
  );
}

function SortTh({ label, active, dir, onClick }: { label: string; active: boolean; dir: SortDir; onClick: () => void }) {
  return (
    <th onClick={onClick} className="px-4 py-3 font-semibold cursor-pointer select-none hover:text-[#F5B700] transition-colors whitespace-nowrap">
      <span className="flex items-center gap-1">
        {label}
        <span className="text-[10px] opacity-70">{active ? (dir === "asc" ? "▲" : "▼") : "↕"}</span>
      </span>
    </th>
  );
}

function TrendChart({ funds, period }: { funds: Fund[]; period: Period }) {
  const width = 1100;
  const height = 340;
  const pad = { top: 24, right: 24, bottom: 36, left: 56 };

  const series = funds.map(f => generateTrend(f, period));
  const allValues = series.flat();
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const range = maxVal - minVal || 1;

  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  const toX = (i: number, total: number) => pad.left + (i / (total - 1)) * chartW;
  const toY = (v: number) => pad.top + chartH - ((v - minVal) / range) * chartH;

  return (
    <div className="bg-white rounded-xl overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-[340px]">
        {[0, 0.25, 0.5, 0.75, 1].map(t => {
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