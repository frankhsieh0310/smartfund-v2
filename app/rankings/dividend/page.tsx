"use client";
import { useEffect, useState } from "react";

// Function 6 (配息率排行榜). 殖利率 comes straight from `etfs.dividend_yield` (Yahoo's own
// summaryDetail.yield, via /api/rankings/etf-dividend) — never a second, self-calculated
// trailing-12M-distribution/NAV number. 配息 comes from etf_distribution_events, also Yahoo-sourced.
type Tab = "etf" | "fund";
type Row = {
  code: string; name: string; shareClassId?: string; yahooYield: number | null; latestDividend: number | null;
  latestCurrency: string | null; exDate: string | null; paymentDate: string | null; distributionType: string | null;
};
type HistoryEntry = { exDate: string; paymentDate: string | null; announcementDate: string | null; amount: number; currency: string; distributionType: string | null; source: string };

const dateSlash = (s: string | null) => s ? s.replaceAll("-", "/") : null;
const capitalReturnFlag = (t: string | null) => Boolean(t && /本金|capital|return of capital/i.test(t));

export default function DividendRankingPage() {
  const [tab, setTab] = useState<Tab>("etf");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyStatus, setHistoryStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let active = true; setStatus("loading");
    fetch(`/api/rankings/etf-dividend?type=${tab}&limit=${tab==='fund'?20:500}&offset=${offset}${offset>0?`&snapshot=${encodeURIComponent(snapshot)}`:''}`, { cache: "no-store" })
      .then((r) => {if(r.status===409&&active){setOffset(0);setSnapshot('');setRows(null);}return r.ok ? r.json() : Promise.reject(new Error(String(r.status)));})
      .then((p: { data: Row[]; nextOffset?: number | null; snapshot?: string }) => { if (active) { setRows(previous => offset === 0 ? p.data : [...(previous ?? []), ...p.data]);setNextOffset(p.nextOffset??null);setSnapshot(p.snapshot??''); setStatus("ready"); } })
      .catch(() => { if (active) setStatus("error"); });
    return () => { active = false; };
  }, [tab, offset]);

  useEffect(() => {
    if (!selected) return;
    let active = true; setHistoryStatus("loading");
    fetch(`/api/rankings/etf-dividend?type=${tab}&code=${encodeURIComponent(selected)}`, { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((p: { history: HistoryEntry[] }) => { if (active) { setHistory(p.history); setHistoryStatus("ready"); } })
      .catch(() => { if (active) setHistoryStatus("error"); });
    return () => { active = false; };
  }, [selected, tab]);

  return (
    <main className="min-h-screen bg-[#061728] px-10 py-8 text-[#f7f3e8]">
      <div className="mx-auto max-w-[900px]">
        <div className="mb-1 flex items-center gap-2 text-[13px] text-[#e9be6e]"><span>◆</span><span className="font-bold">配息率排行榜</span></div>
        <h1 className="text-[26px] font-black">配息率排行榜</h1>
        <p className="mt-2 text-[13px] leading-6 text-slate-400">配息率依 Yahoo 資料呈現，僅供試算與比較；配息率不等同投資總報酬。</p>

        <div className="mt-5 flex gap-2 border-b border-[#23445f]">
          {([["etf", "ETF"], ["fund", "基金"]] as const).map(([key, label]) => (
            <button key={key} onClick={() => {if(key===tab)return;setTab(key);setOffset(0);setRows(null);setSelected(null);setNextOffset(null);setSnapshot('');}}
              className={`px-4 py-2.5 text-[14px] font-bold ${tab === key ? "border-b-2 border-[#e9be6e] text-[#f2c66e]" : "text-slate-400 hover:text-slate-200"}`}>
              {label}
            </button>
          ))}
        </div>

        {tab === "fund" && <p className="mt-3 text-[13px] text-slate-400">全基金 Yahoo 配息率排行</p>}
        {tab === "fund" && status === "ready" && nextOffset!==null && <button onClick={()=>setOffset(nextOffset)} className="mt-3 text-[#e9be6e]">載入更多基金</button>}
        {status === "loading" && <p className="mt-6 text-[13px] text-slate-400">載入排行中…</p>}
        {status === "error" && <p className="mt-6 text-[13px] text-slate-400">目前無法連線排行資料服務，請稍後再試。</p>}
        {status === "ready" && (
          <div className="mt-4 overflow-hidden rounded-[12px] border border-white/[0.1]">
            <div className="grid grid-cols-[80px_1fr_90px_90px_90px] gap-2 bg-white/[0.04] px-4 py-2.5 text-[11px] font-bold text-slate-400">
              <span>代碼</span><span>名稱</span><span className="text-right">Yahoo 配息率</span><span className="text-right">最新配息</span><span className="text-right">除息日</span>
            </div>
            {(rows ?? []).length === 0 && <div className="px-4 py-6 text-center text-[13px] text-slate-500">配息率資料尚未取得</div>}
            {(rows ?? []).map((r) => (
              <button key={r.shareClassId??r.code} onClick={() => setSelected(r.code)}
                className="grid w-full grid-cols-[80px_1fr_90px_90px_90px] gap-2 border-t border-white/[0.06] px-4 py-3 text-left text-[13px] hover:bg-white/[0.03]">
                <span className="font-bold">{r.code}</span>
                <span className="truncate text-slate-300">{r.name}{capitalReturnFlag(r.distributionType) ? <span className="ml-1 rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] text-amber-300">配息來源可能含本金</span> : null}</span>
                <span className="text-right">{r.yahooYield != null ? `${r.yahooYield.toFixed(2)}%` : "—"}</span>
                <span className="text-right">{r.latestDividend != null ? r.latestDividend.toFixed(4) : "—"}</span>
                <span className="text-right text-slate-400">{dateSlash(r.exDate) ?? "—"}</span>
              </button>
            ))}
          </div>
        )}

        {selected && (
          <div className="mt-6 rounded-[12px] border border-white/[0.1] bg-[#0c2137] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-black">{selected}・歷次配息紀錄</h2>
              <button onClick={() => setSelected(null)} className="text-[12px] text-slate-400 hover:text-slate-200">關閉 ✕</button>
            </div>
            {historyStatus === "loading" && <p className="mt-3 text-[13px] text-slate-400">載入配息紀錄中…</p>}
            {historyStatus === "error" && <p className="mt-3 text-[13px] text-slate-400">目前無法載入配息紀錄，請稍後再試。</p>}
            {historyStatus === "ready" && (
              <div className="mt-3">
                {(history ?? []).length === 0 ? <p className="text-[13px] text-slate-500">目前沒有已收錄的配息紀錄。</p> : (
                  <table className="w-full text-[12px]">
                    <thead><tr className="text-left text-slate-500"><th className="py-1.5">除息日</th><th className="py-1.5">發放日</th><th className="py-1.5 text-right">配息</th></tr></thead>
                    <tbody>
                      {history!.map((h, i) => (
                        <tr key={i} className="border-t border-white/[0.06]">
                          <td className="py-1.5">{dateSlash(h.exDate)}</td>
                          <td className="py-1.5 text-slate-400">{dateSlash(h.paymentDate) ?? "—"}</td>
                          <td className="py-1.5 text-right">{h.amount.toFixed(4)} {h.currency}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        )}

        <p className="mt-6 text-[11px] leading-5 text-slate-500">配息率依 Yahoo 資料呈現，僅供試算與比較；配息率不等同投資總報酬。</p>
      </div>
    </main>
  );
}
