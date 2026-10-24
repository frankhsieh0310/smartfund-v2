"use client";

// 配息資訊與試算 -- 網站版原本不存在這個頁面。接上兩支既有、已經在跑的正式資料 API：
// /api/rankings/performance?rankingType=DIVIDEND_YIELD（配息率排行，App 排行中心配息維度同一支）
// /api/cashflow/estimate（配息目標試算，App 配息目標試算畫面 src/cashflow/service.ts 同一支）。
// 只開放 ETF／基金（核心母體），跟網站其他挑選商品的地方一致。
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type PickerAssetType = "ETF" | "FUND";
type PickerResult = { assetType: PickerAssetType; canonicalId: string; symbolOrCode: string | null; displayName: string };
type DividendRow = { id: string; code: string | null; name: string; metricDisplay: string; priceDate: string | null };
type CashflowResult =
  | { ok: true; available: true; type: "etf" | "fund"; code: string; name: string; yahooYieldPct: number; targetAnnual: number; principalNeeded: number }
  | { ok: true; available: false; type: "etf" | "fund"; code: string; name?: string; reason: "PRODUCT_NOT_FOUND" | "NO_YAHOO_DIRECT_YIELD" };

export default function DividendCenterPage() {
  const [topYield, setTopYield] = useState<DividendRow[] | null>(null);
  const [yieldStatus, setYieldStatus] = useState<"loading" | "ready" | "unsupported">("loading");

  useEffect(() => {
    fetch("/api/rankings/performance?assetType=ETF&rankingType=DIVIDEND_YIELD&limit=10")
      .then((r) => r.json())
      .then((data) => { setTopYield(data.supported ? data.results : []); setYieldStatus(data.supported ? "ready" : "unsupported"); })
      .catch(() => setYieldStatus("unsupported"));
  }, []);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickerResult[]>([]);
  const [selected, setSelected] = useState<PickerResult | null>(null);
  const [target, setTarget] = useState("");
  const [calc, setCalc] = useState<{ status: "idle" | "loading" | "ready" | "error"; data?: CashflowResult }>({ status: "idle" });

  const runSearch = useCallback(async (value: string) => {
    setQuery(value);
    setSelected(null);
    if (!value.trim()) { setResults([]); return; }
    const [etfRes, fundRes] = await Promise.all([
      fetch(`/api/search?q=${encodeURIComponent(value)}&type=ETF&limit=6`).then((r) => (r.ok ? r.json() : { data: [] })),
      fetch(`/api/search?q=${encodeURIComponent(value)}&type=FUND&limit=6`).then((r) => (r.ok ? r.json() : { data: [] })),
    ]);
    type RawRow = { assetType: PickerAssetType; canonicalId: string; symbolOrCode: string | null; displayName: string };
    setResults([...(etfRes.data ?? []), ...(fundRes.data ?? [])].map((row: RawRow) => ({ assetType: row.assetType, canonicalId: row.canonicalId, symbolOrCode: row.symbolOrCode, displayName: row.displayName })));
  }, []);

  useEffect(() => {
    const targetNum = Number(target.replace(/,/g, "").trim());
    if (!selected?.symbolOrCode || !Number.isFinite(targetNum) || targetNum <= 0) { setCalc({ status: "idle" }); return; }
    const controller = new AbortController();
    setCalc({ status: "loading" });
    const timer = setTimeout(() => {
      fetch(`/api/cashflow/estimate?type=${selected.assetType.toLowerCase()}&code=${encodeURIComponent(selected.symbolOrCode!)}&target=${targetNum}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((data) => setCalc({ status: "ready", data }))
        .catch(() => !controller.signal.aborted && setCalc({ status: "error" }));
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [selected, target]);

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
        <div className="text-xs font-semibold tracking-[0.3em] text-[#F5B700]">配息資訊與試算</div>
        <h1 className="mt-3 text-[32px] font-black tracking-[-0.02em] md:text-[40px]">配息資訊與試算</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-7 text-slate-400">查看核心母體 ETF 配息率排行，或輸入目標年配息金額，算出需要投入的本金。</p>

        <section className="mt-8 rounded-2xl border border-white/[0.09] bg-white/[0.03] p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[18px] font-bold">配息率排行（前 10 名）</h2>
            <Link href="/rankings" className="text-[13px] font-bold text-[#F5B700]">查看完整排行 →</Link>
          </div>
          {yieldStatus === "loading" ? (
            <div className="py-10 text-center text-slate-500">載入中…</div>
          ) : yieldStatus === "unsupported" || !topYield?.length ? (
            <div className="py-10 text-center text-slate-500">目前沒有真實配息率資料可供顯示。</div>
          ) : (
            <div className="mt-4 divide-y divide-white/[0.05]">
              {topYield.map((row, i) => (
                <Link key={row.id} href={`/etf/${encodeURIComponent(row.code ?? row.id)}`} className="flex items-center gap-4 py-3 hover:bg-white/[0.03]">
                  <span className="w-5 text-[13px] text-slate-600">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-bold text-white">{row.name}</div>
                    <div className="text-[12px] text-slate-500">{row.code}{row.priceDate ? `・${row.priceDate}` : ""}</div>
                  </div>
                  <span className="font-bold text-[#F5B700]">{row.metricDisplay}</span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="mt-8 rounded-2xl border border-white/[0.09] bg-white/[0.03] p-5">
          <h2 className="text-[18px] font-bold">配息目標試算</h2>
          <p className="mt-1 text-[13px] text-slate-500">只用 Yahoo 直接公布的真實配息率計算；沒有真實資料的商品會誠實顯示「目前無法試算」，不會自己估一個數字。</p>

          <div className="relative mt-5">
            <input
              value={selected ? selected.displayName : query}
              onChange={(e) => runSearch(e.target.value)}
              placeholder="搜尋 ETF 或基金名稱、代碼"
              className="h-14 w-full rounded-xl border border-white/[0.16] bg-white/[0.97] px-4 text-[15px] font-medium text-slate-900 outline-none placeholder:text-slate-500 focus:border-[#F5B700]/70"
            />
            {query && !selected && results.length > 0 && (
              <div className="absolute z-10 mt-2 max-h-72 w-full overflow-y-auto rounded-xl border border-white/10 bg-[#0B1B34] shadow-2xl">
                {results.map((row) => (
                  <button key={`${row.assetType}:${row.canonicalId}`} onClick={() => { setSelected(row); setQuery(""); setResults([]); }} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-white/[0.06]">
                    <span className="font-semibold text-white">{row.displayName}</span>
                    <span className="ml-3 flex items-center gap-2 text-xs text-slate-400">
                      <span className="rounded-full border border-[#F5B700]/20 bg-[#F5B700]/[0.07] px-2 py-0.5 font-bold text-[#F5B700]">{row.assetType === "ETF" ? "ETF" : "基金"}</span>
                      {row.symbolOrCode ?? "—"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label className="text-[13px] text-slate-400">目標年配息金額（元）</label>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="例如 100000"
              inputMode="numeric"
              className="h-11 w-48 rounded-lg border border-white/[0.16] bg-white/[0.97] px-3 text-[14px] font-medium text-slate-900 outline-none"
            />
          </div>

          {calc.status === "loading" && <div className="mt-5 text-slate-400">試算中…</div>}
          {calc.status === "error" && <div className="mt-5 text-red-400">試算服務暫時無法使用，請稍後再試。</div>}
          {calc.status === "ready" && calc.data && (
            calc.data.available ? (
              <div className="mt-5 rounded-xl border border-[#F5B700]/30 bg-[#F5B700]/[0.06] p-5">
                <div className="text-[14px] text-slate-300">{calc.data.name}（{calc.data.code}）目前 Yahoo 公布配息率 <span className="font-bold text-[#F5B700]">{calc.data.yahooYieldPct.toFixed(2)}%</span></div>
                <div className="mt-2 text-[24px] font-black">需投入本金約 {Math.round(calc.data.principalNeeded).toLocaleString("zh-TW")} 元</div>
                <div className="mt-1 text-[12px] text-slate-500">才能達成每年 {Number(target.replace(/,/g, "")).toLocaleString("zh-TW")} 元配息目標（以目前配息率估算，配息率會隨市場變動）</div>
              </div>
            ) : (
              <div className="mt-5 text-slate-400">
                {calc.data.reason === "PRODUCT_NOT_FOUND" ? "找不到這檔商品。" : "這檔商品目前沒有真實的配息率資料，無法試算。"}
              </div>
            )
          )}
        </section>
      </div>
    </main>
  );
}
