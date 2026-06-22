"use client";

import Link from "next/link";

export default function PricingPage() {
  return (
    <main className="min-h-screen bg-[#0a0f1e] px-6 py-20">

      {/* NAVBAR */}
      <header className="fixed top-0 left-0 w-full z-50 bg-[#0a0f1e]/90 backdrop-blur-xl border-b border-white/10">
        <div className="max-w-[1700px] mx-auto h-20 px-10 flex items-center justify-between">
          <Link href="/">
            <div className="text-[36px] font-black text-white leading-none">
              Smart<span className="text-[#F5B700]">Match</span>
            </div>
            <div className="text-[12px] text-slate-400 mt-0.5">ETF & 基金資產配置分析平台</div>
          </Link>
          <nav className="hidden lg:flex gap-8 text-[15px] font-semibold text-slate-300">
            <Link href="/quiz" className="hover:text-white transition-colors">投資人格分析</Link>
            <Link href="/etf" className="hover:text-white transition-colors">ETF篩選器</Link>
            <Link href="/funds" className="hover:text-white transition-colors">基金篩選器</Link>
            <Link href="/compare" className="hover:text-white transition-colors">比較中心</Link>
            <Link href="/clients" className="hover:text-white transition-colors">客戶管理</Link>
            <Link href="/pricing" className="text-[#F5B700]">方案</Link>
          </nav>
          <div className="flex items-center gap-4">
            <a href="#" className="text-[15px] font-semibold text-slate-300 border border-white/30 px-5 py-2.5 rounded-lg hover:bg-white/10 transition-colors">登入</a>
            <Link href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-6 py-2.5 rounded-lg font-bold text-[15px] transition-colors">
              免費註冊
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-[1300px] mx-auto pt-24">

        {/* HEADER */}
        <div className="text-center mb-16">
          <div className="tracking-[10px] text-[#F5B700] text-[16px] font-semibold mb-6">
            PRICING
          </div>
          <h1 className="text-[52px] font-black text-white leading-tight">
            選擇適合你的方案
          </h1>
          <p className="text-[18px] text-slate-400 mt-4">
            從免費開始，隨時升級。所有方案均含核心分析功能。
          </p>
        </div>

        {/* 五方案卡片 */}
        <div className="grid grid-cols-5 gap-4 mb-12">

          {/* FREE */}
          <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-6 flex flex-col">
            <div className="text-[12px] font-semibold text-slate-400 tracking-[2px] mb-3">免費版</div>
            <div className="text-[40px] font-black text-white leading-none mb-1">$0</div>
            <div className="text-[13px] text-slate-500 mb-6">永久免費</div>
            <div className="flex flex-col gap-2.5 flex-1 mb-6">
              <F text="人格分析（無限次）" />
              <F text="客戶管理（10 位）" />
              <F text="ETF / 基金資料庫" />
              <F text="5 檔走勢比較" />
              <F text="歷史資料 3 年" />
              <F text="PDF（每月1份）" />
              <FN text="客戶標籤" />
              <FN text="ETF＋基金混合分析" />
              <FN text="商品重疊分析" />
              <FN text="組合回測" />
            </div>
            <Link href="/clients" className="block text-center border border-white/20 text-white py-3 rounded-xl font-semibold text-[14px] hover:bg-white/10 transition-colors">
              免費開始
            </Link>
          </div>

          {/* LITE */}
          <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-6 flex flex-col">
            <div className="text-[12px] font-semibold text-slate-400 tracking-[2px] mb-3">Lite</div>
            <div className="text-[40px] font-black text-white leading-none mb-1">NT$99</div>
            <div className="text-[13px] text-slate-500 mb-6">每月</div>
            <div className="flex flex-col gap-2.5 flex-1 mb-6">
              <F text="人格分析（無限次）" />
              <F text="客戶管理（30 位）" />
              <F text="ETF / 基金資料庫" />
              <F text="10 檔走勢比較" />
              <F text="歷史資料全期間" />
              <F text="PDF（每月20份）" />
              <F text="客戶標籤" />
              <FN text="ETF＋基金混合分析" />
              <FN text="商品重疊分析" />
              <FN text="組合回測" />
            </div>
            <button onClick={() => alert("付款功能即將推出，我們會第一時間通知您。")}
              className="w-full border border-white/20 text-white py-3 rounded-xl font-semibold text-[14px] hover:bg-white/10 transition-colors">
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
              <F text="人格分析（無限次）" />
              <F text="客戶管理（100 位）" />
              <F text="ETF / 基金資料庫" />
              <F text="20 檔走勢比較" />
              <F text="歷史資料全期間" />
              <F text="無限 PDF 匯出" />
              <F text="客戶標籤" />
              <F text="ETF＋基金混合分析" />
              <FN text="商品重疊分析" />
              <FN text="組合回測" />
            </div>
            <button onClick={() => alert("付款功能即將推出，我們會第一時間通知您。")}
              className="w-full bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] py-3 rounded-xl font-bold text-[14px] transition-colors">
              選擇 Pro
            </button>
          </div>

          {/* ADVISOR */}
          <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-6 flex flex-col">
            <div className="text-[12px] font-semibold text-slate-400 tracking-[2px] mb-3">Advisor</div>
            <div className="text-[40px] font-black text-white leading-none mb-1">NT$599</div>
            <div className="text-[13px] text-slate-500 mb-6">每月</div>
            <div className="flex flex-col gap-2.5 flex-1 mb-6">
              <F text="Pro 全部功能" />
              <F text="客戶管理（500 位）" />
              <F text="無限走勢比較" />
              <F text="歷史資料全期間" />
              <F text="無限 PDF 匯出" />
              <F text="客戶標籤" />
              <F text="ETF＋基金混合分析" />
              <F text="商品重疊度分析" />
              <F text="組合回測分析" />
              <F text="理專儀表板" />
            </div>
            <button onClick={() => alert("付款功能即將推出，我們會第一時間通知您。")}
              className="w-full border border-white/20 text-white py-3 rounded-xl font-semibold text-[14px] hover:bg-white/10 transition-colors">
              選擇 Advisor
            </button>
          </div>

          {/* TEAM */}
          <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-6 flex flex-col">
            <div className="text-[12px] font-semibold text-[#F5B700] tracking-[2px] mb-3">Team</div>
            <div className="text-[40px] font-black text-white leading-none mb-1">NT$1,499</div>
            <div className="text-[13px] text-slate-500 mb-6">每月</div>
            <div className="flex flex-col gap-2.5 flex-1 mb-6">
              <F text="Advisor 全部功能" />
              <F text="客戶管理（無限）" />
              <F text="多人帳號（5人起）" />
              <F text="客戶共享" />
              <F text="理專主管儀表板" />
              <F text="團隊績效分析" />
              <F text="優先客服支援" />
              <F text="客製化報告模板" />
            </div>
            <button onClick={() => alert("請聯繫我們取得團隊版方案。")}
              className="w-full border border-[#F5B700]/50 text-[#F5B700] py-3 rounded-xl font-bold text-[14px] hover:bg-[#F5B700]/10 transition-colors">
              聯繫我們
            </button>
          </div>

        </div>

        {/* 功能對比表 */}
        <div className="border border-white/10 rounded-2xl overflow-hidden mb-12">
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
                ["歷史資料", "3年", "全期間", "全期間", "全期間", "全期間", true],
                ["PDF報告", "1份/月", "20份/月", "無限", "無限", "無限"],
                ["客戶標籤", "✗", "✓", "✓", "✓", "✓", true],
                ["ETF+基金混合分析", "✗", "✗", "✓", "✓", "✓"],
                ["商品重疊分析", "✗", "✗", "✗", "✓", "✓", true],
                ["組合回測", "✗", "✗", "✗", "✓", "✓"],
                ["理專儀表板", "✗", "✗", "✗", "✓", "✓", true],
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

        {/* FAQ */}
        <div className="max-w-[720px] mx-auto mb-16">
          <h2 className="text-[28px] font-black text-white mb-8 text-center">常見問題</h2>
          <div className="flex flex-col gap-4">
            {[
              ["免費版可以用多久？", "永久免費，不需要信用卡。最多管理 10 位客戶，適合個人初步試用。"],
              ["升級後可以隨時取消嗎？", "可以，按月計費，隨時取消，不收違約金。取消後當期結束前仍可繼續使用。"],
              ["我的客戶資料安全嗎？", "目前版本資料儲存在您的本機瀏覽器，不會上傳至外部伺服器。正式版本將提供加密雲端儲存。"],
              ["Pro 跟 Advisor 差在哪？", "Pro 適合一般理專日常使用；Advisor 多了商品重疊分析、組合回測與理專儀表板，適合資深理專與獨立財顧。"],
              ["Team 方案怎麼申請？", "請點選「聯繫我們」，我們會在 24 小時內與您聯繫，提供客製化的團隊方案。"],
            ].map(([q, a]) => (
              <div key={q as string} className="border border-white/10 rounded-xl p-6 bg-white/[0.03]">
                <div className="text-[16px] font-bold text-white mb-2">{q}</div>
                <div className="text-[14px] text-slate-400 leading-relaxed">{a}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-4 justify-center pb-20">
          <a href="/" className="border border-white/20 text-white px-10 py-4 rounded-lg hover:bg-white/10 transition-colors font-semibold text-[16px]">
            回到首頁
          </a>
          <a href="/clients" className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-10 py-4 rounded-lg font-bold text-[16px] transition-colors">
            免費開始使用
          </a>
        </div>

      </div>
    </main>
  );
}

function F({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-[13px] text-slate-300">
      <span className="text-green-400 mt-0.5 shrink-0">✓</span>{text}
    </div>
  );
}

function FN({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-[13px] text-slate-600">
      <span className="mt-0.5 shrink-0">✗</span>{text}
    </div>
  );
}