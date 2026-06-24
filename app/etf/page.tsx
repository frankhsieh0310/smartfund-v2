"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ETF_LIST, REGIONS, SECTORS, type Etf } from "./data";

type SortKey = "dividendYield" | "dividendPerUnit" | "returnYTD" | "return1m" | "return3m" | "return6m" | "return1y" | "return3y" | "volatility";
type SortDir = "asc" | "desc";

function Stars({ morningstar }: { morningstar?: number }) {
  return null; // ETF 無晨星評等
}

export default function EtfDatabasePage() {
  const [keyword, setKeyword]   = useState("");
  const [region, setRegion]     = useState("全部");
  const [sector, setSector]     = useState("全部");
  const [sortKey, setSortKey]   = useState<SortKey>("return1y");
  const [sortDir, setSortDir]   = useState<SortDir>("desc");

  const filtered = useMemo(() => {
    let list: Etf[] = ETF_LIST;
    if (keyword.trim()) {
      const kw = keyword.trim().toLowerCase();
      list = list.filter(e =>
        e.code.toLowerCase().includes(kw) || e.name.toLowerCase().includes(kw)
      );
    }
    if (region !== "全部") list = list.filter(e => e.region === region);
    if (sector !== "全部") list = list.filter(e => e.sector === sector);
    return [...list].sort((a, b) => {
      const diff = a[sortKey] - b[sortKey];
      return sortDir === "asc" ? diff : -diff;
    });
  }, [keyword, region, sector, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  function Th({ label, k }: { label: string; k: SortKey }) {
    return (
      <th onClick={() => handleSort(k)}
        className="px-4 py-4 font-semibold cursor-pointer select-none hover:text-[#F5B700] transition-colors whitespace-nowrap">
        <span className="flex items-center gap-1">
          {label}
          <span className="text-[11px] opacity-60">
            {sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
          </span>
        </span>
      </th>
    );
  }

  function Pct({ v, green }: { v: number; green?: boolean }) {
    const color = green !== false
      ? (v >= 0 ? "text-emerald-400" : "text-red-400")
      : "text-slate-300";
    return (
      <span className={`font-semibold ${color}`}>
        {v >= 0 ? "+" : ""}{v.toFixed(1)}%
      </span>
    );
  }

  return (
    <main className="min-h-screen px-6 pt-32 pb-20">
      <div className="max-w-[1600px] mx-auto">

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
              <Link href="/etf"     className="text-[#F5B700]">ETF篩選器</Link>
              <Link href="/funds"   className="hover:text-white transition-colors">基金篩選器</Link>
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

        {/* PAGE HEADER */}
        <div className="mb-8">
          <div className="tracking-[10px] text-[#F5B700] text-[14px] font-semibold mb-3">ETF DATABASE</div>
          <h1 className="text-[42px] font-black text-white">ETF 篩選器</h1>
          <p className="text-[15px] text-slate-400 mt-1">共 {ETF_LIST.length} 檔 ETF，支援搜尋、篩選與排序</p>
        </div>

        {/* FILTERS */}
        <div className="flex flex-wrap gap-3 mb-6">
          <input
            type="text" value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="搜尋代碼或名稱，例如 VOO、高股息"
            className="flex-1 min-w-[220px] bg-transparent border border-white/20 rounded-lg px-4 py-3 text-[15px] text-white placeholder:text-slate-500 focus:outline-none focus:border-[#F5B700]"
          />
          <select value={region} onChange={e => setRegion(e.target.value)}
            className="bg-[#040a18] border border-white/20 rounded-lg px-4 py-3 text-[15px] text-white focus:outline-none focus:border-[#F5B700]">
            <option value="全部">全部地區</option>
            {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={sector} onChange={e => setSector(e.target.value)}
            className="bg-[#040a18] border border-white/20 rounded-lg px-4 py-3 text-[15px] text-white focus:outline-none focus:border-[#F5B700]">
            <option value="全部">全部類型</option>
            {SECTORS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="text-[13px] text-slate-500 mb-3">符合條件：{filtered.length} 檔</div>

        {/* TABLE */}
        <div className="border border-white/10 rounded-2xl overflow-hidden overflow-x-auto">
          <table className="w-full text-left min-w-[1200px]">
            <thead>
              <tr className="bg-white/[0.06] text-slate-300 text-[13px]">
                <th className="px-4 py-4 font-semibold w-[90px]">代碼</th>
                <th className="px-4 py-4 font-semibold">商品名稱</th>
                <th className="px-4 py-4 font-semibold">類型</th>
                <th className="px-4 py-4 font-semibold">配息頻率</th>
                <Th label="每單位配息" k="dividendPerUnit" />
                <Th label="殖利率%" k="dividendYield" />
                <Th label="今年以來%" k="returnYTD" />
                <Th label="近1月%" k="return1m" />
                <Th label="近3月%" k="return3m" />
                <Th label="近6月%" k="return6m" />
                <Th label="近1年%" k="return1y" />
                <Th label="近3年%" k="return3y" />
                <Th label="波動度%" k="volatility" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((etf, i) => (
                <tr key={etf.code}
                  className={`text-[14px] text-white border-t border-white/[0.05] hover:bg-[#F5B700]/[0.06] transition-colors ${i % 2 === 1 ? "bg-white/[0.02]" : ""}`}>
                  <td className="px-4 py-3 font-bold text-[#F5B700]">{etf.code}</td>
                  <td className="px-4 py-3 text-slate-200 max-w-[200px] truncate">{etf.name}</td>
                  <td className="px-4 py-3 text-slate-400 text-[13px]">{etf.sector}</td>
                  <td className="px-4 py-3 text-slate-400 text-[13px]">{etf.dividendFreq}</td>
                  <td className="px-4 py-3">{etf.dividendPerUnit > 0 ? etf.dividendPerUnit.toFixed(2) : "—"}</td>
                  <td className="px-4 py-3">{etf.dividendYield > 0 ? `${etf.dividendYield.toFixed(1)}%` : "—"}</td>
                  <td className="px-4 py-3"><Pct v={etf.returnYTD} /></td>
                  <td className="px-4 py-3"><Pct v={etf.return1m} /></td>
                  <td className="px-4 py-3"><Pct v={etf.return3m} /></td>
                  <td className="px-4 py-3"><Pct v={etf.return6m} /></td>
                  <td className="px-4 py-3"><Pct v={etf.return1y} /></td>
                  <td className="px-4 py-3"><Pct v={etf.return3y} /></td>
                  <td className="px-4 py-3 text-slate-300">{etf.volatility.toFixed(1)}%</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={13} className="px-5 py-12 text-center text-slate-500">
                  找不到符合條件的 ETF
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[12px] text-slate-600 mt-5 leading-relaxed">
          以上資料為示意範例，非即時市場數據，僅供功能展示使用。實際投資請參考發行商公開說明書與即時行情。
        </p>

        <div className="flex justify-center mt-10">
          <Link href="/" className="border border-white/20 text-white px-10 py-3.5 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[16px]">
            回到首頁
          </Link>
        </div>
      </div>
    </main>
  );
}