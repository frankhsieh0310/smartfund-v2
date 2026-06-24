"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ETF_LIST } from "../etf/data";
import { FUND_LIST, type Fund } from "../funds/data";
import type { Etf } from "../etf/data";

// ── Unified Item ──────────────────────────────────────────────────────
type Item = {
  code: string;
  name: string;
  company?: string;
  type: "ETF" | "基金";
  category: string;
  region: string;
  dividendYield: number;       // 殖利率 / 年化配息率 %
  dividendFreq: string;
  returnYTD: number;
  return1m: number;
  return3m: number;
  return6m: number;
  return1y: number;
  return3y: number;
  volatility: number;
  morningstar?: number;        // 基金才有
};

function etfToItem(e: Etf): Item {
  return {
    code: e.code,
    name: e.name,
    type: "ETF",
    category: e.sector,
    region: e.region,
    dividendYield: e.dividendYield,
    dividendFreq: e.dividendFreq,
    returnYTD: e.returnYTD,
    return1m: e.return1m,
    return3m: e.return3m,
    return6m: e.return6m,
    return1y: e.return1y,
    return3y: e.return3y,
    volatility: e.volatility,
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
    dividendYield: f.dividendYieldA,
    dividendFreq: f.dividendFreq,
    returnYTD: f.returnYTD,
    return1m: f.return1m,
    return3m: f.return3m,
    return6m: f.return6m,
    return1y: f.return1y,
    return3y: f.return3y,
    volatility: f.volatility,
    morningstar: f.morningstar,
  };
}

const ALL_ITEMS: Item[] = [
  ...ETF_LIST.map(etfToItem),
  ...FUND_LIST.map(fundToItem),
];

const LINE_COLORS = [
  "#F5B700","#3b82f6","#22c55e","#ef4444",
  "#9333ea","#ea580c","#0891b2","#65a30d","#db2777","#a78bfa",
];

type Period = "1Y" | "3Y";

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
  const points = period === "1Y" ? 12 : 18;
  const totalReturn = period === "1Y"
    ? item.return1y / 100
    : item.return3y / 100;
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

