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
      <section className="relative z-10 min-h-screen">
        {/* Overlay — 讓大樓清晰可見，文字仍可閱讀 */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#020817]/60 via-[#020817]/25 to-transparent z-[1]" />

        <div className="relative z-10 max-w-[1400px] mx-auto px-10 flex items-center min-h-screen pt-20">
          <div className="grid lg:grid-cols-[55%_45%] w-full items-center gap-16 py-16">

            {/* LEFT：資訊架構核心 */}
            <div className="space-y-8">

              {/* Task 6：定位標籤 — 第一眼就知道這不是 ETF 網站 */}
              <div className="inline-flex items-center gap-2 bg-white/[0.08] border border-white/[0.15] px-4 py-2 rounded-full">
                <span className="w-2 h-2 rounded-full bg-[#F5B700]" />
                <span className="text-[13px] font-semibold text-white/80 tracking-wide">
                  投資條件管理平台 — 不是 ETF 網站，不是基金網站
                </span>
              </div>

              {/* Task 1：主標題保留 */}
              <div>
                <h1 className="text-[58px] font-black leading-[1.1] text-white mb-6">
                  打造屬於你的<br />
                  <span className="text-[#F5B700]">投資儀表板</span>
                </h1>

                {/* Task 2：副標題重寫 — 描述新的投資方式，不介紹功能 */}
                <p className="text-[20px] text-white/75 leading-[1.9] max-w-[520px]">
                  以前找 ETF 和基金，每次都要重新搜尋。<br />
                  現在，建立一次自己的投資條件，SmartMatch
                  持續幫你找出今天符合條件的商品。
                </p>
              </div>

              {/* Task 4：CTA 重新設計 */}
              <div className="flex gap-4 flex-wrap pt-1">
                <button
                  onClick={() => document.getElementById("criteria-builder")?.scrollIntoView({ behavior: "smooth" })}
                  className="bg-[#F5B700] hover:bg-[#e0a800] text-[#020817] px-9 py-4 rounded-xl font-black text-[18px] transition-colors shadow-[0_0_40px_rgba(245,183,0,0.3)]"
                >
                  建立第一組投資條件 →
                </button>
                <button
                  onClick={() => document.getElementById("examples")?.scrollIntoView({ behavior: "smooth" })}
                  className="bg-white/[0.08] backdrop-blur-md border border-white/[0.2] text-white px-7 py-4 rounded-xl font-semibold text-[17px] hover:bg-white/[0.14] transition-colors"
                >
                  查看搜尋範例
                </button>
              </div>

              {/* 差異化說明 — Task 6 */}
              <div className="pt-2 border-t border-white/[0.08]">
                <div className="text-[13px] text-white/35 mb-3">SmartMatch 和一般 ETF / 基金網站的不同</div>
                <div className="space-y-2">
                  {[
                    "你建立的條件可以保存，下次一鍵重新執行",
                    "同一組條件同時搜尋 ETF 與基金，不用分開查",
                    "條件不變，市場每天更新，隨時查看最新符合商品",
                  ].map((point, i) => (
                    <div key={i} className="flex items-start gap-2.5 text-[14px] text-white/60">
                      <span className="text-[#F5B700] mt-0.5 shrink-0">✓</span>
                      <span>{point}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* 資料規模 */}
              <div className="flex gap-6 pt-1">
                {[
                  { num: "95+",  label: "ETF" },
                  { num: "269+", label: "基金" },
                  { num: "34+",  label: "市場指標" },
                ].map(s => (
                  <div key={s.label}>
                    <div className="text-[28px] font-black text-[#F5B700] leading-none">{s.num}</div>
                    <div className="text-[12px] text-white/40 mt-0.5">{s.label}</div>
                  </div>
                ))}
              </div>

            </div>

            {/* RIGHT：投資條件管理預覽 — 強化產品定位 */}
            <div
              className="rounded-3xl border border-white/[0.12] overflow-hidden shadow-[0_40px_120px_rgba(0,0,0,0.6)]"
              style={{ background: "rgba(8,15,32,0.90)", backdropFilter: "blur(28px)" }}
            >
              {/* 頂部 bar */}
              <div
                className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.08]"
                style={{ background: "rgba(8,15,32,0.96)" }}
              >
                <div className="flex items-center gap-3">
                  <div className="flex gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500/50" />
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50" />
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500/50" />
                  </div>
                  <div className="text-[12px] font-bold text-[#F5B700] tracking-[3px]">我的投資條件</div>
                </div>
                <div className="text-[11px] text-white/25">登入後自動同步</div>
              </div>

              {/* 投資條件列表 — 強調「條件管理」而非市場資訊 */}
              <div className="p-5 space-y-3">
                {[
                  {
                    name: "退休現金流",
                    tags: ["月配息", "殖利率 > 6%", "低波動"],
                    etf: 8, fund: 17,
                    active: true,
                  },
                  {
                    name: "科技成長",
                    tags: ["美國", "科技", "近1年 > 20%"],
                    etf: 11, fund: 6,
                    active: false,
                  },
                  {
                    name: "亞洲收益",
                    tags: ["亞洲", "月配息", "股票型"],
                    etf: 5, fund: 12,
                    active: false,
                  },
                  {
                    name: "台灣高股息",
                    tags: ["台灣", "高股息", "配息率 > 5%"],
                    etf: 9, fund: 4,
                    active: false,
                  },
                ].map((c, i) => (
                  <div
                    key={i}
                    className={`rounded-xl p-4 border transition-colors ${
                      c.active
                        ? "bg-[#F5B700]/10 border-[#F5B700]/30"
                        : "bg-white/[0.03] border-white/[0.06] hover:border-white/[0.12]"
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="text-[14px] font-bold text-white">{c.name}</div>
                      <div className="flex items-center gap-2 text-[12px]">
                        <span className="text-blue-400 font-semibold">{c.etf} ETF</span>
                        <span className="text-white/20">·</span>
                        <span className="text-amber-400 font-semibold">{c.fund} 基金</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {c.tags.map(t => (
                        <span key={t} className="text-[11px] bg-white/[0.07] text-white/50 px-2 py-0.5 rounded-full">
                          {t}
                        </span>
                      ))}
                    </div>
                    {c.active && (
                      <div className="mt-2.5 flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-[#F5B700] animate-pulse" />
                        <span className="text-[11px] text-[#F5B700]/70">今日更新</span>
                      </div>
                    )}
                  </div>
                ))}

                <button className="w-full border border-dashed border-white/[0.12] text-white/30 text-[13px] py-3 rounded-xl hover:border-[#F5B700]/30 hover:text-[#F5B700]/50 transition-colors">
                  ＋ 新增投資條件
                </button>
              </div>

              <div className="px-5 pb-4 text-center">
                <div className="text-[11px] text-white/20">建立帳號後，你的投資條件永久保存</div>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* ══ Task 3+5：Value Proposition（Hero → Criteria Builder 過渡）══ */}
      <ValueProposition />
    </>
  );
}