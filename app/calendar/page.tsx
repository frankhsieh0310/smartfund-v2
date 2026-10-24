"use client";

// 投資日曆 -- 網站版原本不存在這個頁面。接上既有的 /api/calendar/events（已經是真實資料：ETF 用
// etf_distribution_events 的 ex_date/payment_date，基金用 fund_distribution_observations，
// 持股更新日期來自 holdings 表的 as_of_date -- 詳見該 route 檔頭註解）。這支 API 是「個人化」的：
// 它只回報使用者自己自選／組合裡商品的事件，不是全市場日曆，所以這裡要先用使用者自己的登入
// session 分別查 /api/watchlists 跟 /api/portfolios 取得商品清單，再組成 items 參數查日曆。
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type WatchlistItem = { canonicalAssetId: string; assetType: string; removedAt: string | null };
type Watchlist = { id: string; name: string; items: WatchlistItem[] };
type PortfolioItem = { assetType: string; assetId: string };
type Portfolio = { id: string; name: string; items: PortfolioItem[] };
type CalendarEvent = { date: string; type: string; assetType: "ETF" | "FUND"; assetId: string; name: string | null; ticker: string | null; amount: number | null; currency: string | null };

const EVENT_LABEL: Record<string, string> = {
  DIVIDEND_EX: "除息日", DIVIDEND_PAY: "發放日", ETF_HOLDINGS_UPDATE: "持股更新", FUND_HOLDINGS_UPDATE: "持股更新",
};
const EVENT_COLOR: Record<string, string> = {
  DIVIDEND_EX: "#F5B700", DIVIDEND_PAY: "#34d399", ETF_HOLDINGS_UPDATE: "#60a5fa", FUND_HOLDINGS_UPDATE: "#60a5fa",
};

type AuthState = "checking" | "signed_out" | "signed_in";

