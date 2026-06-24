"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { FUND_LIST, COMPANIES, CATEGORIES, REGIONS, type Fund } from "./data";

type SortKey = "returnYTD" | "return1m" | "return3m" | "return6m" | "return1y" | "return3y" | "dividendYieldA" | "dividendYieldM" | "dividendPerUnit" | "volatility";
type SortDir = "asc" | "desc";
type Period = "1M" | "3M" | "6M" | "1Y" | "3Y";

const PERIODS: { key: Period; label: string }[] = [
  { key: "1M", label: "1月" },
  { key: "3M", label: "3月" },
  { key: "6M", label: "6月" },
  { key: "1Y", label: "1年" },
  { key: "3Y", label: "3年" },
];

const LINE_COLORS = ["#F5B700", "#3b82f6", "#22c55e", "#ef4444", "#9333ea"];
const MAX_CHART = 5;

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
  const points = { "1M": 22, "3M": 13, "6M": 12, "1Y": 12, "3Y": 18 }[period];
  const returnMap: Record<Period, number> = {
    "1M": fund.return1m,
    "3M": fund.return3m,
    "6M": fund.return6m,
    "1Y": fund.return1y,
    "3Y": fund.return3y,
  };
  const totalReturn = returnMap[period] / 100;
  const end = 100 * (1 + totalReturn);
  const result: number[] = [];
  for (let i = 0; i < points; i++) {
    const progress = i / (points - 1);
    const base = 100 + (end - 100) * progress;
    const noise = (seededRandom(fund.id, i) - 0.5) * Math.abs(end - 100) * 0.2;
    result.push(Math.round((base + noise) * 100) / 100);
  }
  result[0] = 100;
  result[result.length - 1] = Math.round(end * 100) / 100;
  return result;
}

// 只顯示金色星星，不顯示空心星
function MorningstarStars({ n }: { n: number }) {
  return <span className="text-[#F5B700] text-[14px] tracking-tight">{"★".repeat(n)}</span>;
}

function Pct({ v }: { v: number }) {
  return (
    <span className={`font-semibold ${v >= 0 ? "text-emerald-400" : "text-red-400"}`}>
      {v >= 0 ? "+" : ""}{v.toFixed(1)}%
    </span>
  );
}

