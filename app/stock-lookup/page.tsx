"use client";
// 選股反查（個股反查哪些ETF/基金持有，網站版）— 2026-10-28使用者核准定案，新增頁面。
// 既有 /screener 是技術面/基本面條件篩股（TW/US限定，技術指標只算這兩個市場，不能隨便擴大），
// 跟這裡要做的「輸入一檔股票，查哪些ETF/基金持有它」是不同功能，兩者都用 /api/mobile/reverse-holdings
// 查持有名單，但這支頁面本身是新的——網站版之前完全沒有這個查詢入口（原screener頁的持有名單
// 整個付費鎖給App）。這裡反查功能本身網站免費開放，不鎖。
//
// 市場選項：/api/search 回來的候選本身就跨國（country欄位），不是只有TW/US——所以市場選擇器直接
// 用候選股票實際出現過的country動態長出來，不是寫死TW/US兩個鍵。這跟手機App裡既有的「跨國股票反查」
// (app/reverse-lookup.tsx, scope=GLOBAL) 概念一致，網站版補上同一個能力。
// 另外這次順便修的根因（App端）：App原本呼叫reverse-holdings從不傳market參數，即使畫面上已經知道
// 選中股票的country——後端resolveTargets的market參數正是用來解決「裸代碼跨國撞號」（例如揭露文字
// 寫"2330"，台股/港股/日股都可能用同一串裸代碼），這裡新寫的網站版一開始就帶上market，不重複那個洞。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type SearchRow = { assetType: string; symbolOrCode: string | null; name: string; market: string | null; country: string | null; exchange: string | null };
type SearchResponse = { data: SearchRow[] };

type ReverseProduct = { id: string; type: "ETF" | "基金"; name: string; date: string | null; assetId: string; holdings: { ticker: string; name: string; weight: number | null }[] };
type ReverseResponse = { ok: boolean; etf_total_products: number; fund_total_products: number; etfs: ReverseProduct[]; funds: ReverseProduct[] };

const COUNTRY_LABEL: Record<string, string> = {
  TW: "台灣", US: "美國", HK: "香港", CN: "中國", JP: "日本", KR: "韓國", NL: "荷蘭", GB: "英國", DE: "德國", FR: "法國", SG: "新加坡", AU: "澳洲", CA: "加拿大", CH: "瑞士", IT: "義大利", SE: "瑞典",
};
const countryLabel = (c: string | null) => (c ? (COUNTRY_LABEL[c.toUpperCase()] ?? c) : "—");