export default function CalendarPage() {
  const [auth, setAuth] = useState<AuthState>("checking");
  const [itemsParam, setItemsParam] = useState<string | null>(null);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const me = await fetch("/api/me", { cache: "no-store", signal: controller.signal }).catch(() => null);
      if (!me?.ok) { setAuth("signed_out"); return; }
      setAuth("signed_in");
      const [watchlistsRes, portfoliosRes] = await Promise.all([
        fetch("/api/watchlists", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ data: [] })),
        fetch("/api/portfolios", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ data: [] })),
      ]);
      const watchlists: Watchlist[] = watchlistsRes.data ?? [];
      const portfolios: Portfolio[] = portfoliosRes.data ?? [];
      const entries = new Map<string, { assetType: string; assetId: string; scopes: Set<"P" | "W"> }>();
      for (const wl of watchlists) for (const item of wl.items ?? []) {
        if (item.assetType !== "ETF" && item.assetType !== "FUND") continue;
        const key = `${item.assetType}:${item.canonicalAssetId}`;
        const entry = entries.get(key) ?? { assetType: item.assetType, assetId: item.canonicalAssetId, scopes: new Set<"P" | "W">() };
        entry.scopes.add("W");
        entries.set(key, entry);
      }
      for (const pf of portfolios) for (const item of pf.items ?? []) {
        if (item.assetType !== "ETF" && item.assetType !== "FUND") continue;
        const key = `${item.assetType}:${item.assetId}`;
        const entry = entries.get(key) ?? { assetType: item.assetType, assetId: item.assetId, scopes: new Set<"P" | "W">() };
        entry.scopes.add("P");
        entries.set(key, entry);
      }
      const param = [...entries.values()].map((e) => `${e.assetType}:${encodeURIComponent(e.assetId)}:${[...e.scopes].join("")}`).join(",");
      setItemsParam(param);
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (auth !== "signed_in" || itemsParam === null) return;
    if (!itemsParam) { setEvents([]); setStatus("ready"); return; }
    const controller = new AbortController();
    setStatus("loading");
    fetch(`/api/calendar/events?month=${month}&items=${itemsParam}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => { setEvents(data.events ?? []); setStatus("ready"); })
      .catch(() => !controller.signal.aborted && setStatus("error"));
    return () => controller.abort();
  }, [auth, itemsParam, month]);

  const grouped = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events ?? []) map.set(e.date, [...(map.get(e.date) ?? []), e]);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [events]);

  const shiftMonth = (delta: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  };

  return (
    <main className="min-h-screen bg-[#07111f] text-white">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.08] bg-[#040a18]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-20 max-w-[1600px] items-center justify-between px-4 sm:px-10">
          <Link href="/"><div className="text-[28px] font-black leading-none sm:text-[32px]">Smart<span className="text-[#F5B700]">Match</span></div></Link>
          <nav className="hidden gap-7 text-sm font-semibold text-slate-300 lg:flex">
            <Link href="/markets" className="hover:text-white">市場總覽</Link>
            <Link href="/rankings" className="hover:text-white">排行榜</Link>
            <Link href="/portfolio" className="hover:text-white">投資組合</Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-[900px] px-4 pb-24 pt-32 sm:px-8">
        <div className="text-xs font-semibold tracking-[0.3em] text-[#F5B700]">投資日曆</div>
        <h1 className="mt-3 text-[32px] font-black tracking-[-0.02em] md:text-[40px]">投資日曆</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-7 text-slate-400">顯示你自選與投資組合裡 ETF／基金的除息日、發放日與持股更新日期，只含真實資料。</p>

        {auth === "checking" ? (
          <div className="mt-8 rounded-2xl border border-white/[0.09] bg-white/[0.03] py-16 text-center text-slate-500">載入中…</div>
        ) : auth === "signed_out" ? (
          <div className="mt-8 rounded-2xl border border-white/[0.09] bg-white/[0.03] py-16 text-center">
            <div className="text-slate-400">投資日曆是依你的自選與投資組合產生的個人化資訊，請先登入。</div>
            <Link href="/auth/login" className="mt-4 inline-block rounded-xl bg-[#F5B700] px-6 py-3 text-sm font-bold text-[#0B1220]">登入</Link>
          </div>
        ) : (
          <>
            <div className="mt-8 flex items-center justify-between rounded-2xl border border-white/[0.09] bg-white/[0.03] px-5 py-4">
              <button onClick={() => shiftMonth(-1)} className="rounded-lg bg-white/[0.06] px-4 py-2 text-sm font-bold text-slate-300 hover:bg-white/[0.1]">‹ 上個月</button>
              <div className="text-[18px] font-bold">{month}</div>
              <button onClick={() => shiftMonth(1)} className="rounded-lg bg-white/[0.06] px-4 py-2 text-sm font-bold text-slate-300 hover:bg-white/[0.1]">下個月 ›</button>
            </div>

            {itemsParam === "" ? (
              <div className="mt-6 rounded-2xl border border-white/[0.09] bg-white/[0.03] py-16 text-center text-slate-500">
                你的自選與投資組合裡還沒有 ETF 或基金，加入之後這裡會顯示它們的除息日、發放日與持股更新。
              </div>
            ) : status === "loading" ? (
              <div className="mt-6 rounded-2xl border border-white/[0.09] bg-white/[0.03] py-16 text-center text-slate-500">載入中…</div>
            ) : status === "error" ? (
              <div className="mt-6 rounded-2xl border border-white/[0.09] bg-white/[0.03] py-16 text-center text-slate-500">日曆資料暫時無法載入，請稍後再試。</div>
            ) : grouped.length === 0 ? (
              <div className="mt-6 rounded-2xl border border-white/[0.09] bg-white/[0.03] py-16 text-center text-slate-500">這個月沒有事件。</div>
            ) : (
              <div className="mt-6 space-y-4">
                {grouped.map(([date, dayEvents]) => (
                  <div key={date} className="rounded-2xl border border-white/[0.09] bg-white/[0.03] p-5">
                    <div className="text-[14px] font-bold text-slate-300">{date}</div>
                    <div className="mt-3 space-y-2">
                      {dayEvents.map((e, i) => (
                        <Link key={i} href={e.assetType === "ETF" ? `/etf/${encodeURIComponent(e.ticker ?? e.assetId)}` : `/funds/${encodeURIComponent(e.assetId)}`} className="flex items-center gap-3 rounded-xl bg-white/[0.03] px-4 py-3 hover:bg-white/[0.06]">
                          <span className="rounded-full px-2.5 py-1 text-[11px] font-bold" style={{ color: EVENT_COLOR[e.type] ?? "#94a3b8", backgroundColor: `${EVENT_COLOR[e.type] ?? "#94a3b8"}1a` }}>{EVENT_LABEL[e.type] ?? e.type}</span>
                          <span className="flex-1 truncate font-semibold text-white">{e.name ?? e.ticker}</span>
                          {e.amount !== null ? <span className="text-[13px] text-slate-400">{e.amount} {e.currency}</span> : null}
                        </Link>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