function MorningstarStars({ n }: { n?: number }) {
  if (!n) return <span className="text-slate-500">—</span>;
  return <span className="text-[#F5B700] text-[15px]">{"★".repeat(n)}</span>;
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
      .filter(i =>
        !selected.find(s => s.code === i.code) &&
        (i.code.toLowerCase().includes(kw) ||
         i.name.toLowerCase().includes(kw) ||
         (i.company && i.company.toLowerCase().includes(kw)))
      )
      .slice(0, 10);
  }, [keyword, selected]);

  function addItem(item: Item) {
    if (selected.length >= MAX) return;
    setSelected(prev => [...prev, item]);
    setKeyword(""); setShowDropdown(false);
  }
  function removeItem(code: string) {
    setSelected(prev => prev.filter(i => i.code !== code));
  }

  function Pct({ v }: { v: number }) {
    return (
      <span className={`font-semibold ${v >= 0 ? "text-emerald-400" : "text-red-400"}`}>
        {v >= 0 ? "+" : ""}{v.toFixed(1)}%
      </span>
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
            <Link href="/funds"   className="hover:text-white transition-colors">基金篩選器</Link>
            <Link href="/compare" className="text-[#F5B700]">比較中心</Link>
            <Link href="/clients" className="hover:text-white transition-colors">客戶管理</Link>
            <Link href="/pricing" className="hover:text-white transition-colors">方案</Link>
          </nav>
          <div className="flex items-center gap-3">
            <a href="#" className="text-[14px] font-semibold text-slate-300 border border-white/30 px-4 py-2 rounded-lg hover:bg-white/10 transition-colors">登入</a>
            <Link href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-5 py-2 rounded-lg font-bold text-[14px] transition-colors">免費註冊</Link>
          </div>
        </div>
      </header>

      <div className="max-w-[1280px] mx-auto">

        <div className="mb-10">
          <div className="tracking-[10px] text-[#F5B700] text-[14px] font-semibold mb-3">COMPARE CENTER</div>
          <h1 className="text-[42px] font-black text-white">ETF ＋ 基金比較中心</h1>
          <p className="text-[15px] text-slate-400 mt-1">可同時比較 ETF 與基金，最多 {MAX} 檔</p>
        </div>

        {/* SEARCH */}
        <div className="relative mb-8">
          <div className="flex gap-3 items-center">
            <div className="relative flex-1 max-w-[480px]">
              <input
                type="text" value={keyword}
                onChange={e => { setKeyword(e.target.value); setShowDropdown(true); }}
                onFocus={() => setShowDropdown(true)}
                onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                placeholder="搜尋代碼或名稱，例如 QQQ、野村、聯博…"
                className="w-full border border-white/20 rounded-xl px-5 py-3.5 text-[15px] text-white bg-transparent placeholder:text-slate-500 focus:outline-none focus:border-[#F5B700]"
                disabled={selected.length >= MAX}
              />
              {showDropdown && suggestions.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-[#0d1729] border border-white/10 rounded-xl shadow-xl z-50 overflow-hidden">
                  {suggestions.map(item => (
                    <button key={item.code} onMouseDown={() => addItem(item)}
                      className="w-full text-left px-5 py-3 hover:bg-[#F5B700]/10 transition-colors flex items-center gap-3">
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${item.type === "ETF" ? "bg-white/10 text-white" : "bg-blue-900 text-blue-300"}`}>
                        {item.type}
                      </span>
                      <span className="font-bold text-white text-[14px]">{item.type === "ETF" ? item.code : item.company}</span>
                      <span className="text-slate-400 text-[13px] truncate">{item.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="text-[13px] text-slate-400">已選 {selected.length} / {MAX} 檔</div>
          </div>
        </div>

        {/* TAGS */}
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-8">
            {selected.map((item, i) => (
              <div key={item.code}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full border text-[13px] font-semibold"
                style={{ borderColor: LINE_COLORS[i], color: LINE_COLORS[i] }}>
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: LINE_COLORS[i] }} />
                {item.type === "ETF" ? item.code : (item.company || item.code)}
                <span className="text-[11px] font-normal opacity-60 max-w-[100px] truncate">
                  {item.type === "基金" ? item.name : ""}
                </span>
                <button onClick={() => removeItem(item.code)} className="ml-1 opacity-50 hover:opacity-100">✕</button>
              </div>
            ))}
            <button onClick={() => setSelected([])}
              className="px-3 py-1.5 rounded-full border border-white/20 text-slate-400 text-[13px] hover:border-red-400 hover:text-red-400 transition-colors">
              清除全部
            </button>
          </div>
        )}

        {selected.length === 0 ? (
          <div className="border border-white/10 rounded-2xl flex items-center justify-center h-[280px] text-slate-500 text-[15px] flex-col gap-3">
            <div className="text-[36px]">↑</div>
            <div>在上方搜尋框輸入代碼或名稱，加入要比較的商品</div>
            <div className="text-[13px] text-slate-600">可同時比較 ETF 與基金</div>
          </div>
        ) : (
          <>
            {/* COMPARISON TABLE */}
            <div className="border border-white/10 rounded-2xl overflow-hidden mb-8">
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="bg-white/[0.06] text-slate-300 text-[13px]">
                      <th className="px-5 py-4 font-semibold sticky left-0 bg-[#0a1120] z-10 min-w-[130px]">項目</th>
                      {selected.map((item, i) => (
                        <th key={item.code} className="px-5 py-4 font-semibold min-w-[160px]">
                          <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: LINE_COLORS[i] }} />
                            <span className="text-white">{item.type === "ETF" ? item.code : item.company}</span>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <CRow label="類型"     values={selected.map(i => (
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${i.type === "ETF" ? "bg-white/10 text-white" : "bg-blue-900 text-blue-300"}`}>{i.type}</span>
                    ))} />
                    <CRow label="名稱"     values={selected.map(i => <span className="text-[12px]">{i.name}</span>)} hi />
                    <CRow label="地區"     values={selected.map(i => i.region)} />
                    <CRow label="類別"     values={selected.map(i => i.category)} hi />
                    <CRow label="晨星評等" values={selected.map(i => <MorningstarStars n={i.morningstar} />)} />
                    <CRow label="配息頻率" values={selected.map(i => i.dividendFreq)} hi />
                    <CRow label="年化配息率" values={selected.map(i => i.dividendYield > 0 ? `${i.dividendYield.toFixed(1)}%` : "—")}
                      best={findBest(selected.map(i => i.dividendYield), "high")} />
                    <CRow label="今年以來" values={selected.map(i => <Pct v={i.returnYTD} />)}
                      best={findBest(selected.map(i => i.returnYTD), "high")} hi />
                    <CRow label="近1個月"  values={selected.map(i => <Pct v={i.return1m} />)}
                      best={findBest(selected.map(i => i.return1m), "high")} />
                    <CRow label="近3個月"  values={selected.map(i => <Pct v={i.return3m} />)}
                      best={findBest(selected.map(i => i.return3m), "high")} hi />
                    <CRow label="近6個月"  values={selected.map(i => <Pct v={i.return6m} />)}
                      best={findBest(selected.map(i => i.return6m), "high")} />
                    <CRow label="近1年"    values={selected.map(i => <Pct v={i.return1y} />)}
                      best={findBest(selected.map(i => i.return1y), "high")} hi />
                    <CRow label="近3年"    values={selected.map(i => <Pct v={i.return3y} />)}
                      best={findBest(selected.map(i => i.return3y), "high")} />
                    <CRow label="年化波動度" values={selected.map(i => `${i.volatility.toFixed(1)}%`)}
                      best={findBest(selected.map(i => i.volatility), "low")} hi />
                  </tbody>
                </table>
              </div>
            </div>

            {/* TREND CHART */}
            <div className="border border-white/10 rounded-2xl p-8">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                <div className="text-[20px] font-bold text-white">走勢比較（指數化，起點＝100）</div>
                <div className="flex gap-2">
                  {(["1Y","3Y"] as Period[]).map(p => (
                    <button key={p} onClick={() => setPeriod(p)}
                      className={`px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors ${period === p ? "bg-[#F5B700] text-[#0B1220]" : "border border-white/20 text-slate-400 hover:border-[#F5B700]"}`}>
                      {p === "1Y" ? "1年" : "3年"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap gap-4 mb-4">
                {selected.map((item, i) => (
                  <div key={item.code} className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full" style={{ backgroundColor: LINE_COLORS[i] }} />
                    <span className="text-[13px] font-semibold text-white">{item.type === "ETF" ? item.code : item.company}</span>
                    <span className="text-[12px] text-slate-500">{item.type}</span>
                  </div>
                ))}
              </div>

              <TrendChart items={selected} period={period} />
              <p className="text-[12px] text-slate-600 mt-3">走勢為示意模擬曲線，非真實逐日歷史價格，僅供功能展示。</p>
            </div>
          </>
        )}

        <p className="text-[12px] text-slate-600 mt-8 text-center">
          以上資料為示意範例，不構成投資建議。
        </p>

        <div className="flex justify-center mt-8 gap-4">
          <Link href="/etf"  className="border border-white/20 text-white px-7 py-3 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[15px]">ETF 資料庫</Link>
          <Link href="/funds" className="border border-white/20 text-white px-7 py-3 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[15px]">基金資料庫</Link>
          <Link href="/"     className="border border-white/20 text-white px-7 py-3 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[15px]">回到首頁</Link>
        </div>
      </div>
    </main>
  );
}

// ── helpers ──────────────────────────────────────────────────────────

function findBest(values: number[], mode: "high" | "low"): number {
  if (values.length === 0) return -1;
  const target = mode === "high" ? Math.max(...values) : Math.min(...values);
  return values.indexOf(target);
}

function CRow({ label, values, hi, best }: {
  label: string;
  values: (string | number | React.ReactNode)[];
  hi?: boolean;
  best?: number;
}) {
  return (
    <tr className={`border-b border-white/[0.05] text-[14px] ${hi ? "bg-white/[0.025]" : ""}`}>
      <td className="px-5 py-3 font-semibold text-slate-500 sticky left-0 bg-inherit z-10">{label}</td>
      {values.map((v, i) => (
        <td key={i} className={`px-5 py-3 text-white ${best === i ? "bg-[#F5B700]/10" : ""}`}>
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
  const W = 1100, H = 320;
  const pad = { top: 20, right: 20, bottom: 32, left: 52 };
  const series = items.map(item => generateTrend(item, period));
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