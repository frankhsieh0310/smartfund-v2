"use client";
// 選股反查（網站免費版）— 2026-10-24使用者核准定案，重建這個路由（原本是假資料佔位頁，已封存在
// _archived-page.tsx）。"use client"直接從瀏覽器打/api/screener/technical（跟/rankings、
// /dividend-center等互動頁同一個模式）——不是SSR自我呼叫，不會撞到Vercel Deployment Protection
// 擋自我呼叫那個已知問題（見app/new-listings/page.tsx的說明）。這支route本身在使用者未登入時
// 就是免費層（伺服器端getAccountForRequest()查不到帳號會自動視為free），這裡不用另外判斷，
// 直接顯示API回傳的upgradeHint/remainingCount，並導流下載App看完整版。
import Link from "next/link";
import { useState } from "react";

type ScreenerResult = {
  ticker: string; name: string; country: string; asOfDate: string;
  rsi14: number | null; macdHistogram: number | null; ma20: number | null; latestPrice: number | null;
  pe: number | null; pb: number | null; dividendYield: number | null; roe: number | null;
};
type ScreenerResponse = {
  ok: boolean; total: number; results: ScreenerResult[];
  tier?: string; truncatedConditions?: boolean; remainingCount?: number | null; upgradeHint?: string | null;
};

const PRESETS = [
  { key: "high_yield_low_pe", label: "高殖利率加低本益比", query: "dividend_yield_above=0.03&pe_below=15" },
  { key: "ma_bullish", label: "均線多頭排列", query: "price_vs_ma20=above&price_vs_ma60=above" },
  { key: "revenue_growth", label: "營收連續成長", query: "revenue_growth_above=0.1" },
  { key: "rsi_oversold_bounce", label: "RSI 超賣反彈", query: "rsi_below=30" },
  { key: "low_pb", label: "低股價淨值比", query: "pb_below=1" },
] as const;

function fundamentalLine(r: ScreenerResult): string | null {
  const parts: string[] = [];
  if (r.pe != null) parts.push(`本益比 ${r.pe.toFixed(2)}`);
  if (r.pb != null) parts.push(`股價淨值比 ${r.pb.toFixed(2)}`);
  if (r.dividendYield != null) parts.push(`殖利率 ${(r.dividendYield * 100).toFixed(2)}%`);
  if (r.roe != null) parts.push(`ROE ${(r.roe * 100).toFixed(1)}%`);
  return parts.length ? parts.join(" · ") : null;
}

export default function ScreenerPage() {
  const [market, setMarket] = useState<"TW" | "US">("TW");
  const [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<{ status: "idle" | "loading" | "ready" | "error"; data: ScreenerResponse | null }>({ status: "idle", data: null });

  const run = async (key: string, query: string) => {
    setSelected(key);
    setState({ status: "loading", data: null });
    try {
      const res = await fetch(`/api/screener/technical?${query}&market=${market}`, { cache: "no-store" });
      const data = (await res.json()) as ScreenerResponse;
      setState({ status: "ready", data });
    } catch {
      setState({ status: "error", data: null });
    }
  };

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
        <div className="text-xs font-semibold tracking-[0.3em] text-[#F5B700]">選股反查</div>
        <h1 className="mt-3 text-[32px] font-black tracking-[-0.02em] md:text-[40px]">用技術面與基本面條件篩股票</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-7 text-slate-400">
          技術指標自己算（均線／RSI／MACD），基本面（本益比／股價淨值比／殖利率／ROE）照抄 Yahoo Finance，不是示意數值。
          網站版免費使用，最多 3 個條件、看前 20 檔結果；完整結果、不限條件、持有名單、儲存條件與提醒，請下載 App。
        </p>

        <div className="mt-6 flex items-center gap-2 rounded-xl border border-white/[0.09] bg-white/[0.03] p-1.5 w-fit">
          {(["TW", "US"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMarket(m)} className={`rounded-lg px-5 py-2 text-sm font-bold transition-colors ${market === m ? "bg-[#F5B700] text-[#07111f]" : "text-slate-400 hover:text-white"}`}>
              {m === "TW" ? "台股" : "美股"}
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" onClick={() => void run(p.key, p.query)} className={`rounded-lg border px-4 py-2.5 text-sm font-bold transition-colors ${selected === p.key ? "border-[#F5B700] bg-[#F5B700]/10 text-[#ffe18a]" : "border-white/[0.1] text-slate-300 hover:border-white/[0.2]"}`}>
              {p.label}
            </button>
          ))}
        </div>

        {state.status === "loading" ? <div className="mt-10 text-center text-sm text-slate-400">查詢中…</div> : null}
        {state.status === "error" ? <div className="mt-10 text-center text-sm text-[#F5B700]">查詢失敗，請稍後再試。</div> : null}

        {state.status === "ready" && state.data ? (
          state.data.results.length === 0 ? (
            <div className="mt-10 text-center text-sm text-slate-500">目前沒有符合條件的股票。</div>
          ) : (
            <div className="mt-6">
              {state.data.upgradeHint ? (
                <div className="mb-4 flex flex-col gap-3 rounded-xl border border-[#F5B700]/30 bg-[#F5B700]/[0.06] p-5 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-slate-300">{state.data.upgradeHint}</p>
                  <a href="https://apps.apple.com/" target="_blank" rel="noreferrer" className="shrink-0 rounded-lg bg-[#F5B700] px-5 py-2.5 text-center text-sm font-bold text-[#07111f]">下載 App 看完整版</a>
                </div>
              ) : null}
              <div className="overflow-hidden rounded-2xl border border-white/[0.09] bg-white/[0.02]">
                {state.data.results.map((r) => (
                  <div key={r.ticker} className="flex flex-col gap-1 border-b border-white/[0.06] px-5 py-4 last:border-0">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-bold text-white">{r.name}（{r.ticker}）</div>
                      <div className="text-right text-sm text-slate-400">股價 {r.latestPrice ?? "—"}</div>
                    </div>
                    <div className="text-[12px] text-slate-500">
                      RSI14 {r.rsi14?.toFixed(2) ?? "—"} · MA20 {r.ma20?.toFixed(2) ?? "—"}
                      {fundamentalLine(r) ? ` · ${fundamentalLine(r)}` : ""}
                    </div>
                    <div className="text-[11px] text-slate-600">資料日期：{r.asOfDate} · 查持有名單與完整功能請下載 App</div>
                  </div>
                ))}
              </div>
            </div>
          )
        ) : null}
      </div>
    </main>
  );
}
