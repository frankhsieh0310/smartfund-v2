"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ETF_LIST, REGIONS, SECTORS, type Etf } from "./data";

type SortKey = "expenseRatio" | "dividendYield" | "aum" | "return1y";
type SortDir = "asc" | "desc";

export default function EtfDatabasePage() {
  const [keyword, setKeyword] = useState("");
  const [region, setRegion] = useState("全部");
  const [sector, setSector] = useState("全部");
  const [sortKey, setSortKey] = useState<SortKey>("aum");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const filtered = useMemo(() => {
    let list: Etf[] = ETF_LIST;

    if (keyword.trim()) {
      const kw = keyword.trim().toLowerCase();
      list = list.filter(
        (e) =>
          e.code.toLowerCase().includes(kw) ||
          e.name.toLowerCase().includes(kw)
      );
    }

    if (region !== "全部") {
      list = list.filter((e) => e.region === region);
    }

    if (sector !== "全部") {
      list = list.filter((e) => e.sector === sector);
    }

    const sorted = [...list].sort((a, b) => {
      const diff = a[sortKey] - b[sortKey];
      return sortDir === "asc" ? diff : -diff;
    });

    return sorted;
  }, [keyword, region, sector, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  return (
    <main className="min-h-screen bg-white px-6 py-20">
      <div className="max-w-[1280px] mx-auto">

        <div className="mb-10">
          <div className="tracking-[10px] text-[#F5B700] text-[16px] font-semibold mb-4">
            SMARTMATCH
          </div>
          <h1 className="text-[44px] font-black text-[#0B1220]">
            ETF 資料庫
          </h1>
          <p className="text-[16px] text-slate-500 mt-2">
            共 {ETF_LIST.length} 檔 ETF，支援搜尋、篩選與排序
          </p>
        </div>

        {/* SEARCH + FILTERS */}
        <div className="flex flex-wrap gap-4 mb-8">

          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜尋代碼或名稱，例如 VOO"
            className="flex-1 min-w-[240px] border border-slate-300 rounded-lg px-5 py-3 text-[16px] text-[#0B1220] placeholder:text-slate-400 focus:outline-none focus:border-[#F5B700]"
          />

          <select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className="border border-slate-300 rounded-lg px-4 py-3 text-[16px] text-[#0B1220] focus:outline-none focus:border-[#F5B700]"
          >
            <option value="全部">全部地區</option>
            {REGIONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>

          <select
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            className="border border-slate-300 rounded-lg px-4 py-3 text-[16px] text-[#0B1220] focus:outline-none focus:border-[#F5B700]"
          >
            <option value="全部">全部產業</option>
            {SECTORS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

        </div>

        <div className="text-[14px] text-slate-500 mb-4">
          符合條件：{filtered.length} 檔
        </div>

        {/* TABLE */}
        <div className="border border-slate-200 rounded-2xl overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-[#0B1220] text-white text-[14px]">
                <th className="px-5 py-4 font-semibold">代碼</th>
                <th className="px-5 py-4 font-semibold">名稱</th>
                <th className="px-5 py-4 font-semibold">地區</th>
                <th className="px-5 py-4 font-semibold">產業</th>
                <SortableHeader
                  label="費用率"
                  active={sortKey === "expenseRatio"}
                  dir={sortDir}
                  onClick={() => handleSort("expenseRatio")}
                />
                <SortableHeader
                  label="殖利率"
                  active={sortKey === "dividendYield"}
                  dir={sortDir}
                  onClick={() => handleSort("dividendYield")}
                />
                <SortableHeader
                  label="規模(億美元)"
                  active={sortKey === "aum"}
                  dir={sortDir}
                  onClick={() => handleSort("aum")}
                />
                <SortableHeader
                  label="近一年報酬率"
                  active={sortKey === "return1y"}
                  dir={sortDir}
                  onClick={() => handleSort("return1y")}
                />
              </tr>
            </thead>
            <tbody>
              {filtered.map((etf, i) => (
                <tr
                  key={etf.code}
                  className={`text-[15px] text-[#0B1220] ${
                    i % 2 === 1 ? "bg-slate-50" : "bg-white"
                  } hover:bg-[#F5B700]/10 transition-colors`}
                >
                  <td className="px-5 py-3 font-bold">{etf.code}</td>
                  <td className="px-5 py-3 text-slate-600">{etf.name}</td>
                  <td className="px-5 py-3 text-slate-600">{etf.region}</td>
                  <td className="px-5 py-3 text-slate-600">{etf.sector}</td>
                  <td className="px-5 py-3">{etf.expenseRatio.toFixed(2)}%</td>
                  <td className="px-5 py-3">{etf.dividendYield.toFixed(1)}%</td>
                  <td className="px-5 py-3">{etf.aum.toLocaleString()}</td>
                  <td
                    className={`px-5 py-3 font-semibold ${
                      etf.return1y >= 0 ? "text-green-600" : "text-red-500"
                    }`}
                  >
                    {etf.return1y >= 0 ? "+" : ""}
                    {etf.return1y.toFixed(1)}%
                  </td>
                </tr>
              ))}

              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-slate-400">
                    找不到符合條件的 ETF，請調整搜尋或篩選條件
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[13px] text-slate-400 mt-6 leading-relaxed">
          以上資料為示意範例，非即時市場數據，僅供功能展示使用。實際投資請參考發行商公開說明書與即時行情。
        </p>

        <div className="flex justify-center mt-12">
          <Link
            href="/"
            className="border border-slate-300 text-[#0B1220] px-10 py-4 rounded-lg hover:bg-slate-50 transition-colors font-semibold text-[18px]"
          >
            回到首頁
          </Link>
        </div>

      </div>
    </main>
  );
}

function SortableHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <th
      onClick={onClick}
      className="px-5 py-4 font-semibold cursor-pointer select-none hover:text-[#F5B700] transition-colors"
    >
      <span className="flex items-center gap-1">
        {label}
        <span className="text-[11px] opacity-70">
          {active ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </span>
    </th>
  );
}