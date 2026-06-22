"use client";

import Link from "next/link";
import { useState } from "react";

export default function Home() {
  return (
    <main className="min-h-screen bg-[#0a0f1e] overflow-hidden">

      {/* NAVBAR */}
      <header className="fixed top-0 left-0 w-full z-50 bg-[#0a0f1e]/90 backdrop-blur-xl border-b border-white/10">
        <div className="max-w-[1700px] mx-auto h-20 px-10 flex items-center justify-between">
          <div>
            <div className="text-[36px] font-black text-white leading-none">
              Smart<span className="text-[#F5B700]">Match</span>
            </div>
            <div className="text-[12px] text-slate-400 mt-0.5">ETF & 基金資產配置分析平台</div>
          </div>

          <nav className="hidden lg:flex gap-8 text-[15px] font-semibold text-slate-300">
            <Link href="/quiz" className="hover:text-white transition-colors">投資人格分析</Link>
            <Link href="/etf" className="hover:text-white transition-colors">ETF篩選器</Link>
            <Link href="/funds" className="hover:text-white transition-colors">基金篩選器</Link>
            <Link href="/compare" className="hover:text-white transition-colors">比較中心</Link>
            <Link href="/clients" className="hover:text-white transition-colors">客戶管理</Link>
          </nav>

          <div className="flex items-center gap-4">
            <a href="#" className="text-[15px] font-semibold text-slate-300 border border-white/30 px-5 py-2.5 rounded-lg hover:bg-white/10 transition-colors">登入</a>
            <Link href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-6 py-2.5 rounded-lg font-bold text-[15px] transition-colors">
              免費註冊
            </Link>
          </div>
        </div>
      </header>

      {/* HERO — V4.3 金融大樓背景 + 主標玻璃卡片 + 金色光暈 */}
      <section className="relative min-h-screen overflow-hidden">

        {/* 第一層：金融大樓背景 */}
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            backgroundImage: "url('https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=2600')",
          }}
        />

        {/* 第二層：深藍遮罩 */}
        <div className="absolute inset-0 bg-[#081120]/50" />

        {/* 第三層：左側深藍漸層（不是整塊毛玻璃） */}
        <div className="absolute inset-y-0 left-0 w-[55%] bg-gradient-to-r from-[#081120]/75 via-[#081120]/45 to-transparent" />

        {/* 第四層：金色光暈 */}
        <div className="absolute top-40 left-20 w-[500px] h-[500px] rounded-full bg-[#F5B700] opacity-[0.06] blur-[140px]" />

        {/* Content */}
        <div className="relative z-10 max-w-[1700px] mx-auto px-10 flex items-center min-h-screen pt-20">
          <div className="grid lg:grid-cols-[50%_50%] w-full items-center gap-8 py-20">

            {/* LEFT — 只有主標區有玻璃卡片 */}
            <div className="space-y-8">
              <div className="tracking-[14px] text-[#F5B700] text-[18px] font-semibold">
                SMARTMATCH
              </div>

              {/* 主標玻璃卡片 */}
              <div className="inline-block py-6 px-10 rounded-[32px] backdrop-blur-md bg-white/[0.06] border border-white/10">
                <h1 className="text-[72px] font-black leading-[1.1] text-white tracking-[0.01em] max-w-[900px]">
                  讓投資決策更有系統
                </h1>
              </div>

              <p className="text-[28px] leading-[1.7] font-medium text-white/80 max-w-[640px]">
                整合投資人格分析、
                <br />
                商品比較、客戶管理與資產配置工具，
                <br />
                <br />
                協助投資人建立更清晰的投資流程。
              </p>

              <div className="flex gap-5">
                <Link
                  href="/quiz"
                  className="bg-[#F5B700] hover:bg-[#e0a800] text-black px-12 py-5 rounded-lg font-bold text-[22px] transition-colors"
                >
                  開始投資人格分析
                </Link>
                <Link
                  href="/etf"
                  className="bg-white/10 backdrop-blur-md border border-white/10 text-white px-12 py-5 rounded-lg hover:bg-white/20 transition-colors font-semibold text-[22px]"
                >
                  瀏覽資料庫
                </Link>
              </div>

              {/* 可信度數字 */}
              <div className="flex gap-10">
                {[
                  ["500+", "ETF 資料"],
                  ["3,000+", "基金資料"],
                  ["50+", "投信公司"],
                  ["10年+", "歷史資料"],
                ].map(([num, label]) => (
                  <div key={label}>
                    <div className="text-[36px] font-bold text-[#F5B700] leading-none">{num}</div>
                    <div className="text-[13px] text-white/50 mt-1">{label}</div>
                  </div>
                ))}
              </div>

            </div>

            {/* RIGHT — Dashboard 卡片 */}
            <div className="grid grid-cols-2 gap-4">

              {/* 市場概覽 */}
              <div className="bg-[#0B1220]/70 backdrop-blur-xl border border-white/10 rounded-[32px] p-8 text-white shadow-[0_40px_120px_rgba(0,0,0,0.45)]">
                <div className="flex justify-between items-center mb-6">
                  <div className="font-bold text-[22px]">市場概覽</div>
                  <div className="text-[13px] text-slate-400">即時更新 15:30</div>
                </div>
                <div className="space-y-5 text-[17px]">
                  {[
                    ["S&P 500", "+0.68%", true],
                    ["NASDAQ", "+0.85%", true],
                    ["DOW JONES", "+0.53%", true],
                    ["MSCI ACWI", "+0.62%", true],
                    ["VIX", "-1.19%", false],
                  ].map(([name, val, up]) => (
                    <div key={name as string} className="flex justify-between">
                      <span className="text-slate-300">{name as string}</span>
                      <span className={up ? "text-green-400 font-semibold" : "text-red-400 font-semibold"}>{val as string}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* 資產配置分析 */}
              <div className="bg-[#0B1220]/70 backdrop-blur-xl border border-white/10 rounded-[32px] p-8 text-white shadow-[0_40px_120px_rgba(0,0,0,0.45)]">
                <div className="font-bold text-[22px] mb-6">資產配置分析</div>
                <div className="flex items-center justify-center mb-5">
                  <svg viewBox="0 0 120 120" className="w-28 h-28">
                    <circle cx="60" cy="60" r="44" fill="none" stroke="#1e2a3a" strokeWidth="20" />
                    <circle cx="60" cy="60" r="44" fill="none" stroke="#F5B700" strokeWidth="20"
                      strokeDasharray="179 277" strokeDashoffset="69" />
                    <circle cx="60" cy="60" r="44" fill="none" stroke="#94a3b8" strokeWidth="20"
                      strokeDasharray="55 401" strokeDashoffset="-110" />
                    <circle cx="60" cy="60" r="44" fill="none" stroke="#334155" strokeWidth="20"
                      strokeDasharray="41 415" strokeDashoffset="-165" />
                  </svg>
                </div>
                <div className="space-y-2.5 text-[15px]">
                  {[["#F5B700","股票","65%"],["#94a3b8","債券","20%"],["#334155","現金","15%"]].map(([c,l,p])=>(
                    <div key={l} className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <span className="w-3 h-3 rounded-full" style={{backgroundColor:c}}/>
                        <span className="text-slate-300">{l}</span>
                      </div>
                      <span className="font-bold">{p}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* 投資組合績效 */}
              <div className="bg-[#0B1220]/70 backdrop-blur-xl border border-white/10 rounded-[32px] p-8 text-white shadow-[0_40px_120px_rgba(0,0,0,0.45)]">
                <div className="font-bold text-[22px] mb-1">投資組合績效</div>
                <div className="text-[13px] text-slate-400 mb-5">年化報酬率</div>
                <div className="text-[56px] font-black text-[#F5B700] leading-none mb-5">8.47%</div>
                <svg viewBox="0 0 200 60" className="w-full h-12">
                  <defs>
                    <linearGradient id="perfGlow" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#F5B700" stopOpacity="0.35"/>
                      <stop offset="100%" stopColor="#F5B700" stopOpacity="0"/>
                    </linearGradient>
                  </defs>
                  <polygon points="0,60 0,50 25,42 50,46 75,35 100,38 125,28 150,32 175,18 200,12 200,60" fill="url(#perfGlow)"/>
                  <polyline points="0,50 25,42 50,46 75,35 100,38 125,28 150,32 175,18 200,12"
                    fill="none" stroke="#F5B700" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>

              {/* ETF 熱門排行 */}
              <div className="bg-[#0B1220]/70 backdrop-blur-xl border border-white/10 rounded-[32px] p-8 text-white shadow-[0_40px_120px_rgba(0,0,0,0.45)]">
                <div className="font-bold text-[22px] mb-6">ETF 熱門排行</div>
                <div className="space-y-4 text-[15px]">
                  {[
                    ["VG","VOO","+0.63%","#e67e22"],
                    ["IN","QQQ","+0.85%","#2980b9"],
                    ["VG","VTI","+0.59%","#e67e22"],
                    ["VG","VXUS","+0.31%","#e67e22"],
                    ["VG","BND","+0.21%","#27ae60"],
                  ].map(([abbr,code,val,color])=>(
                    <div key={code as string} className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white" style={{backgroundColor:color as string}}>{abbr}</span>
                        <span className="font-semibold">{code as string}</span>
                      </div>
                      <span className="text-green-400 font-semibold">{val as string}</span>
                    </div>
                  ))}
                </div>
              </div>

            </div>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section className="bg-[#0a0f1e] py-32 border-t border-white/10">
        <div className="max-w-[1400px] mx-auto px-10">
          <div className="text-center mb-16">
            <div className="text-[16px] tracking-[10px] text-[#F5B700] font-semibold mb-4">FEATURES</div>
            <h2 className="text-[56px] font-black text-white">核心功能</h2>
          </div>
          <div className="grid grid-cols-4 gap-6">
            {[
              { icon: "👤", title: "投資人格分析", desc: "20題問卷精準評估風險屬性，自動產生個人化配置建議", href: "/quiz" },
              { icon: "📊", title: "ETF / 基金資料庫", desc: "95檔ETF＋270檔基金，完整搜尋篩選與排序功能", href: "/etf" },
              { icon: "⚖️", title: "ETF＋基金比較中心", desc: "台灣唯一可同時比較ETF與基金的分析工具", href: "/compare" },
              { icon: "👥", title: "客戶管理 CRM", desc: "理專專屬客戶管理，支援PDF報告一鍵匯出", href: "/clients" },
            ].map((f) => (
              <Link key={f.title} href={f.href}
                className="bg-white/[0.05] border border-white/10 rounded-2xl p-8 hover:bg-white/[0.09] hover:border-[#F5B700]/40 transition-all group">
                <div className="text-[40px] mb-4">{f.icon}</div>
                <div className="text-[20px] font-bold text-white mb-3 group-hover:text-[#F5B700] transition-colors">{f.title}</div>
                <div className="text-[15px] text-slate-400 leading-relaxed">{f.desc}</div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* PERSONALITY TYPES */}
      <section className="bg-[#060d1f] py-32 border-t border-white/10">
        <div className="max-w-[1400px] mx-auto px-10">
          <div className="text-center mb-16">
            <div className="text-[16px] tracking-[10px] text-[#F5B700] font-semibold mb-4">PERSONALITY</div>
            <h2 className="text-[56px] font-black text-white">四大投資人格</h2>
          </div>
          <div className="grid grid-cols-4 gap-5">
            {[
              { tag: "保守型", risk: "★★☆☆☆", desc: "重視穩定收益，以債券與現金為主", color: "#64748b" },
              { tag: "穩健型", risk: "★★★☆☆", desc: "股債均衡配置，追求長期穩健成長", color: "#3b82f6" },
              { tag: "成長型", risk: "★★★★☆", desc: "偏重股票配置，接受中等波動", color: "#F5B700" },
              { tag: "積極型", risk: "★★★★★", desc: "高度成長導向，承受較大短期波動", color: "#ef4444" },
            ].map((p) => (
              <div key={p.tag} className="bg-white/[0.05] border border-white/10 rounded-2xl p-7 hover:border-white/20 transition-all">
                <div className="inline-block px-3 py-1 rounded-full text-[13px] font-bold text-white mb-4" style={{ backgroundColor: p.color + "33", border: `1px solid ${p.color}55`, color: p.color }}>
                  {p.tag}
                </div>
                <div className="text-[#F5B700] text-[16px] mb-3">{p.risk}</div>
                <div className="text-[15px] text-slate-400 leading-relaxed">{p.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="bg-[#0a0f1e] py-32 border-t border-white/10">
        <div className="max-w-[1400px] mx-auto px-10">
          <div className="text-center mb-16">
            <div className="text-[16px] tracking-[10px] text-[#F5B700] font-semibold mb-4">HOW IT WORKS</div>
            <h2 className="text-[56px] font-black text-white">投資流程</h2>
          </div>
          <div className="grid grid-cols-4 gap-6">
            {[
              { step: "STEP 1", title: "投資人格分析", desc: "了解風險偏好與投資屬性", icon: "🧠" },
              { step: "STEP 2", title: "ETF / 基金篩選", desc: "依條件快速比較標的", icon: "🔍" },
              { step: "STEP 3", title: "資產配置分析", desc: "生成專屬投資組合", icon: "📈" },
              { step: "STEP 4", title: "產生投資報告", desc: "可執行的長期策略", icon: "📄" },
            ].map((s, i) => (
              <div key={s.step} className="relative">
                {i < 3 && <div className="absolute top-8 left-[calc(100%-24px)] w-12 h-0.5 bg-[#F5B700]/30 z-10 hidden lg:block" />}
                <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-7 text-center">
                  <div className="text-[11px] tracking-[4px] text-[#F5B700] font-semibold mb-3">{s.step}</div>
                  <div className="text-[36px] mb-4">{s.icon}</div>
                  <div className="text-[18px] font-bold text-white mb-2">{s.title}</div>
                  <div className="text-[14px] text-slate-400">{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section className="bg-[#060d1f] py-32 border-t border-white/10" id="pricing">
        <div className="max-w-[1400px] mx-auto px-10">

          <div className="text-center mb-16">
            <div className="text-[16px] tracking-[10px] text-[#F5B700] font-semibold mb-4">PRICING</div>
            <h2 className="text-[56px] font-black text-white">選擇適合你的方案</h2>
            <p className="text-[18px] text-slate-400 mt-4">從免費開始，隨時升級。所有方案均含核心分析功能。</p>
          </div>

          {/* 五方案卡片 */}
          <div className="grid grid-cols-5 gap-4 mb-12">

            {/* FREE */}
            <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-6 flex flex-col">
              <div className="text-[12px] font-semibold text-slate-400 tracking-[2px] mb-3">免費版</div>
              <div className="text-[40px] font-black text-white leading-none mb-1">$0</div>
              <div className="text-[13px] text-slate-500 mb-6">永久免費</div>
              <div className="flex flex-col gap-2.5 flex-1 mb-6">
                <PF text="人格分析（無限次）" />
                <PF text="客戶管理（10 位）" />
                <PF text="ETF / 基金資料庫" />
                <PF text="5 檔走勢比較" />
                <PF text="PDF（每月1份）" />
                <PFN text="客戶標籤" />
                <PFN text="混合分析" />
              </div>
              <a href="/clients" className="block text-center border border-white/20 text-white py-2.5 rounded-xl font-semibold text-[14px] hover:bg-white/10 transition-colors">
                免費開始
              </a>
            </div>

            {/* LITE */}
            <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-6 flex flex-col">
              <div className="text-[12px] font-semibold text-slate-400 tracking-[2px] mb-3">Lite</div>
              <div className="text-[40px] font-black text-white leading-none mb-1">NT$99</div>
              <div className="text-[13px] text-slate-500 mb-6">每月</div>
              <div className="flex flex-col gap-2.5 flex-1 mb-6">
                <PF text="人格分析（無限次）" />
                <PF text="客戶管理（30 位）" />
                <PF text="ETF / 基金資料庫" />
                <PF text="10 檔走勢比較" />
                <PF text="PDF（每月20份）" />
                <PF text="客戶標籤" />
                <PFN text="混合分析" />
              </div>
              <button onClick={() => alert("付款功能即將推出，我們會第一時間通知您。")}
                className="block w-full text-center border border-white/20 text-white py-2.5 rounded-xl font-semibold text-[14px] hover:bg-white/10 transition-colors">
                選擇 Lite
              </button>
            </div>

            {/* PRO */}
            <div className="bg-[#F5B700]/10 border-2 border-[#F5B700] rounded-2xl p-6 flex flex-col relative">
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-[#F5B700] text-[#0B1220] text-[11px] font-bold px-3 py-1.5 rounded-full whitespace-nowrap">
                主力方案
              </div>
              <div className="text-[12px] font-semibold text-[#F5B700] tracking-[2px] mb-3">Pro</div>
              <div className="text-[40px] font-black text-white leading-none mb-1">NT$299</div>
              <div className="text-[13px] text-slate-400 mb-6">每月</div>
              <div className="flex flex-col gap-2.5 flex-1 mb-6">
                <PF text="人格分析（無限次）" />
                <PF text="客戶管理（100 位）" />
                <PF text="ETF / 基金資料庫" />
                <PF text="20 檔走勢比較" />
                <PF text="無限 PDF 匯出" />
                <PF text="客戶標籤" />
                <PF text="ETF＋基金混合分析" />
              </div>
              <button onClick={() => alert("付款功能即將推出，我們會第一時間通知您。")}
                className="block w-full text-center bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] py-2.5 rounded-xl font-bold text-[14px] transition-colors">
                選擇 Pro
              </button>
            </div>

            {/* ADVISOR */}
            <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-6 flex flex-col">
              <div className="text-[12px] font-semibold text-slate-400 tracking-[2px] mb-3">Advisor</div>
              <div className="text-[40px] font-black text-white leading-none mb-1">NT$599</div>
              <div className="text-[13px] text-slate-500 mb-6">每月</div>
              <div className="flex flex-col gap-2.5 flex-1 mb-6">
                <PF text="Pro 全部功能" />
                <PF text="客戶管理（500 位）" />
                <PF text="無限走勢比較" />
                <PF text="商品重疊度分析" />
                <PF text="組合回測分析" />
                <PF text="理專儀表板" />
                <PFN text="多人帳號" />
              </div>
              <button onClick={() => alert("付款功能即將推出，我們會第一時間通知您。")}
                className="block w-full text-center border border-white/20 text-white py-2.5 rounded-xl font-semibold text-[14px] hover:bg-white/10 transition-colors">
                選擇 Advisor
              </button>
            </div>

            {/* TEAM */}
            <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-6 flex flex-col">
              <div className="text-[12px] font-semibold text-[#F5B700] tracking-[2px] mb-3">Team</div>
              <div className="text-[40px] font-black text-white leading-none mb-1">NT$1,499</div>
              <div className="text-[13px] text-slate-500 mb-6">每月</div>
              <div className="flex flex-col gap-2.5 flex-1 mb-6">
                <PF text="Advisor 全部功能" />
                <PF text="客戶管理（無限）" />
                <PF text="多人帳號（5人起）" />
                <PF text="客戶共享" />
                <PF text="理專主管儀表板" />
                <PF text="優先客服支援" />
                <PF text="客製化報告模板" />
              </div>
              <button onClick={() => alert("請聯繫我們取得團隊版方案。")}
                className="block w-full text-center border border-[#F5B700]/50 text-[#F5B700] py-2.5 rounded-xl font-bold text-[14px] hover:bg-[#F5B700]/10 transition-colors">
                聯繫我們
              </button>
            </div>

          </div>

          {/* 功能對比表 */}
          <div className="border border-white/10 rounded-2xl overflow-hidden mb-10">
            <table className="w-full text-left text-[14px]">
              <thead>
                <tr className="bg-white/[0.05] border-b border-white/10">
                  <th className="px-5 py-4 font-bold text-white w-[28%]">功能</th>
                  <th className="px-4 py-4 font-bold text-slate-400 text-center">免費</th>
                  <th className="px-4 py-4 font-bold text-slate-400 text-center">Lite</th>
                  <th className="px-4 py-4 font-bold text-[#F5B700] text-center">Pro</th>
                  <th className="px-4 py-4 font-bold text-slate-400 text-center">Advisor</th>
                  <th className="px-4 py-4 font-bold text-slate-400 text-center">Team</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["客戶管理", "10位", "30位", "100位", "500位", "無限", true],
                  ["投資人格分析", "無限", "無限", "無限", "無限", "無限"],
                  ["ETF/基金資料庫", "✓", "✓", "✓", "✓", "✓", true],
                  ["走勢比較", "5檔", "10檔", "20檔", "無限", "無限"],
                  ["PDF報告", "1份/月", "20份/月", "無限", "無限", "無限", true],
                  ["客戶標籤", "✗", "✓", "✓", "✓", "✓"],
                  ["ETF+基金混合分析", "✗", "✗", "✓", "✓", "✓", true],
                  ["商品重疊分析", "✗", "✗", "✗", "✓", "✓"],
                  ["組合回測", "✗", "✗", "✗", "✓", "✓", true],
                  ["多人帳號", "✗", "✗", "✗", "✗", "5人起"],
                  ["客戶共享", "✗", "✗", "✗", "✗", "✓", true],
                ].map(([label, free, lite, pro, advisor, team, highlight], i) => (
                  <tr key={i} className={`border-b border-white/[0.06] ${highlight ? "bg-white/[0.03]" : ""}`}>
                    <td className="px-5 py-3 font-medium text-slate-300">{label}</td>
                    <td className={`px-4 py-3 text-center ${free === "✗" ? "text-slate-600" : "text-slate-400"}`}>{free}</td>
                    <td className={`px-4 py-3 text-center ${lite === "✗" ? "text-slate-600" : "text-slate-400"}`}>{lite}</td>
                    <td className={`px-4 py-3 text-center font-semibold ${pro === "✗" ? "text-slate-600" : "text-white"}`}>{pro}</td>
                    <td className={`px-4 py-3 text-center ${advisor === "✗" ? "text-slate-600" : "text-slate-400"}`}>{advisor}</td>
                    <td className={`px-4 py-3 text-center ${team === "✗" ? "text-slate-600" : "text-slate-400"}`}>{team}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="text-center">
            <a href="/pricing" className="inline-block border border-white/20 text-white px-10 py-4 rounded-lg hover:bg-white/10 transition-colors font-semibold text-[16px]">
              查看完整方案說明 →
            </a>
          </div>

        </div>
      </section>

      {/* FOOTER */}
      <footer className="bg-[#030810] border-t border-white/10 py-12">
        <div className="max-w-[1400px] mx-auto px-10 flex items-center justify-between">
          <div>
            <div className="text-[24px] font-black text-white">Smart<span className="text-[#F5B700]">Match</span></div>
            <div className="text-[13px] text-slate-500 mt-1">ETF & 基金資產配置分析平台</div>
          </div>
          <div className="text-[13px] text-slate-500">
            以上資料為示意範例，不構成投資建議。© 2026 SmartMatch
          </div>
        </div>
      </footer>

    </main>
  );
}

function PF({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-[13px] text-slate-300">
      <span className="text-green-400 mt-0.5 shrink-0">✓</span>{text}
    </div>
  );
}

function PFN({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-[13px] text-slate-600">
      <span className="mt-0.5 shrink-0">✗</span>{text}
    </div>
  );
}