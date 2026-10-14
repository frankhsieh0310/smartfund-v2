"use client";
// ============================================================
// components/home/FeaturesSection.tsx
// 為什麼使用 SmartMatch + 會員價值 + 開始使用 + Footer
// 從 app/page.tsx 拆出（ZONE 3、ZONE 4、ZONE 7、FOOTER）
// 不修改任何 UI 或邏輯
// ============================================================

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// 2026-10-14 QA round 4: ZONE 6's two tables now read the real /api/rankings/performance endpoint
// (already live, used elsewhere for the full rankings pages) instead of the hardcoded placeholder
// rows from lib/services/rankingService.ts -- genuine top-5-by-1Y-return ETFs/funds, no self-
// computed figures. Dropped the dividend-yield/company columns the old mock had, since this one
// API call doesn't carry them and a second call per row isn't worth the added complexity for a
// homepage preview card (the full rankings pages already show dividend yield).
type RankingRow = { id: string; code: string | null; name: string; metricValue: number };

function useTopPerformers(assetType: "ETF" | "FUND") {
  const [rows, setRows] = useState<RankingRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/rankings/performance?assetType=${assetType}&rankingType=PERFORMANCE&period=1Y&limit=5&page=1`)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((j) => { if (!cancelled) setRows(j.results ?? []); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [assetType]);
  return rows;
}

export function FeaturesSection() {
  const topEtfs = useTopPerformers("ETF");
  const topFunds = useTopPerformers("FUND");
  return (
    <>
      {/* ══ ZONE 3：為什麼使用 SmartMatch（#F5F7FA）══════════════ */}
      <section id="features" className="relative z-10 py-28" style={{ backgroundColor:"#F5F7FA" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-14">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-4">WHY SMARTMATCH</div>
            <h2 className="text-[40px] font-black text-[#0a1628]">為什麼使用 SmartMatch</h2>
            <p className="text-[18px] text-slate-500 mt-3 max-w-[600px] mx-auto">
              不只是資料查詢。SmartMatch 是你的投資決策夥伴。
            </p>
          </div>
          <div className="grid grid-cols-5 gap-5">
            {[
              { num:"01", icon:"🏠", badge:"個人化", title:"打造專屬投資首頁", desc:"自由配置首頁模組：市場資訊、ETF、基金、觀察名單、收藏商品。登入後建立屬於自己的投資儀表板，不再被別人決定你看到什麼。" },
              { num:"02", icon:"💾", badge:"資料整合", title:"建立自己的投資資料庫", desc:"收藏、觀察、比較、分析結果全部集中一處。不再散落於不同網站與 Excel，所有決策紀錄隨時查閱。" },
              { num:"03", icon:"📊", badge:"效率提升", title:"ETF 與基金整合分析", desc:"同一平台完成 ETF 查詢、基金查詢與商品比較。大幅減少切換網站的時間，把精力放在決策本身。" },
              { num:"04", icon:"🎯", badge:"個人需求", title:"個人化商品篩選", desc:"不是熱門排行，不是大家都買什麼。依照你的風險偏好與投資目標篩選符合條件的商品。" },
              { num:"05", icon:"🔄", badge:"完整流程", title:"從市場到商品一次完成", desc:"全球市場資訊 → 商品研究 → 商品比較 → 建立觀察名單。完整投資流程整合在同一個平台。" },
            ].map(f => (
              <div key={f.num} className="bg-white border border-slate-100 rounded-2xl p-7 hover:shadow-lg hover:border-[#F5B700]/30 transition-all flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[11px] tracking-[4px] text-[#F5B700] font-semibold">{f.num}</div>
                  <span className="text-[11px] font-bold text-[#b38600] bg-[#F5B700]/10 px-2 py-0.5 rounded-full">{f.badge}</span>
                </div>
                <div className="text-[36px] mb-4">{f.icon}</div>
                <div className="text-[18px] font-bold text-[#0a1628] mb-3">{f.title}</div>
                <div className="text-[15px] text-slate-500 leading-relaxed flex-1">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══ 會員價值：註冊後可以做什麼（白底）══════════════════ */}
      <section className="relative z-10 py-28" style={{ backgroundColor:"#ffffff" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-14">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-4">MEMBER VALUE</div>
            <h2 className="text-[40px] font-black text-[#0a1628]">註冊後可以做什麼？</h2>
            <p className="text-[18px] text-slate-500 mt-3 max-w-[560px] mx-auto">
              建立帳號後，你的投資資料庫就開始運作。
            </p>
          </div>
          <div className="grid grid-cols-4 gap-6">
            {[
              { icon:"🏠", title:"個人化首頁",   desc:"自由配置首頁模組，選擇你關心的市場、商品與工具。",                     cta:"設定首頁",      href:"/" },
              { icon:"⭐", title:"收藏商品",     desc:"將 ETF 與基金加入收藏清單，建立自己的投資商品庫。",                    cta:"前往ETF篩選器", href:"/etf" },
              { icon:"👀", title:"觀察名單",     desc:"長期追蹤關注商品，隨時掌握動態，等待合適時機。",                       cta:"前往基金篩選器",href:"/funds" },
              { icon:"📋", title:"分析結果保存", desc:"人格分析與商品篩選結果永久保存，隨時回顧每次決策過程。",                cta:"開始人格分析",  href:"/quiz" },
            ].map(m => (
              <div key={m.title} className="flex flex-col border border-slate-100 rounded-2xl overflow-hidden hover:shadow-lg transition-all">
                <div className="bg-[#0a1628] p-6">
                  <div className="text-[40px] mb-3">{m.icon}</div>
                  <div className="text-[20px] font-black text-white">{m.title}</div>
                </div>
                <div className="p-6 flex flex-col flex-1">
                  <div className="text-[16px] text-slate-500 leading-relaxed flex-1">{m.desc}</div>
                  <a href={m.href}
                    className="mt-5 block text-center border border-[#F5B700]/50 text-[#b38600] py-2.5 rounded-xl text-[15px] font-semibold hover:bg-[#F5B700]/10 transition-colors">
                    {m.cta} →
                  </a>
                </div>
              </div>
            ))}
          </div>
          <div className="text-center mt-12">
            <Link href="/quiz"
              className="inline-block bg-[#0a1628] hover:bg-[#0d1f3c] text-white px-12 py-4 rounded-xl font-black text-[20px] transition-colors">
              立即建立我的帳號 →
            </Link>
            <div className="text-[15px] text-slate-400 mt-3">建立帳號後，所有資料保存在你的裝置上</div>
          </div>
        </div>
      </section>

      {/* ══ ZONE 4：開始使用 SmartMatch（白底）══════════════════ */}
      <section className="relative z-10 py-28" style={{ backgroundColor:"#ffffff" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-14">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-4">GET STARTED</div>
            <h2 className="text-[40px] font-black text-[#0a1628]">開始使用 SmartMatch</h2>
          </div>
          <div className="grid grid-cols-5 gap-4 relative">
            {[
              { step:"STEP 1", icon:"👤", title:"建立帳號",       desc:"免費註冊，30 秒完成" },
              { step:"STEP 2", icon:"🏠", title:"設定首頁模組",   desc:"選擇你想追蹤的市場與商品" },
              { step:"STEP 3", icon:"🧠", title:"完成投資分析",   desc:"20題問卷了解投資風格" },
              { step:"STEP 4", icon:"⭐", title:"收藏與追蹤商品", desc:"建立自己的ETF與基金清單" },
              { step:"STEP 5", icon:"💾", title:"建立投資資料庫", desc:"分析結果與追蹤記錄永久保存" },
            ].map((s, i) => (
              <div key={s.step} className="relative">
                {i < 4 && (
                  <div className="absolute top-[52px] left-[calc(100%-8px)] w-[calc(100%-16px)] h-0.5 z-10 hidden lg:block"
                    style={{ background:"linear-gradient(90deg,#F5B700,rgba(245,183,0,0.2))" }} />
                )}
                <div className="bg-white border border-slate-100 rounded-2xl p-6 text-center hover:shadow-md transition-shadow relative z-20">
                  <div className="text-[11px] tracking-[4px] text-[#F5B700] font-semibold mb-3">{s.step}</div>
                  <div className="text-[36px] mb-3">{s.icon}</div>
                  <div className="text-[18px] font-bold text-[#0a1628] mb-2">{s.title}</div>
                  <div className="text-[15px] text-slate-500 leading-relaxed">{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="text-center mt-10">
            <Link href="/quiz"
              className="inline-block bg-[#F5B700] hover:bg-[#e0a800] text-[#020817] px-12 py-4 rounded-xl font-black text-[20px] transition-colors">
              立即打造我的首頁 →
            </Link>
          </div>
        </div>
      </section>

      {/* ══ ZONE 6：熱門申購排行（白底）════════════════════════════ */}
      <section className="relative z-10 py-28" style={{ backgroundColor:"#ffffff" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-12">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-3">TOP PERFORMERS</div>
            <h2 className="text-[40px] font-black text-[#0a1628]">近1年績效排行榜</h2>
          </div>
          <div className="grid grid-cols-2 gap-8">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <span className="text-[20px]">📊</span>
                <h3 className="text-[20px] font-bold text-[#0a1628]">ETF 近1年績效 Top 5</h3>
              </div>
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <table className="w-full text-[15px]">
                  <thead><tr className="bg-slate-50 text-slate-400 text-[13px]">
                    <th className="px-4 py-3 text-left w-8">#</th>
                    <th className="px-4 py-3 text-left">代碼</th>
                    <th className="px-4 py-3 text-left">名稱</th>
                    <th className="px-4 py-3 text-right">近1年</th>
                  </tr></thead>
                  <tbody>
                    {(topEtfs ?? []).map((e, i) => (
                      <tr key={e.id} className="border-t border-slate-50 hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-2.5"><span className={`text-[13px] font-bold ${i<3?"text-[#b38600]":"text-slate-300"}`}>{i+1}</span></td>
                        <td className="px-4 py-2.5 font-bold text-[#b38600]">{e.code ?? "—"}</td>
                        <td className="px-4 py-2.5 text-slate-600 truncate max-w-[140px]">{e.name}</td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${e.metricValue>=0?"text-emerald-600":"text-red-500"}`}>{e.metricValue>=0?"+":""}{e.metricValue.toFixed(1)}%</td>
                      </tr>
                    ))}
                    {topEtfs === null && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">載入中…</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 text-right">
                <Link href="/etf" className="text-[14px] text-[#b38600] hover:underline">查看完整排行榜 →</Link>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-3 mb-4">
                <span className="text-[20px]">🏦</span>
                <h3 className="text-[20px] font-bold text-[#0a1628]">基金近1年績效 Top 5</h3>
              </div>
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <table className="w-full text-[15px]">
                  <thead><tr className="bg-slate-50 text-slate-400 text-[13px]">
                    <th className="px-4 py-3 text-left w-8">#</th>
                    <th className="px-4 py-3 text-left">代碼</th>
                    <th className="px-4 py-3 text-left">基金名稱</th>
                    <th className="px-4 py-3 text-right">近1年</th>
                  </tr></thead>
                  <tbody>
                    {(topFunds ?? []).map((f, i) => (
                      <tr key={f.id} className="border-t border-slate-50 hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-2.5"><span className={`text-[13px] font-bold ${i<3?"text-[#b38600]":"text-slate-300"}`}>{i+1}</span></td>
                        <td className="px-4 py-2.5 text-slate-500 text-[13px]">{f.code ?? "—"}</td>
                        <td className="px-4 py-2.5 text-slate-600 truncate max-w-[160px]">{f.name}</td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${f.metricValue>=0?"text-emerald-600":"text-red-500"}`}>{f.metricValue>=0?"+":""}{f.metricValue.toFixed(1)}%</td>
                      </tr>
                    ))}
                    {topFunds === null && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">載入中…</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 text-right">
                <Link href="/funds" className="text-[14px] text-[#b38600] hover:underline">查看完整排行榜 →</Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══ ZONE 7：About SmartMatch（深藍）════════════════════════ */}
      <section className="relative z-10 py-28" style={{ backgroundColor:"#0a1628" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-14">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-4">ABOUT</div>
            <h2 className="text-[40px] font-black text-white">關於 SmartMatch</h2>
            <p className="text-[18px] text-slate-400 mt-3 max-w-[680px] mx-auto leading-relaxed">
              投資資料分析平台。整合市場數據、ETF 與基金資料庫、商品比較、個人化儀表板與分析工具，幫助你建立更有系統的投資決策流程。
            </p>
          </div>
          <div className="grid lg:grid-cols-3 gap-6 mb-10">
            <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-7">
              <div className="text-[12px] tracking-[4px] text-[#F5B700] font-semibold mb-4">PLATFORM</div>
              <h3 className="text-[20px] font-bold text-white mb-4">平台介紹</h3>
              <div className="space-y-3 text-[16px] text-slate-400 leading-relaxed">
                <p>SmartMatch 為<span className="text-white font-semibold">瑞宇智庫</span>旗下投資資料分析平台。</p>
                <p>提供個人化投資首頁、ETF 與基金資料庫、商品比較中心與資產配置分析工具。</p>
                <p>定位類似 Morningstar，以<span className="text-white">客觀數據</span>為核心，不提供投資建議。</p>
              </div>
            </div>
            <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-7">
              <div className="text-[12px] tracking-[4px] text-[#F5B700] font-semibold mb-4">DATA SOURCES</div>
              <h3 className="text-[20px] font-bold text-white mb-4">資料來源</h3>
              <div className="space-y-2 text-[16px] text-slate-400">
                <div className="flex items-start gap-2"><span className="text-[#F5B700] shrink-0">·</span><span>ETF：各發行商公開說明書</span></div>
                <div className="flex items-start gap-2"><span className="text-[#F5B700] shrink-0">·</span><span>基金：投信投顧公會公開資料</span></div>
                <div className="flex items-start gap-2"><span className="text-[#F5B700] shrink-0">·</span><span>市場指數：各交易所公開資訊</span></div>
                <div className="flex items-start gap-2"><span className="text-[#F5B700] shrink-0">·</span><span>申購排行：投信投顧公會月報</span></div>
                <p className="text-[14px] text-slate-600 mt-3">目前版本使用示意數據供功能展示。</p>
              </div>
            </div>
            <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-7">
              <div className="text-[12px] tracking-[4px] text-[#F5B700] font-semibold mb-4">DISCLAIMER</div>
              <h3 className="text-[20px] font-bold text-white mb-4">免責聲明</h3>
              <div className="space-y-3 text-[16px] text-slate-400 leading-relaxed">
                <p>本平台所有內容均為<span className="text-slate-300">資料分析結果</span>，不構成投資建議或買賣推薦。</p>
                <p>投資人應自行評估風險，詳閱各商品公開說明書後謹慎決策。</p>
                <p>過去績效不代表未來表現。</p>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-4">
            {[
              { num:"95+",  label:"ETF 商品",   sub:"台股＋美股" },
              { num:"269+", label:"基金商品",     sub:"前20大基金公司" },
              { num:"34+",  label:"市場指標",     sub:"台灣、美歐、亞洲、商品" },
              { num:"NT$99起", label:"多元方案", sub:"依需求升級" },
            ].map(s => (
              <div key={s.label} className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5 text-center">
                <div className="text-[36px] font-black text-[#F5B700] leading-none mb-1">{s.num}</div>
                <div className="text-[16px] font-semibold text-white mb-1">{s.label}</div>
                <div className="text-[14px] text-slate-500">{s.sub}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

    </>
  );
}
