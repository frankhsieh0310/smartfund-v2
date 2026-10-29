"use client";
// 網站版價格提醒 — 2026-10-29使用者核准定案，新增頁面。
// 後端API（app/api/alerts/route.ts：GET/POST/PATCH/DELETE，含capabilities查詢）本來就已經做好、
// 給App用，這裡只是補網站版的畫面，呼叫同一支API，不新增任何後端邏輯。登入沿用既有Supabase
// cookie session（跟components/auth/AuthButton.tsx同一套，同源fetch自動帶cookie，不需要另外
// 處理token）。
import Link from "next/link";
import { useEffect, useState } from "react";

type Capabilities = { assetMetrics: Record<string, string[]>; operators: string[]; channels: string[]; cadences: string[] };
type AlertRule = {
  id: string; assetType: string; canonicalAssetId: string; ruleFamily: string; status: string;
  frequency: string; cadence: string; deliveryChannels: string[];
  parameters: { conditions: Array<{ assetId: string; assetType: string; metric: string; operator: string; threshold: number | null }> } | null;
  state: { currentConditionState: string; dataAvailability: string } | null;
};
type SearchRow = { assetType: string; symbolOrCode: string | null; name: string; market: string | null };

const ASSET_TYPES = ["STOCK", "ETF", "FUND", "INDEX", "FIXED_INCOME", "FX", "MACRO", "COMMODITY", "CRYPTO", "DERIVATIVES"] as const;
const OPERATOR_LABEL: Record<string, string> = { ABOVE: "高於", BELOW: "低於", CROSS_ABOVE: "向上突破", CROSS_BELOW: "向下突破", PERCENT_CHANGE: "漲跌幅達", ABSOLUTE_CHANGE: "漲跌額達", EQUALS: "等於", GREATER_THAN_METRIC: "大於另一指標", LESS_THAN_METRIC: "小於另一指標" };
const METRIC_LABEL: Record<string, string> = { PRICE: "價格", NAV: "淨值", CHANGE: "漲跌額", PERCENT_CHANGE: "漲跌幅", DIVIDEND_YIELD: "殖利率", DAYS_TO_EX_DATE: "距除息天數", VALUE: "指數值", YIELD: "殖利率", RATE: "匯率", VOLUME: "成交量", OPENINTEREST: "未平倉量", IV: "隱含波動率", DELTA: "Delta", GAMMA: "Gamma", THETA: "Theta", VEGA: "Vega" };

