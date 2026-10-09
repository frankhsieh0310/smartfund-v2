"use client";
// ============================================================
// components/home/HeroSection.tsx
// Sprint 1A：重新設計 Hero 資訊架構
// 目標：5秒內回答「SmartMatch 是什麼、有何不同、下一步」
// ============================================================

import Link from "next/link";

// ── Task 3：Value Proposition 區塊 ───────────────────────────
function ValueProposition() {
  const items = [
    {
      icon: "💾",
      title: "建立一次，永久保存",
      desc: "設定好自己的投資條件，不用每次重新搜尋。",
    },
    {
      icon: "🔄",
      title: "市場每天更新",
      desc: "你的條件不變，符合條件的 ETF 與基金持續更新。",
    },
    {
      icon: "🎯",
      title: "找到符合條件的商品",
      desc: "依照你設定的條件，快速查看符合的 ETF 與基金。",
    },
  ];

  return (
    <section className="relative z-10 bg-white border-b border-slate-100">
      <div className="max-w-[1200px] mx-auto px-10 py-12">
        <div className="grid grid-cols-3 gap-0 divide-x divide-slate-100">
          {items.map((item, i) => (
            <div key={i} className="px-10 first:pl-0 last:pr-0">
              <div className="text-[28px] mb-3">{item.icon}</div>
              <div className="text-[17px] font-bold text-[#0a1628] mb-1.5">{item.title}</div>
              <div className="text-[14px] text-slate-500 leading-relaxed">{item.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Hero Main ─────────────────────────────────────────────────
export function HeroSection() {


  return (
    <>
      {/* ══ HERO ═══════════════════════════════════════════════ */}
      <section
        className="relative z-10 flex min-h-[760px] items-center overflow-hidden bg-[#07111f] pt-20 md:min-h-screen"
        data-hero-theme="premium-navy"
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-cover bg-[72%_center] bg-no-repeat opacity-45 md:bg-center md:opacity-100"
          style={{ backgroundImage: "url('/hero-smartfund-skyline-v3.png')" }}
        />
        <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(90deg,rgba(3,10,22,0.98)_0%,rgba(4,13,28,0.9)_43%,rgba(4,13,28,0.42)_72%,rgba(4,13,28,0.18)_100%)]" />
        <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(180deg,rgba(5,14,29,0.2)_0%,rgba(5,14,29,0.05)_58%,rgba(5,14,29,0.7)_100%)]" />

        <div className="relative z-10 mx-auto w-full max-w-[1400px] px-6 py-14 sm:px-8 md:px-10 md:py-20">
          <div className="max-w-[760px]">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.07] px-4 py-2 backdrop-blur-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-[#F5B700]" />
              <span className="text-[12px] font-semibold tracking-[0.18em] text-white/75 md:text-[13px]">全球投資研究平台</span>
            </div>

            <h1 className="max-w-[720px] text-[42px] font-black leading-[1.14] tracking-[-0.035em] text-white sm:text-[50px] md:text-[66px]">
              全球投資・全面數據<br />
              <span className="text-[#F5B700]">智慧研究・一站掌握</span>
            </h1>

            <p className="mt-6 max-w-[650px] text-[17px] leading-[1.8] text-slate-200/85 md:mt-7 md:text-[20px]">
              整合全球市場數據、投資商品與研究工具，<br className="hidden sm:block" />
              讓投資研究更簡單、更清楚。
            </p>

            <form action="/search" method="get" className="mt-9 max-w-[720px]" role="search">
              <label htmlFor="global-investment-search" className="sr-only">搜尋全球投資商品</label>
              <div className="flex h-16 w-full items-center gap-3 rounded-2xl border border-white/20 bg-white/[0.96] px-5 shadow-[0_22px_70px_rgba(0,0,0,0.35)] backdrop-blur-xl transition focus-within:border-[#F5B700]/70 focus-within:ring-4 focus-within:ring-[#F5B700]/10 md:h-[72px] md:px-6">
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0 fill-none stroke-slate-500 stroke-2">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.4-3.4" strokeLinecap="round" />
                </svg>
                <input
                  id="global-investment-search"
                  name="q"
                  type="search"
                  placeholder="搜尋股票、ETF、基金、債券、指數、外匯、商品..."
                  className="min-w-0 flex-1 bg-transparent text-[14px] font-medium text-slate-900 outline-none placeholder:text-slate-500 md:text-[16px]"
                />
                <button type="submit" className="hidden rounded-xl bg-[#0B1B34] px-6 py-3 text-[15px] font-bold text-white transition hover:bg-[#132c50] sm:block">搜尋</button>
              </div>
            </form>

            <div className="mt-5 text-[13px] text-white/60">快速搜尋：可輸入名稱、代碼、Ticker、ISIN 或貨幣對</div>
          </div>
        </div>
      </section>

      {/* ══ Task 3+5：Value Proposition（Hero → Criteria Builder 過渡）══ */}
      <ValueProposition />
    </>
  );
}
