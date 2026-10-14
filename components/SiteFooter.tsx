import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="relative z-10 border-t border-white/[0.06] bg-[#060e1e] py-10">
      <div className="mx-auto max-w-[1600px] px-6 sm:px-10">
        <div className="flex flex-col items-start justify-between gap-6 lg:flex-row lg:items-center">
          <div className="min-w-0">
            <div className="text-[24px] font-black text-white">Smart<span className="text-[#F5B700]">Match</span></div>
            <div className="mt-1 text-[14px] text-slate-500">瑞宇智庫｜Investment Intelligence Platform</div>
          </div>
          <div className="flex min-w-0 flex-wrap gap-6 text-[16px] text-slate-500">
            <Link href="/markets" className="transition-colors hover:text-slate-300">市場中心</Link>
            <Link href="/etf" className="transition-colors hover:text-slate-300">ETF資料庫</Link>
            <Link href="/funds" className="transition-colors hover:text-slate-300">基金資料庫</Link>
            <Link href="/quiz" className="transition-colors hover:text-slate-300">人格分析</Link>
            <Link href="/clients" className="transition-colors hover:text-slate-300">客戶管理</Link>
            <Link href="/pricing" className="transition-colors hover:text-slate-300">方案說明</Link>
            <a href="mailto:contact@smartmatch.tw" className="transition-colors hover:text-slate-300">聯絡我們</a>
          </div>
          <div className="min-w-0 text-[13px] text-slate-400 lg:text-right">
            <div>本站資料僅供參考，不構成投資建議。</div>
            <div className="mt-1">© 2026 SmartMatch｜瑞宇智庫有限公司 版權所有</div>
          </div>
        </div>
        <address className="mt-8 space-y-2 border-t border-white/[0.06] pt-6 text-[14px] not-italic leading-6 text-slate-300">
          <p className="font-semibold text-white">
            <span className="inline-block">瑞宇智庫有限公司</span>{"　"}
            <span className="inline-block">Ruiyu Think Tank Co., Ltd.</span>
          </p>
          <p>統一編號：93639659</p>
          <p>地址：新北市三重區重新路2段21號11樓</p>
          <p>聯絡信箱：<a href="mailto:contact@smartmatch.tw" className="break-all underline underline-offset-4 hover:text-white">contact@smartmatch.tw</a></p>
        </address>
      </div>
    </footer>
  );
}