export default function FundsPage() {
  const [keyword, setKeyword]         = useState("");
  const [company, setCompany]         = useState("全部");
  const [category, setCategory]       = useState("全部");
  const [region, setRegion]           = useState("全部");
  const [sortKey, setSortKey]         = useState<SortKey>("return1y");
  const [sortDir, setSortDir]         = useState<SortDir>("desc");
  const [chartFunds, setChartFunds]   = useState<Fund[]>([]);
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
    if (company  !== "全部") list = list.filter(f => f.company  === company);
    if (category !== "全部") list = list.filter(f => f.category === category);
    if (region   !== "全部") list = list.filter(f => f.region   === region);
    return [...list].sort((a, b) => {
      const diff = a[sortKey] - b[sortKey];
      return sortDir === "asc" ? diff : -diff;
    });
  }, [keyword, company, category, region, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  function toggleChart(fund: Fund) {
    setChartFunds(prev => {
      if (prev.find(f => f.id === fund.id)) return prev.filter(f => f.id !== fund.id);
      if (prev.length >= MAX_CHART) return prev;
      return [...prev, fund];
    });
  }

  function SortTh({ label, k }: { label: string; k: SortKey }) {
    return (
      <th onClick={() => handleSort(k)}
        className="px-3 py-3 font-semibold cursor-pointer select-none hover:text-[#F5B700] transition-colors whitespace-nowrap">
        <span className="flex items-center gap-1">
          {label}
          <span className="text-[10px] opacity-60">{sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : "↕"}</span>
        </span>
      </th>
    );
  }

  return (
    <main className="min-h-screen px-6 pt-32 pb-20">

      {/* NAVBAR */}
      <header className="fixed top-0 left-0 w-full z-50 bg-[#040a18]/85 backdrop-blur-xl border-b border-white/[0.08]">
        <div className="max-w-[1700px] mx-auto h-20 px-10 flex items-center justify-between">
          <Link href="/">
            <div className="text-[28px] font-black text-white leading-none">
              Smart<span className="text-[#F5B700]">Match</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">ETF & 基金資產配置分析平台</div>
          </Link>
          <nav className="hidden lg:flex gap-7 text-[14px] font-semibold text-slate-300">
            <Link href="/quiz"    className="hover:text-white transition-colors">投資人格分析</Link>
            <Link href="/etf"     className="hover:text-white transition-colors">ETF篩選器</Link>
            <Link href="/funds"   className="text-[#F5B700]">基金篩選器</Link>
            <Link href="/compare" className="hover:text-white transition-colors">比較中心</Link>
            <Link href="/clients" className="hover:text-white transition-colors">客戶管理</Link>
            <Link href="/pricing" className="hover:text-white transition-colors">方案</Link>
          </nav>
          <div className="flex items-center gap-3">
            <a href="#" className="text-[14px] font-semibold text-slate-300 border border-white/30 px-4 py-2 rounded-lg hover:bg-white/10 transition-colors">登入</a>
            <Link href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-5 py-2 rounded-lg font-bold text-[14px] transition-colors">免費註冊</Link>
          </div>
        </div>
      </header>

      <div className="max-w-[1600px] mx-auto">

        {/* PAGE HEADER */}
        <div className="mb-8">
          <div className="tracking-[10px] text-[#F5B700] text-[14px] font-semibold mb-3">FUND DATABASE</div>
          <h1 className="text-[42px] font-black text-white">基金篩選器</h1>
          <p className="text-[15px] text-slate-400 mt-1">
            共 {FUND_LIST.length} 檔基金・前20大基金公司・支援搜尋、篩選、排序
          </p>
        </div>

        {/* FILTERS */}
        <div className="flex flex-wrap gap-3 mb-6">
          <input type="text" value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="搜尋基金名稱或公司"
            className="flex-1 min-w-[200px] bg-transparent border border-white/20 rounded-lg px-4 py-3 text-[15px] text-white placeholder:text-slate-500 focus:outline-none focus:border-[#F5B700]"
          />
          <select value={company}   onChange={e => setCompany(e.target.value)}
            className="bg-[#040a18] border border-white/20 rounded-lg px-3 py-3 text-[15px] text-white focus:outline-none focus:border-[#F5B700]">
            <option value="全部">全部公司</option>
            {COMPANIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={category}  onChange={e => setCategory(e.target.value)}
            className="bg-[#040a18] border border-white/20 rounded-lg px-3 py-3 text-[15px] text-white focus:outline-none focus:border-[#F5B700]">
            <option value="全部">全部類型</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={region}    onChange={e => setRegion(e.target.value)}
            className="bg-[#040a18] border border-white/20 rounded-lg px-3 py-3 text-[15px] text-white focus:outline-none focus:border-[#F5B700]">
            <option value="全部">全部地區</option>
            {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        <div className="flex items-center justify-between mb-3">
          <div className="text-[13px] text-slate-500">符合條件：{filtered.length} 檔</div>
          {chartFunds.length > 0 && (
            <div className="text-[13px] text-[#F5B700] font-semibold">已選 {chartFunds.length} 檔加入走勢比較</div>
          )}
        </div>

        {/* TABLE */}
        <div className="border border-white/10 rounded-2xl overflow-hidden mb-8">
          <div className="overflow-x-auto">
            <table className="w-full text-left min-w-[1300px]">
              <thead>
                <tr className="bg-white/[0.06] text-slate-300 text-[12px]">
                  <th className="px-3 py-3 w-[32px]"></th>
                  <th className="px-3 py-3 font-semibold min-w-[64px]">公司</th>
                  <th className="px-4 py-3 font-semibold min-w-[200px]">基金名稱</th>
                  <th className="px-3 py-3 font-semibold">類別</th>
                  <th className="px-3 py-3 font-semibold">地區</th>
                  <th className="px-3 py-3 font-semibold">晨星評等</th>
                  <th className="px-3 py-3 font-semibold">配息頻率</th>
                  <SortTh label="每單位配息" k="dividendPerUnit" />
                  <SortTh label="月配息率%" k="dividendYieldM" />
                  <SortTh label="年化配息率%" k="dividendYieldA" />
                  <SortTh label="今年以來%" k="returnYTD" />
                  <SortTh label="近1月%" k="return1m" />
                  <SortTh label="近3月%" k="return3m" />
                  <SortTh label="近6月%" k="return6m" />
                  <SortTh label="近1年%" k="return1y" />
                  <SortTh label="近3年%" k="return3y" />
                  <SortTh label="波動度%" k="volatility" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((fund, i) => {
                  const inChart  = chartFunds.find(f => f.id === fund.id);
                  const chartIdx = chartFunds.findIndex(f => f.id === fund.id);
                  return (
                    <tr key={fund.id}
                      className={`text-[13px] border-t border-white/[0.04] hover:bg-[#F5B700]/[0.05] transition-colors ${i % 2 === 1 ? "bg-white/[0.02]" : ""} ${inChart ? "bg-[#F5B700]/[0.05]" : ""}`}>

                      {/* 走勢比較按鈕 */}
                      <td className="px-3 py-2.5">
                        <button onClick={() => toggleChart(fund)}
                          disabled={!inChart && chartFunds.length >= MAX_CHART}
                          title={inChart ? "移除走勢比較" : "加入走勢比較"}
                          className={`w-5 h-5 rounded-full border-2 transition-all flex items-center justify-center text-[9px] font-bold ${
                            inChart
                              ? "border-transparent text-white"
                              : "border-white/20 hover:border-[#F5B700] disabled:opacity-20"
                          }`}
                          style={inChart ? { backgroundColor: LINE_COLORS[chartIdx] } : {}}>
                          {inChart ? "✓" : ""}
                        </button>
                      </td>

                      <td className="px-3 py-2.5 font-bold text-white">{fund.company}</td>
                      <td className="px-4 py-2.5 text-slate-200">{fund.name}</td>

                      {/* 類別 badge */}
                      <td className="px-3 py-2.5">
                        <span className={`text-[11px] px-1.5 py-0.5 rounded font-semibold ${
                          fund.category === "股票型" ? "bg-blue-900/60 text-blue-300" :
                          fund.category === "債券型" ? "bg-white/[0.06] text-slate-400" :
                          fund.category === "平衡型" ? "bg-purple-900/60 text-purple-300" :
                          "bg-emerald-900/60 text-emerald-300"
                        }`}>
                          {fund.category}
                        </span>
                      </td>

                      <td className="px-3 py-2.5 text-slate-400 text-[12px]">{fund.region}</td>

                      {/* 晨星評等：只顯示金色星星 */}
                      <td className="px-3 py-2.5">
                        <MorningstarStars n={fund.morningstar} />
                      </td>

                      <td className="px-3 py-2.5 text-slate-400 text-[12px]">{fund.dividendFreq}</td>
                      <td className="px-3 py-2.5">{fund.dividendPerUnit > 0 ? fund.dividendPerUnit.toFixed(4) : "—"}</td>
                      <td className="px-3 py-2.5">{fund.dividendYieldM > 0 ? `${fund.dividendYieldM.toFixed(3)}%` : "—"}</td>
                      <td className="px-3 py-2.5 font-semibold text-[#F5B700]">
                        {fund.dividendYieldA > 0 ? `${fund.dividendYieldA.toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-3 py-2.5"><Pct v={fund.returnYTD} /></td>
                      <td className="px-3 py-2.5"><Pct v={fund.return1m} /></td>
                      <td className="px-3 py-2.5"><Pct v={fund.return3m} /></td>
                      <td className="px-3 py-2.5"><Pct v={fund.return6m} /></td>
                      <td className="px-3 py-2.5"><Pct v={fund.return1y} /></td>
                      <td className="px-3 py-2.5"><Pct v={fund.return3y} /></td>
                      <td className="px-3 py-2.5 text-slate-300">{fund.volatility.toFixed(1)}%</td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={17} className="px-5 py-12 text-center text-slate-500">找不到符合條件的基金</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* 走勢比較圖 */}
        {chartFunds.length > 0 ? (
          <div className="border border-white/10 rounded-2xl p-8 mb-8">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
              <div className="text-[20px] font-bold text-white">走勢比較（指數化，起點＝100）</div>
              <div className="flex gap-2">
                {PERIODS.map(p => (
                  <button key={p.key} onClick={() => setChartPeriod(p.key)}
                    className={`px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors ${
                      chartPeriod === p.key ? "bg-[#F5B700] text-[#0B1220]" : "border border-white/20 text-slate-400 hover:border-[#F5B700]"
                    }`}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-4 mb-4">
              {chartFunds.map((fund, i) => (
                <div key={fund.id} className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: LINE_COLORS[i] }} />
                  <span className="text-[13px] font-semibold text-white">{fund.company}</span>
                  <span className="text-[12px] text-slate-400">{fund.name}</span>
                  <button onClick={() => toggleChart(fund)} className="text-slate-500 hover:text-red-400 text-[11px] ml-1">✕</button>
                </div>
              ))}
              <button onClick={() => setChartFunds([])} className="text-slate-500 text-[12px] hover:text-red-400">清除全部</button>
            </div>
            <TrendChart funds={chartFunds} period={chartPeriod} />
            <p className="text-[12px] text-slate-600 mt-3">走勢為示意模擬曲線，非真實逐日歷史淨值，僅供功能展示。</p>
          </div>
        ) : (
          <div className="border border-dashed border-white/[0.08] rounded-2xl p-6 mb-8 text-center text-slate-600">
            <div className="text-[14px]">點擊表格左側圓圈，加入最多 {MAX_CHART} 檔基金進行走勢比較</div>
          </div>
        )}

        <p className="text-[12px] text-slate-600 mt-4 text-center">
          以上資料為示意範例，不構成投資建議。實際投資請參考各基金公開說明書。
        </p>

        <div className="flex justify-center mt-8 gap-4">
          <Link href="/compare" className="border border-white/20 text-white px-7 py-3 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[15px]">ETF+基金比較中心</Link>
          <Link href="/"        className="border border-white/20 text-white px-7 py-3 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[15px]">回到首頁</Link>
        </div>
      </div>
    </main>
  );
}

function TrendChart({ funds, period }: { funds: Fund[]; period: Period }) {
  const W = 1100, H = 320;
  const pad = { top: 20, right: 20, bottom: 32, left: 52 };
  const series = funds.map(f => generateTrend(f, period));
  const all = series.flat();
  const minV = Math.min(...all), maxV = Math.max(...all);
  const range = maxV - minV || 1;
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;
  const toX = (i: number, n: number) => pad.left + (i / (n - 1)) * cW;
  const toY = (v: number) => pad.top + cH - ((v - minV) / range) * cH;

  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[320px]">
        {[0, 0.25, 0.5, 0.75, 1].map(t => {
          const y = pad.top + cH * t;
          const val = maxV - range * t;
          return (
            <g key={t}>
              <line x1={pad.left} y1={y} x2={W - pad.right} y2={y} stroke="#1e293b" strokeWidth="1" />
              <text x={6} y={y + 4} fontSize="10" fill="#64748b">{val.toFixed(0)}</text>
            </g>
          );
        })}
        {series.map((data, si) => (
          <polyline key={si}
            points={data.map((v, i) => `${toX(i, data.length)},${toY(v)}`).join(" ")}
            fill="none" stroke={LINE_COLORS[si]} strokeWidth="2.5"
            strokeLinejoin="round" strokeLinecap="round" />
        ))}
      </svg>
    </div>
  );
}