export default function AlertsPage() {
  const [authState, setAuthState] = useState<"loading" | "authed" | "anon">("loading");
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [assetType, setAssetType] = useState<(typeof ASSET_TYPES)[number]>("ETF");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<SearchRow[]>([]);
  const [selected, setSelected] = useState<SearchRow | null>(null);
  const [metric, setMetric] = useState("");
  const [operator, setOperator] = useState("ABOVE");
  const [threshold, setThreshold] = useState("");
  const [channels, setChannels] = useState<string[]>(["IN_APP"]);

  const loadAll = () => {
    Promise.all([
      fetch("/api/alerts?capabilities=1", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      fetch("/api/alerts", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
    ]).then(([capsRes, rulesRes]) => {
      setCaps(capsRes.data); setRules(rulesRes.data ?? []); setAuthState("authed");
    }).catch((status) => setAuthState(status === 401 ? "anon" : "authed"));
  };

  useEffect(() => { loadAll(); }, []);

  useEffect(() => {
    if (selected || query.trim().length < 1) { setCandidates([]); return; }
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query.trim())}&type=${assetType}&limit=15`, { cache: "no-store" })
        .then((r) => r.json()).then((d) => setCandidates((d.data ?? []).filter((c: SearchRow) => c.assetType === assetType)))
        .catch(() => setCandidates([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, selected, assetType]);

  const availableMetrics = caps?.assetMetrics[assetType] ?? [];
  useEffect(() => { if (availableMetrics.length && !availableMetrics.includes(metric)) setMetric(availableMetrics[0]); }, [assetType, caps]);

  const createRule = async () => {
    if (!selected || !metric || !threshold) { setError("請選擇商品、指標並輸入門檻值"); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/alerts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ruleFamily: assetType === "ETF" || assetType === "FUND" ? "ETF_FUND" : "PRICE_VALUE",
          scopeType: "SINGLE_ASSET",
          parameters: { logic: "AND", conditions: [{ assetId: selected.symbolOrCode, assetType, metric, operator, threshold: Number(threshold) }] },
          frequency: "RECURRING", cadence: "DAILY", deliveryChannels: channels,
        }),
      });
      if (!res.ok) { const body = await res.json().catch(() => null); throw new Error(body?.error?.message ?? "建立失敗"); }
      setSelected(null); setQuery(""); setThreshold("");
      loadAll();
    } catch (e) { setError(e instanceof Error ? e.message : "建立失敗"); } finally { setBusy(false); }
  };

  const toggleRule = async (id: string, action: "PAUSE" | "RESUME") => {
    setBusy(true);
    await fetch("/api/alerts", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) }).catch(() => undefined);
    loadAll(); setBusy(false);
  };
  const deleteRule = async (id: string) => {
    setBusy(true);
    await fetch("/api/alerts", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => undefined);
    loadAll(); setBusy(false);
  };

  return (
    <main className="min-h-screen bg-[#07111f] text-white">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.08] bg-[#040a18]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-20 max-w-[1100px] items-center justify-between px-4 sm:px-10">
          <Link href="/"><div className="text-[28px] font-black leading-none sm:text-[32px]">Smart<span className="text-[#F5B700]">Match</span></div></Link>
          <nav className="hidden gap-7 text-sm font-semibold text-slate-300 lg:flex">
            <Link href="/etf" className="hover:text-white">ETF</Link>
            <Link href="/funds" className="hover:text-white">基金</Link>
            <Link href="/alerts" className="text-[#F5B700]">價格提醒</Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-[900px] px-4 pb-24 pt-32 sm:px-8">
        <div className="text-xs font-semibold tracking-[0.3em] text-[#F5B700]">價格提醒</div>
        <h1 className="mt-3 text-[32px] font-black tracking-[-0.02em] md:text-[40px]">設定商品價格提醒</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-7 text-slate-400">當 ETF、基金或其他商品觸及你設定的條件時通知你。</p>

        {authState === "loading" ? <div className="mt-10 text-center text-sm text-slate-400">載入中…</div> : null}

        {authState === "anon" ? (
          <div className="mt-10 rounded-xl border border-white/[0.09] bg-white/[0.03] p-6 text-center">
            <p className="text-slate-300">請先登入才能設定價格提醒。</p>
            <Link href="/auth/login" className="mt-4 inline-block rounded-xl bg-[#F5B700] px-5 py-3 text-sm font-black text-[#07111f]">前往登入</Link>
          </div>
        ) : null}

        {authState === "authed" ? (
          <>
            <div className="mt-8 rounded-2xl border border-white/[0.09] bg-white/[0.03] p-5">
              <h2 className="text-[16px] font-bold text-white">新增提醒</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs text-slate-500">商品類型</label>
                  <select value={assetType} onChange={(e) => { setAssetType(e.target.value as typeof assetType); setSelected(null); setQuery(""); }} className="w-full rounded-lg border border-white/[0.12] bg-[#0b1728] px-3 py-2.5 text-sm text-white outline-none">
                    {ASSET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="relative">
                  <label className="mb-1.5 block text-xs text-slate-500">商品</label>
                  {selected ? (
                    <div className="flex items-center justify-between rounded-lg border border-white/[0.12] bg-[#0b1728] px-3 py-2.5 text-sm">
                      <span className="text-white">{selected.name}（{selected.symbolOrCode}）</span>
                      <button type="button" onClick={() => setSelected(null)} className="text-slate-500 hover:text-white">×</button>
                    </div>
                  ) : (
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="輸入代碼或名稱搜尋" className="w-full rounded-lg border border-white/[0.12] bg-[#0b1728] px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-500" />
                  )}
                  {!selected && candidates.length > 0 ? (
                    <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-white/[0.12] bg-[#0b1728] shadow-xl">
                      {candidates.map((c) => (
                        <button key={c.symbolOrCode} type="button" onClick={() => { setSelected(c); setCandidates([]); }} className="block w-full px-3 py-2.5 text-left text-sm hover:bg-white/[0.06]">
                          <span className="font-mono text-[#F5B700]">{c.symbolOrCode}</span> <span className="text-white">{c.name}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div>
                  <label className="mb-1.5 block text-xs text-slate-500">指標</label>
                  <select value={metric} onChange={(e) => setMetric(e.target.value)} className="w-full rounded-lg border border-white/[0.12] bg-[#0b1728] px-3 py-2.5 text-sm text-white outline-none">
                    {availableMetrics.map((m) => <option key={m} value={m}>{METRIC_LABEL[m] ?? m}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs text-slate-500">條件</label>
                  <select value={operator} onChange={(e) => setOperator(e.target.value)} className="w-full rounded-lg border border-white/[0.12] bg-[#0b1728] px-3 py-2.5 text-sm text-white outline-none">
                    {(caps?.operators ?? []).map((op) => <option key={op} value={op}>{OPERATOR_LABEL[op] ?? op}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs text-slate-500">門檻值</label>
                  <input type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="例如 100" className="w-full rounded-lg border border-white/[0.12] bg-[#0b1728] px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-500" />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs text-slate-500">通知方式</label>
                  <div className="flex flex-wrap gap-3 pt-2">
                    {(caps?.channels ?? []).map((ch) => (
                      <label key={ch} className="flex items-center gap-1.5 text-xs text-slate-300">
                        <input type="checkbox" checked={channels.includes(ch)} onChange={(e) => setChannels(e.target.checked ? [...channels, ch] : channels.filter((c) => c !== ch))} />
                        {ch === "IN_APP" ? "站內" : ch === "APP_PUSH" ? "App推播" : ch}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              {error ? <p className="mt-3 text-sm text-[#F5B700]">{error}</p> : null}
              <button type="button" disabled={busy} onClick={() => void createRule()} className="mt-5 rounded-xl bg-[#F5B700] px-5 py-3 text-sm font-black text-[#07111f] disabled:opacity-50">{busy ? "處理中…" : "建立提醒"}</button>
            </div>

            <div className="mt-10">
              <h2 className="text-[16px] font-bold text-white">我的提醒（{rules.length}）</h2>
              {rules.length === 0 ? (
                <div className="mt-4 rounded-xl border border-white/[0.09] bg-white/[0.02] p-6 text-center text-sm text-slate-500">尚未設定任何提醒</div>
              ) : (
                <div className="mt-4 overflow-hidden rounded-2xl border border-white/[0.09] bg-white/[0.02]">
                  {rules.map((rule) => {
                    const cond = rule.parameters?.conditions?.[0];
                    return (
                      <div key={rule.id} className="flex flex-col gap-2 border-b border-white/[0.06] px-5 py-4 last:border-0 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="font-bold text-white">{cond ? `${cond.assetId}（${rule.assetType}）` : rule.assetType}</div>
                          <div className="mt-1 text-xs text-slate-500">{cond ? `${METRIC_LABEL[cond.metric] ?? cond.metric} ${OPERATOR_LABEL[cond.operator] ?? cond.operator} ${cond.threshold ?? "—"}` : "—"} · {rule.status === "ACTIVE" ? "啟用中" : "已暫停"}</div>
                        </div>
                        <div className="flex gap-2">
                          <button type="button" disabled={busy} onClick={() => void toggleRule(rule.id, rule.status === "ACTIVE" ? "PAUSE" : "RESUME")} className="rounded-lg border border-white/[0.12] px-3 py-2 text-xs text-slate-300 hover:border-white/30 disabled:opacity-50">{rule.status === "ACTIVE" ? "暫停" : "恢復"}</button>
                          <button type="button" disabled={busy} onClick={() => void deleteRule(rule.id)} className="rounded-lg border border-[#b42318]/40 px-3 py-2 text-xs text-[#f04438] hover:border-[#b42318] disabled:opacity-50">刪除</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
