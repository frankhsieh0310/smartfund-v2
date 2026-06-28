"use client";
// ============================================================
// components/home/HeroSection.tsx
// 首頁 Hero Section（ZONE 1 + ZONE 2 個人化展示）
// 從 app/page.tsx 拆出，不修改任何 UI 或邏輯
// ============================================================

import Link from "next/link";

export function HeroSection() {
  return (
    <>
      {/* ══ ZONE 1：HERO ════════════════════════════════════════════ */}
      <section className="relative z-10 min-h-screen">
        {/* Overlay 35~40% */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#020817]/50 via-[#020817]/20 to-transparent z-[1]" />
        <div className="relative z-10 max-w-[1600px] mx-auto px-10 flex items-center min-h-screen pt-20">
          <div className="grid lg:grid-cols-[50%_50%] w-full items-center gap-12 py-16">

            {/* LEFT */}
            <div className="space-y-7">
              <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold">SMARTMATCH</div>

              <div>
                <h1 className="text-[56px] font-black leading-[1.12] text-white mb-5">
                  打造屬於你的<br />
                  <span className="text-[#F5B700]">投資儀表板</span>
                </h1>
                <p className="text-[22px] text-white/70 leading-[1.8] max-w-[500px]">
                  建立你自己的投資條件，保存下來，讓市場每天幫你找出符合條件的 ETF 與基金。
                </p>
                {/* Task 9: 三個核心價值 */}
                <div className="flex flex-wrap gap-3 mt-5">
                  {["建立投資條件", "保存，隨時重新執行", "ETF + 基金一次搜尋"].map(v => (
                    <span key={v} className="flex items-center gap-1.5 text-[14px] text-white/60 bg-white/[0.07] border border-white/[0.12] px-3 py-1.5 rounded-full">
                      <span className="text-[#F5B700]">✓</span> {v}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex gap-4 flex-wrap">
                <Link href="/quiz"
                  className="bg-[#F5B700] hover:bg-[#e0a800] text-[#020817] px-9 py-4 rounded-xl font-black text-[19px] transition-colors shadow-[0_0_40px_rgba(245,183,0,0.25)]">
                  開始打造我的投資首頁 →
                </Link>
                <button
                  onClick={() => document.getElementById("features")?.scrollIntoView({ behavior:"smooth" })}
                  className="bg-white/[0.08] backdrop-blur-md border border-white/[0.15] text-white px-7 py-4 rounded-xl font-semibold text-[17px] hover:bg-white/[0.15] transition-colors">
                  先看看有哪些功能
                </button>
              </div>

              {/* 四統計卡 */}
              <div className="grid grid-cols-4 gap-3 pt-1">
                {[
                  { num:"95+",  label:"ETF 資料" },
                  { num:"269+", label:"基金資料" },
                  { num:"34+",  label:"全球市場指標" },
                  { num:"5min", label:"快速上手" },
                ].map(s => (
                  <div key={s.label} className="bg-white/[0.07] backdrop-blur-sm border border-white/[0.1] rounded-2xl p-4 text-center">
                    <div className="text-[44px] font-black text-[#F5B700] leading-none mb-1">{s.num}</div>
                    <div className="text-[15px] text-white/55 leading-tight">{s.label}</div>
                  </div>
                ))}
              </div>

              {/* 資料來源信任背書 */}
              <div className="pt-1">
                <div className="text-[13px] text-white/30 mb-2">資料來源參考</div>
                <div className="flex flex-wrap gap-2">
                  {["Morningstar","公開資訊觀測站","投信投顧公會","基金公司公開資料"].map(src => (
                    <span key={src} className="text-[13px] text-white/40 border border-white/[0.1] px-3 py-1 rounded-full">{src}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* RIGHT — 個人化首頁預覽（2×3 Grid） */}
            <div className="rounded-3xl border border-white/[0.12] overflow-hidden shadow-[0_40px_120px_rgba(0,0,0,0.5)]"
              style={{ background:"rgba(8,15,32,0.88)", backdropFilter:"blur(28px)" }}>

              {/* 頂部 bar */}
              <div className="flex items-center justify-between px-6 py-3.5 border-b border-white/[0.08]"
                style={{ background:"rgba(8,15,32,0.96)" }}>
                <div className="flex items-center gap-3">
                  <div className="flex gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500/50" />
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50" />
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500/50" />
                  </div>
                  <div className="text-[12px] font-bold text-[#F5B700] tracking-[4px]">我的投資首頁</div>
                </div>
                <div className="text-[11px] text-white/30">登入後可自由客製</div>
              </div>

              {/* 2×3 模組 Grid */}
              <div className="p-4 grid grid-cols-2 gap-3">

                {/* 模組1：昨日美股 */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="text-[11px] text-white/40 mb-2 flex items-center justify-between">
                    <span>昨日美股</span>
                    <span className="text-[10px] text-white/20">可替換 ⊕</span>
                  </div>
                  <div className="space-y-1.5">
                    {[["NASDAQ","19,271","▲ +0.85%",true],["S&P 500","5,842","▲ +0.68%",true],["道瓊","43,408","▲ +0.53%",true]].map(([n,v,c,up])=>(
                      <div key={n as string} className="flex items-center justify-between">
                        <span className="text-[12px] text-white/50">{n}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold text-white">{v}</span>
                          <span className={`text-[11px] font-semibold ${up ? "text-emerald-400":"text-red-400"}`}>{c}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 模組2：熱門ETF */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="text-[11px] text-white/40 mb-2 flex items-center justify-between">
                    <span>熱門ETF</span>
                    <span className="text-[10px] text-white/20">可替換 ⊕</span>
                  </div>
                  <div className="space-y-1.5">
                    {[["0050","+0.72%",true],["00878","+0.45%",true],["00919","+0.38%",true]].map(([code,chg,up])=>(
                      <div key={code as string} className="flex items-center justify-between">
                        <span className="text-[13px] font-bold text-[#F5B700]">{code}</span>
                        <span className={`text-[12px] font-semibold ${up?"text-emerald-400":"text-red-400"}`}>{chg}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 模組3：熱門基金 */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="text-[11px] text-white/40 mb-2 flex items-center justify-between">
                    <span>熱門基金</span>
                    <span className="text-[10px] text-white/20">可替換 ⊕</span>
                  </div>
                  <div className="space-y-1.5">
                    {[["安聯","台灣科技基金","+1.25%",true],["復華","全球物聯網","+0.98%",true],["聯博","高收益債券","+0.42%",true]].map(([co,name,chg,up])=>(
                      <div key={name as string} className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] text-white/40 w-7 shrink-0">{co}</span>
                          <span className="text-[12px] text-white/60 truncate max-w-[80px]">{name}</span>
                        </div>
                        <span className={`text-[12px] font-semibold ${up?"text-emerald-400":"text-red-400"}`}>{chg}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 模組4：我的觀察名單 */}
                <div className="bg-white/[0.04] border border-[#F5B700]/20 rounded-xl p-4">
                  <div className="text-[11px] text-[#F5B700]/60 mb-2 flex items-center justify-between">
                    <span>👀 我的觀察名單</span>
                    <span className="text-[10px] text-white/20">個人化</span>
                  </div>
                  <div className="space-y-1.5">
                    {[["QQQ","Invesco NASDAQ","▲ +1.2%",true],["VGT","Vanguard IT","▲ +0.9%",true],["SOXX","iShares 半導體","▲ +1.8%",true]].map(([code,name,chg,up])=>(
                      <div key={code as string} className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12px] font-bold text-[#F5B700]">{code}</span>
                          <span className="text-[11px] text-white/35 truncate max-w-[70px]">{name}</span>
                        </div>
                        <span className={`text-[12px] font-semibold ${up?"text-emerald-400":"text-red-400"}`}>{chg}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 模組5：我的精選商品 */}
                <div className="bg-white/[0.04] border border-[#F5B700]/20 rounded-xl p-4">
                  <div className="text-[11px] text-[#F5B700]/60 mb-2 flex items-center justify-between">
                    <span>⭐ 我的精選商品</span>
                    <span className="text-[10px] text-white/20">個人化</span>
                  </div>
                  <div className="space-y-1.5">
                    {[["霸菱","優先順位基金","6.2%"],["聯博","美國收益基金","6.1%"],["00679B","元大美債20年","3.8%"]].map(([a,b,c])=>(
                      <div key={b as string} className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] text-[#F5B700] w-10 shrink-0">{a}</span>
                          <span className="text-[11px] text-white/50 truncate max-w-[80px]">{b}</span>
                        </div>
                        <span className="text-[12px] font-semibold text-[#F5B700]">{c}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 模組6：市場焦點 */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="text-[11px] text-white/40 mb-2 flex items-center justify-between">
                    <span>市場焦點</span>
                    <span className="text-[10px] text-white/20">可替換 ⊕</span>
                  </div>
                  <div className="space-y-1.5">
                    {[["黃金 XAU","3,342","▲ +0.91%",true],["台股加權","22,184","▲ +0.84%",true],["WTI原油","71.28","▼ -0.83%",false]].map(([n,v,c,up])=>(
                      <div key={n as string} className="flex items-center justify-between">
                        <span className="text-[12px] text-white/50">{n}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-semibold text-white">{v}</span>
                          <span className={`text-[11px] ${up?"text-emerald-400":"text-red-400"}`}>{c}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

              </div>

              {/* 底部說明 */}
              <div className="px-5 pb-4 text-center">
                <div className="text-[12px] text-white/25">登入後可自由新增、隱藏、排列模組</div>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* ══ ZONE 2：個人化首頁展示（未登入 vs 登入後）══════════ */}
      <section className="relative z-10 py-24" style={{ backgroundColor:"#ffffff" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-14">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-4">PERSONALIZATION</div>
            <h2 className="text-[40px] font-black text-[#0a1628]">你的首頁，你決定</h2>
            <p className="text-[18px] text-slate-500 mt-3 max-w-[600px] mx-auto">
              註冊後可以客製化你的投資首頁，選擇你關心的市場、商品與分析工具。
            </p>
          </div>
          <div className="grid lg:grid-cols-2 gap-8">

            {/* 未登入版本 */}
            <div>
              <div className="text-[16px] font-bold text-slate-500 mb-4 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-slate-300 inline-block" />
                未登入預設首頁
              </div>
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <div className="bg-slate-50 px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                  <div className="text-[14px] font-bold text-slate-400">Smart<span className="text-[#b38600]">Match</span></div>
                  <div className="text-[13px] text-slate-400">預設版本</div>
                </div>
                <div className="p-4 grid grid-cols-2 gap-3 bg-white">
                  {[
                    { title:"昨日美股", icon:"🇺🇸", items:["NASDAQ  +0.85%","S&P 500  +0.68%","道瓊  +0.53%"] },
                    { title:"熱門ETF",  icon:"📊", items:["0050  +0.72%","00878  +0.45%","00919  +0.38%"] },
                    { title:"熱門基金", icon:"🏦", items:["安聯台灣科技  +1.25%","復華物聯網  +0.98%","聯博高收益  +0.42%"] },
                    { title:"市場焦點", icon:"🌐", items:["黃金  +0.91%","台股  +0.84%","WTI  -0.83%"] },
                  ].map(m => (
                    <div key={m.title} className="border border-slate-100 rounded-xl p-4">
                      <div className="text-[13px] font-semibold text-slate-600 mb-2.5">{m.icon} {m.title}</div>
                      <div className="space-y-1.5">
                        {m.items.map(item => (
                          <div key={item} className="text-[13px] text-slate-500">{item}</div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* 登入後版本 */}
            <div>
              <div className="text-[16px] font-bold text-[#b38600] mb-4 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#F5B700] inline-block" />
                登入後個人化首頁
              </div>
              <div className="border border-[#F5B700]/30 rounded-2xl overflow-hidden shadow-sm">
                <div className="bg-[#0a1628] px-5 py-3.5 border-b border-white/[0.08] flex items-center justify-between">
                  <div className="text-[14px] font-bold text-white">Smart<span className="text-[#F5B700]">Match</span></div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-400" />
                    <div className="text-[13px] text-white/60">王小明</div>
                  </div>
                </div>
                <div className="p-4 grid grid-cols-2 gap-3" style={{ backgroundColor:"#0d1729" }}>
                  {[
                    { title:"👀 我的觀察名單", items:["QQQ  ▲ +1.2%","VGT  ▲ +0.9%","SOXX  ▲ +1.8%"] },
                    { title:"⭐ 我的精選商品", items:["霸菱優先順位  6.2%","聯博美國收益  6.1%","00679B  3.8%"] },
                    { title:"📈 我的分析結果", items:["穩健型 · 58分","股票50% 債券30%","上次分析 2026/06"] },
                    { title:"🌐 我的市場關注", items:["台股  ▲ +0.84%","NASDAQ  ▲ +0.85%","黃金  ▲ +0.91%"] },
                  ].map(m => (
                    <div key={m.title} className="border border-[#F5B700]/20 rounded-xl p-4">
                      <div className="text-[12px] font-semibold text-[#F5B700]/70 mb-2.5">{m.title}</div>
                      <div className="space-y-1.5">
                        {m.items.map(item => (
                          <div key={item} className="text-[13px] text-white/60">{item}</div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="bg-[#0a1628] px-5 py-3 text-center border-t border-white/[0.06]">
                  <div className="text-[13px] text-white/30">可新增 · 隱藏 · 拖曳排列模組</div>
                </div>
              </div>
            </div>

          </div>
          <div className="text-center mt-10">
            <Link href="/quiz"
              className="inline-block bg-[#F5B700] hover:bg-[#e0a800] text-[#020817] px-12 py-4 rounded-xl font-black text-[20px] transition-colors">
              開始打造我的投資首頁 →
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}