"use client";
// ============================================================
// components/home/WorkspacePreviewSection.tsx
// Comparison + WhyCriteria sections（2026-10-15 移除寫死數字的模擬儀表板）
// 從 app/page.tsx 拆出，不修改任何 UI 或邏輯
// ============================================================


// 2026-10-15：移除「登入後，你的首頁會長這樣」的模擬儀表板（寫死的符合商品數不是真實資料）
// ── Comparison ────────────────────────────────────────────────
function ComparisonSection() {
  const left = [
    { step: "01", text: "找 ETF" },
    { step: "02", text: "找基金" },
    { step: "03", text: "比較商品" },
    { step: "04", text: "收藏商品" },
    { step: "✕", text: "下次還是要重新找" },
  ];
  const right = [
    { step: "01", text: "建立投資條件" },
    { step: "02", text: "一次搜尋 ETF + 基金" },
    { step: "03", text: "保存自己的投資條件" },
    { step: "04", text: "一鍵重新執行" },
    { step: "✓",  text: "隨時查看符合最新條件商品" },
  ];

  return (
    <section className="py-28 bg-white">
      <div className="max-w-[1000px] mx-auto px-10">
        <div className="text-center mb-12">
          <h2 className="text-[32px] font-black text-[#0a1628] mb-3">傳統做法 vs SmartMatch</h2>
          <p className="text-[16px] text-slate-500">投資條件不會變，但市場每天都在變</p>
        </div>
        <div className="grid grid-cols-2 gap-6">
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-8">
            <div className="text-[14px] font-bold text-slate-400 tracking-[4px] mb-6">傳統做法</div>
            <div className="space-y-4">
              {left.map((item, i) => (
                <div key={i} className={`flex items-center gap-4 ${item.step === "✕" ? "opacity-50" : ""}`}>
                  <span className={`w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-bold shrink-0 ${item.step === "✕" ? "bg-red-100 text-red-500" : "bg-slate-200 text-slate-500"}`}>
                    {item.step}
                  </span>
                  <span className={`text-[15px] ${item.step === "✕" ? "text-red-500 font-semibold" : "text-slate-600"}`}>{item.text}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="bg-[#0a1628] border border-[#F5B700]/20 rounded-2xl p-8">
            <div className="text-[14px] font-bold text-[#F5B700] tracking-[4px] mb-6">SmartMatch</div>
            <div className="space-y-4">
              {right.map((item, i) => (
                <div key={i} className="flex items-center gap-4">
                  <span className={`w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-bold shrink-0 ${item.step === "✓" ? "bg-[#F5B700] text-[#0a1628]" : "bg-[#F5B700]/10 text-[#F5B700]"}`}>
                    {item.step}
                  </span>
                  <span className={`text-[15px] ${item.step === "✓" ? "text-[#F5B700] font-bold" : "text-slate-300"}`}>{item.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Why Criteria ──────────────────────────────────────────────
function WhyCriteriaSection() {
  const cards = [
    { icon: "🔁", title: "不用每次重新設定",    desc: "建立一次，之後隨時一鍵重新執行，查看最新符合商品。" },
    { icon: "🧠", title: "建立自己的投資邏輯",   desc: "你的條件，反映你的投資思維。不是別人給的清單，是你自己建立的篩選邏輯。" },
    { icon: "🔍", title: "ETF + 基金同時搜尋",   desc: "同一組條件，同時搜尋 ETF 與基金，不用分開查找。" },
    { icon: "📅", title: "條件不變，市場天天變", desc: "你的投資條件保存下來，市場每天更新，隨時查看有哪些商品符合你的條件。" },
  ];
  return (
    <section className="py-28 bg-[#F5F7FA]">
      <div className="max-w-[1200px] mx-auto px-10">
        <div className="text-center mb-12">
          <div className="text-[13px] tracking-[8px] text-[#F5B700] font-semibold mb-3">WHY SMARTMATCH</div>
          <h2 className="text-[32px] font-black text-[#0a1628] mb-3">為什麼要建立自己的投資條件？</h2>
          <p className="text-[16px] text-slate-500">SmartMatch 不提供投資建議，只幫你執行你自己定義的條件</p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
          {cards.map((c, i) => (
            <div key={i} className="bg-white rounded-2xl p-6 border border-slate-100 hover:shadow-md hover:border-[#F5B700]/30 transition-all">
              <div className="text-[36px] mb-4">{c.icon}</div>
              <div className="text-[16px] font-bold text-[#0a1628] mb-2">{c.title}</div>
              <div className="text-[14px] text-slate-500 leading-relaxed">{c.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Main Export ────────────────────────────────────────────────
export function WorkspacePreviewSection() {
  return (
    <>
      <ComparisonSection />
      <WhyCriteriaSection />
    </>
  );
}