export default function StockLookupPage() {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<SearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SearchRow | null>(null);
  const [result, setResult] = useState<ReverseResponse | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "empty" | "error">("idle");
  const requestId = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (selected || trimmed.length < 1) { setCandidates([]); return; }
    const current = ++requestId.current;
    setSearching(true);
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(trimmed)}&type=STOCK&limit=20`, { cache: "no-store" })
        .then((res) => res.json() as Promise<SearchResponse>)
        .then((data) => {
          if (current !== requestId.current) return;
          setCandidates((data.data ?? []).filter((r) => r.assetType === "STOCK" && r.symbolOrCode));
          setSearching(false);
        })
        .catch(() => { if (current === requestId.current) { setCandidates([]); setSearching(false); } });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, selected]);

  const pick = (row: SearchRow) => {
    setSelected(row);
    setCandidates([]);
    setStatus("loading");
    const marketParam = row.country ? `&market=${encodeURIComponent(row.country)}` : "";
    fetch(`/api/mobile/reverse-holdings?tickers=${encodeURIComponent(row.symbolOrCode!)}${marketParam}`, { cache: "no-store" })
      .then((res) => res.json() as Promise<ReverseResponse>)
      .then((data) => {
        setResult(data);
        const hasData = data.ok && (data.etfs.length > 0 || data.funds.length > 0);
        setStatus(hasData ? "ready" : data.ok ? "empty" : "error");
      })
      .catch(() => setStatus("error"));
  };

  const clear = () => { setSelected(null); setResult(null); setQuery(""); setStatus("idle"); };

  return (
    <main className="min-h-screen bg-[#07111f] text-white">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.08] bg-[#040a18]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-20 max-w-[1600px] items-center justify-between px-4 sm:px-10">
          <Link href="/"><div className="text-[28px] font-black leading-none sm:text-[32px]">Smart<span className="text-[#F5B700]">Match</span></div></Link>
          <nav className="hidden gap-7 text-sm font-semibold text-slate-300 lg:flex">
            <Link href="/markets" className="hover:text-white">市場總覽</Link>
            <Link href="/screener" className="hover:text-white">選股反查</Link>
            <Link href="/etf" className="hover:text-white">ETF</Link>
            <Link href="/funds" className="hover:text-white">基金</Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-[900px] px-4 pb-24 pt-32 sm:px-8">
        <div className="text-xs font-semibold tracking-[0.3em] text-[#F5B700]">個股反查</div>
        <h1 className="mt-3 text-[32px] font-black tracking-[-0.02em] md:text-[40px]">查一檔股票，被哪些ETF／基金持有</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-7 text-slate-400">
          支援台股與其他市場股票（美股、港股、日股、中國A股等）——輸入名稱或代碼即可，不限台股或美股。
        </p>

        <div className="mt-8 flex items-center gap-2 rounded-xl border border-white/[0.09] bg-white/[0.03] p-3">
          <span className="text-slate-500">⌕</span>
          {selected ? (
            <div className="flex w-full items-center justify-between gap-3">
              <span className="font-bold text-white">{selected.name}（{selected.symbolOrCode}）<span className="ml-2 text-[12px] font-normal text-slate-500">{countryLabel(selected.country)}</span></span>
              <button type="button" onClick={clear} className="text-slate-500 hover:text-white">×</button>
            </div>
          ) : (
            <input
              autoCapitalize="none"
              autoCorrect="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="輸入股票名稱或代碼（任何市場）"
              className="w-full bg-transparent text-[15px] text-white outline-none placeholder:text-slate-500"
            />
          )}
        </div>

        {!selected && searching ? <div className="mt-6 text-center text-sm text-slate-400">搜尋中…</div> : null}
        {!selected && !searching && query.trim().length > 0 && candidates.length === 0 ? (
          <div className="mt-6 text-center text-sm text-slate-500">找不到符合的股票，請試試完整代碼或英文名稱。</div>
        ) : null}

        {!selected && candidates.length > 0 ? (
          <div className="mt-4 overflow-hidden rounded-xl border border-white/[0.09] bg-white/[0.02]">
            {candidates.map((row) => (
              <button
                key={`${row.symbolOrCode}-${row.country}`}
                type="button"
                onClick={() => pick(row)}
                className="flex w-full items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3 text-left last:border-0 hover:bg-white/[0.04]"
              >
                <span className="font-mono text-[13px] text-[#F5B700]">{row.symbolOrCode}</span>
                <span className="flex-1 truncate px-3 text-[14px] text-white">{row.name}</span>
                <span className="text-[12px] text-slate-500">{countryLabel(row.country)}</span>
              </button>
            ))}
          </div>
        ) : null}

        {status === "loading" ? <div className="mt-10 text-center text-sm text-slate-400">查詢持有名單中…</div> : null}
        {status === "error" ? (
          <div className="mt-10 text-center text-sm text-[#F5B700]">
            資料暫時無法載入。
            <button type="button" onClick={() => selected && pick(selected)} className="ml-2 underline">重新載入</button>
          </div>
        ) : null}
        {status === "empty" ? (
          <div className="mt-10 text-center text-sm text-slate-500">
            目前查無 {selected?.symbolOrCode} 的 ETF／基金持有資料。
            <div className="mt-1 text-[12px] text-slate-600">此代碼可能為次要上市，請改搜尋主要上市代碼。</div>
          </div>
        ) : null}

        {status === "ready" && result ? (
          <div className="mt-8">
            <div className="rounded-xl border border-white/[0.09] bg-white/[0.03] p-5">
              <div className="text-[13px] text-slate-400">
                <span className="text-[20px] font-black text-[#F5B700]">{result.etf_total_products}</span> 檔 ETF、
                <span className="text-[20px] font-black text-[#F5B700]">{result.fund_total_products}</span> 檔基金持有
              </div>
            </div>
            <div className="mt-4 overflow-hidden rounded-2xl border border-white/[0.09] bg-white/[0.02]">
              {[...result.etfs, ...result.funds]
                .sort((a, b) => (b.holdings[0]?.weight ?? -1) - (a.holdings[0]?.weight ?? -1))
                .map((p) => (
                  <div key={p.id} className="flex flex-col gap-1 border-b border-white/[0.06] px-5 py-4 last:border-0">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-bold text-white">{p.name}</div>
                      <span className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-[11px] font-bold text-slate-300">{p.type}</span>
                    </div>
                    <div className="text-[12px] text-slate-500">
                      持股權重 {p.holdings[0]?.weight != null ? `${(p.holdings[0].weight * 100).toFixed(2)}%` : "—"} · 資料日期 {p.date ?? "—"}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
