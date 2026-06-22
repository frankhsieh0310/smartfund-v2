import Link from "next/link";

export default function PricingPage() {
  return (
    <main className="min-h-screen bg-white px-6 py-20">
      <div className="max-w-[1100px] mx-auto">

        {/* HEADER */}
        <div className="text-center mb-16">
          <div className="tracking-[10px] text-[#F5B700] text-[16px] font-semibold mb-6">
            SMARTMATCH
          </div>
          <h1 className="text-[52px] font-black text-[#0B1220] leading-tight">
            選擇適合你的方案
          </h1>
          <p className="text-[18px] text-slate-500 mt-4">
            從免費開始，隨時升級。所有方案均含核心分析功能。
          </p>
        </div>

        {/* PLANS */}
        <div className="grid grid-cols-3 gap-6 mb-16">

          {/* FREE */}
          <div className="border border-slate-200 rounded-2xl p-8 flex flex-col">
            <div className="text-[14px] font-semibold text-slate-500 tracking-[2px] mb-3">
              免費版
            </div>
            <div className="text-[48px] font-black text-[#0B1220] leading-none mb-1">
              $0
            </div>
            <div className="text-[14px] text-slate-400 mb-8">
              永久免費
            </div>

            <div className="flex flex-col gap-3 flex-1 mb-8">
              <Feature text="投資人格分析（無限次）" />
              <Feature text="客戶管理（最多 5 位）" />
              <Feature text="分析結果頁面" />
              <Feature text="會議紀錄（每位客戶 3 筆）" />
              <FeatureNo text="PDF 報告匯出" />
              <FeatureNo text="ETF / 基金資料庫" />
              <FeatureNo text="多商品走勢比較" />
              <FeatureNo text="資產配置分析器" />
              <FeatureNo text="客戶標籤與分類" />
            </div>

            <Link
              href="/clients"
              className="block text-center border border-slate-300 text-[#0B1220] py-3 rounded-xl font-semibold text-[15px] hover:bg-slate-50 transition-colors"
            >
              目前使用中
            </Link>
          </div>

          {/* PRO — highlighted */}
          <div className="border-2 border-[#F5B700] rounded-2xl p-8 flex flex-col relative">
            <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-[#F5B700] text-[#0B1220] text-[12px] font-bold px-4 py-1.5 rounded-full">
              最多人選擇
            </div>

            <div className="text-[14px] font-semibold text-[#F5B700] tracking-[2px] mb-3">
              專業版
            </div>
            <div className="text-[48px] font-black text-[#0B1220] leading-none mb-1">
              NT$799
            </div>
            <div className="text-[14px] text-slate-400 mb-8">
              每月 / 按月計費
            </div>

            <div className="flex flex-col gap-3 flex-1 mb-8">
              <Feature text="投資人格分析（無限次）" />
              <Feature text="客戶管理（最多 50 位）" />
              <Feature text="分析結果頁面" />
              <Feature text="會議紀錄（無限筆）" />
              <Feature text="PDF 報告匯出" />
              <Feature text="ETF / 基金資料庫" />
              <Feature text="多商品走勢比較（最多 5 檔）" />
              <Feature text="資產配置分析器" />
              <Feature text="客戶標籤與分類" />
            </div>

            <button
              onClick={() => alert("付款功能即將推出，請留下您的 Email 我們會第一時間通知您。")}
              className="block text-center bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] py-3 rounded-xl font-bold text-[15px] transition-colors"
            >
              升級專業版
            </button>
          </div>

          {/* TEAM */}
          <div className="border border-slate-200 rounded-2xl p-8 flex flex-col bg-[#0B1220]">
            <div className="text-[14px] font-semibold text-[#F5B700] tracking-[2px] mb-3">
              團隊版
            </div>
            <div className="text-[48px] font-black text-white leading-none mb-1">
              NT$2,999
            </div>
            <div className="text-[14px] text-slate-400 mb-8">
              每月 / 最多 5 位理專
            </div>

            <div className="flex flex-col gap-3 flex-1 mb-8">
              <FeatureWhite text="專業版全部功能" />
              <FeatureWhite text="客戶管理（無限位）" />
              <FeatureWhite text="多人帳號（最多 5 位理專）" />
              <FeatureWhite text="多商品走勢比較（最多 10 檔）" />
              <FeatureWhite text="組合回測分析" />
              <FeatureWhite text="商品重疊度分析" />
              <FeatureWhite text="理專儀表板（客戶總覽）" />
              <FeatureWhite text="優先客服支援" />
            </div>

            <button
              onClick={() => alert("付款功能即將推出，請留下您的 Email 我們會第一時間通知您。")}
              className="block text-center border border-white/30 text-white py-3 rounded-xl font-bold text-[15px] hover:bg-white/10 transition-colors"
            >
              聯繫我們
            </button>
          </div>

        </div>

        {/* FEATURE TABLE */}
        <div className="border border-slate-200 rounded-2xl overflow-hidden mb-16">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="px-6 py-4 text-[15px] font-bold text-[#0B1220] w-[40%]">功能</th>
                <th className="px-6 py-4 text-[15px] font-bold text-slate-500 text-center">免費版</th>
                <th className="px-6 py-4 text-[15px] font-bold text-[#F5B700] text-center">專業版</th>
                <th className="px-6 py-4 text-[15px] font-bold text-[#0B1220] text-center">團隊版</th>
              </tr>
            </thead>
            <tbody>
              <TableRow label="投資人格分析" free="無限次" pro="無限次" team="無限次" />
              <TableRow label="客戶管理" free="5 位" pro="50 位" team="無限" highlight />
              <TableRow label="會議紀錄" free="每位 3 筆" pro="無限" team="無限" />
              <TableRow label="PDF 報告匯出" free="✗" pro="✓" team="✓" highlight />
              <TableRow label="ETF / 基金資料庫" free="✗" pro="✓" team="✓" />
              <TableRow label="多商品走勢比較" free="✗" pro="5 檔" team="10 檔" highlight />
              <TableRow label="資產配置分析器" free="✗" pro="✓" team="✓" />
              <TableRow label="客戶標籤與分類" free="✗" pro="✓" team="✓" highlight />
              <TableRow label="組合回測分析" free="✗" pro="✗" team="✓" />
              <TableRow label="商品重疊度分析" free="✗" pro="✗" team="✓" highlight />
              <TableRow label="理專儀表板" free="✗" pro="✗" team="✓" />
              <TableRow label="多人帳號" free="✗" pro="✗" team="最多 5 位" highlight />
            </tbody>
          </table>
        </div>

        {/* FAQ */}
        <div className="max-w-[720px] mx-auto mb-16">
          <h2 className="text-[28px] font-black text-[#0B1220] mb-8 text-center">
            常見問題
          </h2>
          <div className="flex flex-col gap-6">
            <FaqItem
              q="免費版可以用多久？"
              a="永久免費，不需要信用卡。最多管理 5 位客戶，適合個人初步試用。"
            />
            <FaqItem
              q="升級後可以隨時取消嗎？"
              a="可以，按月計費，隨時取消，不收違約金。取消後當期結束前仍可繼續使用。"
            />
            <FaqItem
              q="我的客戶資料安全嗎？"
              a="目前版本資料儲存在您的本機瀏覽器，不會上傳至外部伺服器。正式版本將提供加密雲端儲存。"
            />
            <FaqItem
              q="可以申請試用嗎？"
              a="可以，請直接使用免費版開始體驗核心功能。如需申請專業版試用，請聯繫我們。"
            />
          </div>
        </div>

        <div className="flex gap-4 justify-center">
          <Link
            href="/"
            className="border border-slate-300 text-[#0B1220] px-10 py-4 rounded-lg hover:bg-slate-50 transition-colors font-semibold text-[18px]"
          >
            回到首頁
          </Link>
          <Link
            href="/clients"
            className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-10 py-4 rounded-lg font-bold text-[18px] transition-colors"
          >
            繼續使用免費版
          </Link>
        </div>

      </div>
    </main>
  );
}

function Feature({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-[15px] text-[#0B1220]">
      <span className="text-green-500 mt-0.5 shrink-0">✓</span>
      {text}
    </div>
  );
}

function FeatureNo({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-[15px] text-slate-300">
      <span className="mt-0.5 shrink-0">✗</span>
      {text}
    </div>
  );
}

function FeatureWhite({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-[15px] text-white">
      <span className="text-[#F5B700] mt-0.5 shrink-0">✓</span>
      {text}
    </div>
  );
}

function TableRow({
  label, free, pro, team, highlight,
}: {
  label: string;
  free: string;
  pro: string;
  team: string;
  highlight?: boolean;
}) {
  return (
    <tr className={`border-b border-slate-100 ${highlight ? "bg-slate-50/60" : ""}`}>
      <td className="px-6 py-3.5 text-[15px] text-[#0B1220] font-medium">{label}</td>
      <td className={`px-6 py-3.5 text-[15px] text-center ${free === "✗" ? "text-slate-300" : "text-slate-600"}`}>{free}</td>
      <td className={`px-6 py-3.5 text-[15px] text-center font-semibold ${pro === "✗" ? "text-slate-300" : "text-[#0B1220]"}`}>{pro}</td>
      <td className={`px-6 py-3.5 text-[15px] text-center ${team === "✗" ? "text-slate-300" : "text-slate-600"}`}>{team}</td>
    </tr>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <div className="border border-slate-200 rounded-xl p-6">
      <div className="text-[17px] font-bold text-[#0B1220] mb-2">{q}</div>
      <div className="text-[15px] text-slate-500 leading-relaxed">{a}</div>
    </div>
  );
}