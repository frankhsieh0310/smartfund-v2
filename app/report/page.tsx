import Link from "next/link";

// 2026-10-17: this page previously rendered entirely from hardcoded placeholder numbers
// (app/etf/data.ts, app/funds/data.ts -- both explicitly commented "資料為示意數值", e.g.
// `{ code: "0051", ..., dividendYield: 2.4, return1y: 18.4 }`), presented as a real
// "investment report" with a client's name and risk-personality type filled in. This violates the
// project's "no fabricated data" rule and was found during an independent acceptance-audit dry
// run. Per instruction, this page -- and every nav link, quiz CTA, and client-report link that
// pointed to it -- is replaced with this honest placeholder instead of ever showing fabricated
// numbers again. Same pattern already used for /compare (see that page's own history comment).

export default function ReportPage() {
  return (
    <main className="min-h-screen px-6 pt-32 pb-20 flex flex-col items-center justify-center text-center">
      <div className="text-[13px] tracking-[8px] text-[#F5B700] font-semibold mb-4">COMING SOON</div>
      <h1 className="text-[36px] font-black text-white mb-3">研究報告尚未開放</h1>
      <p className="text-[16px] text-slate-400 max-w-[480px] mb-10">
        這個功能正在開發中，開放前不會顯示任何示意或暫代數字。
      </p>
      <div className="flex gap-4">
        <Link href="/etf" className="border border-white/20 text-white px-7 py-3 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[15px]">
          ETF 資料庫
        </Link>
        <Link href="/funds" className="border border-white/20 text-white px-7 py-3 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[15px]">
          基金資料庫
        </Link>
        <Link href="/" className="border border-white/20 text-white px-7 py-3 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[15px]">
          回到首頁
        </Link>
      </div>
    </main>
  );
}
