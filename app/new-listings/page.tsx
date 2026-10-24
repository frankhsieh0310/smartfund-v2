// 新商品 -- 網站版原本不存在這個頁面。接上既有的 /api/mobile/new-listings（唯一資料來源是
// product_listing_events，由 lib/cron/newListingDetection.ts 從證交所/櫃買中心官方公告偵測寫入，
// 不是估計值）。沒有獨立的「網站版」API，但這支本來就是通用 JSON，不是只能給 App 用的格式。
import Link from "next/link";

type ListingEvent = { code: string; name: string; listed_date: string | null; source: string; source_url: string | null; detail_available: boolean; product_id: string | null };
type NewListingsResponse = { upcoming: ListingEvent[]; recent: ListingEvent[]; window_days: number; generated_at: string };

async function getNewListings(): Promise<NewListingsResponse | null> {
  try {
    // Server component fetch needs an absolute URL. VERCEL_URL is set by Vercel to this exact
    // deployment's own hostname (so a Preview build calls itself, not production); falls back to
    // the production domain only for local dev without it set.
    const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://www.smartmatchpilot.com";
    const res = await fetch(`${base}/api/mobile/new-listings?days=30`, { cache: "no-store" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

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
  const data = await getNewListings();

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
