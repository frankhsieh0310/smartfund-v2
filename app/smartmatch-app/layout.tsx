import Link from "next/link";

// 2026-10-17：「SmartMatch」財經 App（smartmatch-mobile，com.smartmatch.mobile）的公開頁面
// （隱私權政策、使用條款、支援）。App Store／Google Play 上架需要公開網址。
// 跟 /twpuzzle 是完全不同的 App（不同 Bundle ID、不同功能），不要共用內容，只共用排版元件。
export default function SmartMatchAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative z-10 min-h-screen px-4 py-10 sm:px-6 sm:py-16">
      <div className="mx-auto max-w-[860px] rounded-2xl border border-white/10 bg-[#071226]/95 px-5 py-8 text-[16px] leading-8 text-slate-200 shadow-xl sm:px-10 sm:py-12">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-6">
          <div>
            <div className="text-[26px] font-black text-white">
              Smart<span className="text-[#F5B700]">Match</span>
            </div>
            <div className="text-[14px] text-slate-400">瑞宇智庫有限公司 RUI YU THINK TANK LIMITED</div>
          </div>
          <nav className="flex flex-wrap gap-4 text-[15px]">
            <Link href="/smartmatch-app/privacy" className="text-slate-300 underline-offset-4 hover:text-white hover:underline">隱私權政策</Link>
            <Link href="/smartmatch-app/terms" className="text-slate-300 underline-offset-4 hover:text-white hover:underline">使用條款</Link>
            <Link href="/smartmatch-app/support" className="text-slate-300 underline-offset-4 hover:text-white hover:underline">支援與聯絡</Link>
          </nav>
        </div>
        {children}
      </div>
    </main>
  );
}
