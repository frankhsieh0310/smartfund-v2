"use client";
// ============================================================
// app/page.tsx
// SmartMatch 首頁
// 只保留：import、Navbar、component 組合
// 目標行數 < 80 行
// ============================================================

import Link from "next/link";
import { HeroSection }              from "@/components/home/HeroSection";
import { CriteriaBuilderSection }   from "@/components/home/CriteriaBuilderSection";
import { WorkspacePreviewSection }  from "@/components/home/WorkspacePreviewSection";
import { MarketOverviewSection }    from "@/components/home/MarketOverviewSection";
import { FeaturesSection }          from "@/components/home/FeaturesSection";

export default function Home() {
  return (
    <main className="min-h-screen">

      {/* ══ NAVBAR ══════════════════════════════════════════════════ */}
      <header className="fixed top-0 left-0 w-full z-50 bg-[#040a18]/90 backdrop-blur-xl border-b border-white/[0.08]">
        <div className="max-w-[1600px] mx-auto h-20 px-10 flex items-center justify-between">
          <div>
            <div className="text-[32px] font-black text-white leading-none">Smart<span className="text-[#F5B700]">Match</span></div>
            <div className="text-[12px] text-slate-400 mt-0.5">Investment Intelligence Platform</div>
          </div>
          <nav className="hidden lg:flex gap-8 text-[18px] font-semibold text-slate-300">
            <Link href="/quiz"    className="hover:text-white transition-colors">投資人格分析</Link>
            <Link href="/etf"     className="hover:text-white transition-colors">ETF篩選器</Link>
            <Link href="/funds"   className="hover:text-white transition-colors">基金篩選器</Link>
            <Link href="/markets" className="hover:text-white transition-colors">市場中心</Link>
            <Link href="/clients" className="hover:text-white transition-colors">客戶管理</Link>
            <Link href="/pricing" className="hover:text-[#F5B700] transition-colors">方案</Link>
          </nav>
          <div className="flex items-center gap-4">
            <a href="#" className="text-[16px] font-semibold text-slate-300 border border-white/30 px-5 py-2.5 rounded-lg hover:bg-white/10 transition-colors">登入</a>
            <Link href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-6 py-2.5 rounded-lg font-bold text-[16px] transition-colors">開始建立</Link>
          </div>
        </div>
      </header>

      {/* ══ SECTIONS ══════════════════════════════════════════════ */}
      <HeroSection />
      <CriteriaBuilderSection />
      <WorkspacePreviewSection />
      <MarketOverviewSection />
      <FeaturesSection />

    </main>
  );
}