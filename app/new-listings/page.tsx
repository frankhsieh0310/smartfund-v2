// 新商品 -- 網站版原本不存在這個頁面。資料來源是 lib/data-platform/web/newListingsService.ts
// （唯一資料來源是 product_listing_events，由 lib/cron/newListingDetection.ts 從證交所/櫃買中心
// 官方公告偵測寫入，不是估計值），跟 app/api/mobile/new-listings 共用同一支函式。這裡直接呼叫
// 該函式，不透過 HTTP 自我呼叫自己的 API route -- VERIFIED live 在 Preview 部署上，伺服器端自我
// 呼叫會被 Vercel 的 Deployment Protection 擋下（500），直接呼叫函式沒有這個問題。
import Link from "next/link";
import { getNewListingEvents, type ListingEvent } from "@/lib/data-platform/web/newListingsService";

function EventRow({ event }: { event: ListingEvent }) {
  const content = (
    <div className="flex items-center gap-4 px-5 py-4">
      <div className="min-w-0 flex-1">
        <div className="truncate font-bold text-white">{event.name}</div>
        <div className="mt-0.5 text-[12px] text-slate-500">{event.code} · 來源：{event.source}</div>
      </div>
      <div className="text-right">
        <div className="font-bold text-[#F5B700]">{event.listed_date ?? "日期待公告"}</div>
      </div>
    </div>
  );
  if (event.detail_available && event.product_id) {
    return <Link href={`/etf/${encodeURIComponent(event.product_id)}`} className="block hover:bg-white/[0.03]">{content}</Link>;
  }
  if (event.source_url) {
    return <a href={event.source_url} target="_blank" rel="noreferrer" className="block hover:bg-white/[0.03]">{content}</a>;
  }
  return <div>{content}</div>;
}

export default async function NewListingsPage() {
  const data = await getNewListingEvents(30).catch(() => null);

  return (
    <main className="min-h-screen bg-[#07111f] text-white">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.08] bg-[#040a18]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-20 max-w-[1600px] items-center justify-between px-4 sm:px-10">
          <Link href="/"><div className="text-[28px] font-black leading-none sm:text-[32px]">Smart<span className="text-[#F5B700]">Match</span></div></Link>
          <nav className="hidden gap-7 text-sm font-semibold text-slate-300 lg:flex">
            <Link href="/markets" className="hover:text-white">市場總覽</Link>
            <Link href="/etf" className="hover:text-white">ETF</Link>
            <Link href="/funds" className="hover:text-white">基金</Link>
            <Link href="/rankings" className="hover:text-white">排行榜</Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-[1100px] px-4 pb-24 pt-32 sm:px-8">
        <div className="text-xs font-semibold tracking-[0.3em] text-[#F5B700]">新商品</div>
        <h1 className="mt-3 text-[32px] font-black tracking-[-0.02em] md:text-[40px]">新商品上架</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-7 text-slate-400">證交所／櫃買中心官方公告偵測到的台股 ETF 新商品，近 30 天。</p>

        {!data ? (
          <div className="mt-8 rounded-2xl border border-white/[0.09] bg-white/[0.03] py-16 text-center text-slate-500">資料暫時無法載入，請稍後再試。</div>
        ) : (
          <>
            <section className="mt-8 rounded-2xl border border-white/[0.09] bg-white/[0.03]">
              <div className="border-b border-white/[0.08] px-5 py-4 text-[14px] font-bold text-slate-300">即將上市（{data.upcoming.length}）</div>
              {data.upcoming.length === 0 ? (
                <div className="py-10 text-center text-slate-500">目前沒有即將上市的核心母體 ETF。</div>
              ) : (
                <div className="divide-y divide-white/[0.05]">{data.upcoming.map((e) => <EventRow key={e.code} event={e} />)}</div>
              )}
            </section>

            <section className="mt-6 rounded-2xl border border-white/[0.09] bg-white/[0.03]">
              <div className="border-b border-white/[0.08] px-5 py-4 text-[14px] font-bold text-slate-300">近期上市（{data.recent.length}）</div>
              {data.recent.length === 0 ? (
                <div className="py-10 text-center text-slate-500">近 30 天沒有新上市的核心母體 ETF。</div>
              ) : (
                <div className="divide-y divide-white/[0.05]">{data.recent.map((e) => <EventRow key={e.code} event={e} />)}</div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
