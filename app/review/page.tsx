// app/review/page.tsx
// SmartMatch Review Mode — 驗收工具，非正式功能
// 每個主要頁面以 iframe 嵌入，方便一次檢視所有頁面

"use client";
import { useState } from "react";
import Link from "next/link";

const PAGES = [
  { key: "home",    label: "首頁",    path: "/",         sections: ["Hero", "Criteria Builder", "Mock Dashboard", "Comparison", "Why SmartMatch", "Ranking", "Markets", "Footer"] },
  { key: "etf",     label: "ETF",     path: "/etf",      sections: ["Navbar", "Ranking", "Filter Bar", "ETF Table", "Compare Bar"] },
  { key: "funds",   label: "基金",    path: "/funds",    sections: ["Navbar", "Ranking", "Filter Bar", "Fund Table", "Chart", "Compare Bar"] },
  { key: "markets", label: "Markets", path: "/markets",  sections: ["Navbar", "Market Overview", "Index Cards"] },
  { key: "compare", label: "Compare", path: "/compare",  sections: ["Navbar", "Compare Table"] },
  { key: "quiz",    label: "Quiz",    path: "/quiz",     sections: ["Navbar", "Quiz Flow"] },
  { key: "report",  label: "Report",  path: "/report",   sections: ["Navbar", "Report Content"] },
];

export default function ReviewPage() {
  const [active, setActive] = useState("home");
  const [viewMode, setViewMode] = useState<"single" | "all">("single");

  const currentPage = PAGES.find(p => p.key === active) ?? PAGES[0];

  return (
    <div className="min-h-screen bg-[#0a0f1e] text-white font-sans">

      {/* ── Review Navbar ── */}
      <div className="fixed top-0 left-0 w-full z-50 bg-[#020817] border-b border-white/[0.1] shadow-xl">
        <div className="flex items-center h-14 px-6 gap-6">

          {/* Logo */}
          <div className="shrink-0">
            <span className="text-[16px] font-black text-white">Smart<span className="text-[#F5B700]">Match</span></span>
            <span className="ml-2 text-[11px] font-bold text-[#F5B700] bg-[#F5B700]/10 px-2 py-0.5 rounded tracking-wider">REVIEW MODE</span>
          </div>

          {/* Page Nav */}
          <div className="flex items-center gap-1 flex-1">
            {PAGES.map(p => (
              <button key={p.key}
                onClick={() => { setActive(p.key); setViewMode("single"); }}
                className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-all ${
                  active === p.key && viewMode === "single"
                    ? "bg-[#F5B700] text-[#020817]"
                    : "text-slate-400 hover:text-white hover:bg-white/[0.06]"
                }`}>
                {p.label}
              </button>
            ))}
          </div>

          {/* View mode toggle */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setViewMode("single")}
              className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-all ${viewMode === "single" ? "bg-white/10 text-white" : "text-slate-500 hover:text-slate-300"}`}>
              單頁
            </button>
            <button
              onClick={() => setViewMode("all")}
              className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-all ${viewMode === "all" ? "bg-white/10 text-white" : "text-slate-500 hover:text-slate-300"}`}>
              全覽
            </button>
            <div className="w-px h-6 bg-white/10 mx-1" />
            <Link href="/" target="_blank"
              className="text-[12px] text-slate-400 hover:text-white border border-white/10 hover:border-white/30 px-3 py-1.5 rounded-lg transition-all">
              開啟正式網站 ↗
            </Link>
          </div>
        </div>

        {/* Section breadcrumb */}
        {viewMode === "single" && (
          <div className="flex items-center gap-2 px-6 py-2 bg-white/[0.02] border-t border-white/[0.05] overflow-x-auto">
            <span className="text-[11px] text-slate-600 shrink-0">Sections：</span>
            {currentPage.sections.map(s => (
              <span key={s} className="text-[11px] text-slate-400 bg-white/[0.04] border border-white/[0.06] px-2 py-0.5 rounded shrink-0">
                {s}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Single Page View ── */}
      {viewMode === "single" && (
        <div className="pt-[88px]">
          <div className="flex items-center justify-between px-6 py-3 bg-[#060d1b] border-b border-white/[0.06]">
            <div className="text-[13px] text-slate-400">
              <span className="font-bold text-white">{currentPage.label}</span>
              <span className="ml-2 text-slate-600">{currentPage.path}</span>
            </div>
            <a href={currentPage.path} target="_blank"
              className="text-[12px] text-[#F5B700] hover:underline">
              在新分頁開啟 ↗
            </a>
          </div>
          <iframe
            src={currentPage.path}
            className="w-full border-0"
            style={{ height: "calc(100vh - 120px)", minHeight: "800px" }}
            title={`Review: ${currentPage.label}`}
          />
        </div>
      )}

      {/* ── All Pages View ── */}
      {viewMode === "all" && (
        <div className="pt-[56px]">
          <div className="px-6 py-4 bg-[#060d1b] border-b border-white/[0.06]">
            <div className="text-[13px] text-slate-400">
              全覽模式 — 所有頁面同時載入，捲動查看
            </div>
          </div>
          <div className="space-y-8 p-6">
            {PAGES.map(p => (
              <div key={p.key} data-review={p.key}>
                {/* Section header */}
                <div className="flex items-center gap-4 mb-3">
                  <div className="text-[15px] font-bold text-white">{p.label}</div>
                  <div className="text-[12px] text-slate-500">{p.path}</div>
                  <div className="flex gap-1.5">
                    {p.sections.map(s => (
                      <span key={s} className="text-[10px] text-slate-500 bg-white/[0.04] border border-white/[0.06] px-1.5 py-0.5 rounded">
                        {s}
                      </span>
                    ))}
                  </div>
                  <a href={p.path} target="_blank"
                    className="ml-auto text-[12px] text-[#F5B700] hover:underline shrink-0">
                    開啟 ↗
                  </a>
                </div>
                {/* iframe */}
                <div className="rounded-2xl overflow-hidden border border-white/[0.08] shadow-xl">
                  <iframe
                    src={p.path}
                    className="w-full border-0"
                    style={{ height: "900px" }}
                    title={`Review: ${p.label}`}
                    loading="eager"
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="px-6 py-8 text-center border-t border-white/[0.06]">
            <div className="text-[12px] text-slate-600">
              SmartMatch Review Mode · 僅供驗收用途 · 非正式功能
            </div>
          </div>
        </div>
      )}
    </div>
  );
}