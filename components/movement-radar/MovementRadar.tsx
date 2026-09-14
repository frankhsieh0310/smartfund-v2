"use client";
import { useEffect, useMemo, useState } from "react";

// 大佬動向雷達 (Web) — shares the exact same production APIs as the SmartMatch App, never a
// second data path: /api/consensus/* for 人物觀點, /api/mobile/institutional-holdings for 機構持股.
// 國會交易 / 內部人交易 render an honest empty state until a real ingestion source is live — never
// mock data standing in for production.
type Tab = "person" | "congress" | "insider" | "institutional";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "person", label: "人物觀點" },
  { key: "congress", label: "國會交易" },
  { key: "insider", label: "內部人交易" },
  { key: "institutional", label: "機構持股" },
];

export function MovementRadar() {
  const [tab, setTab] = useState<Tab>("person");
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-[13px] text-[#e9be6e]">
        <span>◆</span><span className="font-bold">大佬動向雷達</span>
      </div>
      <h1 className="text-[28px] font-black">看他們在說什麼、買什麼</h1>
      <p className="mt-1 text-[13px] text-slate-400">人物觀點・國會交易・內部人交易・機構持股 — 全部共用 SmartMatch 正式後端資料</p>
      <div className="mt-5 flex gap-2 border-b border-[#23445f]">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-[14px] font-bold ${tab === t.key ? "border-b-2 border-[#e9be6e] text-[#f2c66e]" : "text-slate-400 hover:text-slate-200"}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-6">
        {tab === "person" && <PersonViewpoint />}
        {tab === "congress" && <Congress />}
        {tab === "insider" && <Insider />}
        {tab === "institutional" && <Institutional />}
      </div>
    </div>
  );
}

function SectionTitle({ children, right }: { children: string; right?: string }) {
  return <div className="mb-2 mt-8 flex items-center justify-between border-b border-white/[0.08] pb-2 first:mt-0">
    <h2 className="text-[17px] font-black">{children}</h2>
    {right ? <span className="text-[12px] text-slate-400">{right}</span> : null}
  </div>;
}
function Card({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-[12px] border border-white/[0.1] bg-[linear-gradient(145deg,rgba(22,40,57,.94),rgba(12,28,43,.96))]">{children}</div>;
}
function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] px-4 py-3 text-[13px] last:border-b-0">{children}</div>;
}
function Note({ children }: { children: string }) {
  return <p className="rounded-lg border-l-[3px] border-[#e9be6e] bg-[#0e2438] px-4 py-3 text-[13px] leading-6 text-slate-300">{children}</p>;
}
function EmptyStatePanel({ title, note, building, sections }: { title: string; note: string; building: string; sections: string[] }) {
  return <div>
    <Note>{note}</Note>
    <div className="mt-4 flex flex-wrap gap-2">{sections.map((s) => <span key={s} className="rounded-lg border border-white/[0.12] bg-[#0c2137] px-3 py-1.5 text-[12px] text-slate-300">{s}</span>)}</div>
    <div className="mt-6 flex flex-col items-center gap-2 rounded-[12px] border border-dashed border-white/[0.16] bg-[#0a1d30] py-16 text-center">
      <b className="text-[15px]">資料建置中</b>
      <p className="max-w-[440px] text-[12px] leading-5 text-slate-400">{building}</p>
    </div>
  </div>;
}

// ---- 人物觀點 — /api/consensus/rankings + /api/consensus/flips (same production API the App uses)
type ConsensusRow = { symbol: string; company_name: string | null; bullish_people: number; bearish_people: number; direct_mentions: number; inferred_mentions: number; consensus_score: number; unique_people_count: number };
type ConsensusEvent = { id: string; person: string; organization: string | null; stance: string; summary_zh: string | null; sector: string | null; event_at: string | null; source_url: string; source_title: string | null; direct_symbols: string[]; inferred_symbols: string[] };
type ConsensusPayload = { as_of_date: string | null; coverage_people?: number; coverage_sources?: number; empty: boolean; bullish: ConsensusRow[]; bearish: ConsensusRow[]; latest_events: ConsensusEvent[]; sectors: { sector: string; consensus_score: number; unique_people_count: number }[] };
type FlipRow = { id: string; person: string; symbol: string; company_name: string | null; flip_type: string; previous_stance_zh: string; current_stance_zh: string; current_event_at: string | null; relation_type: string };

const strengthLabel = (score: number) => score >= 0.6 ? "明顯偏多" : score >= 0.2 ? "偏多" : score > -0.2 ? "中性" : score > -0.6 ? "偏空" : "明顯偏空";
const strengthColor = (score: number) => score >= 0.2 ? "text-emerald-400" : score <= -0.2 ? "text-rose-400" : "text-slate-300";
const relDate = (iso: string | null) => { if (!iso) return "時間未提供"; const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); if (d <= 0) return "今日"; if (d === 1) return "昨日"; if (d < 30) return `${d} 天前`; return iso.slice(0, 10).replaceAll("-", "/"); };

function PersonViewpoint() {
  const [data, setData] = useState<ConsensusPayload | null>(null);
  const [flips, setFlips] = useState<FlipRow[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [query, setQuery] = useState("");
  useEffect(() => {
    let active = true;
    setStatus("loading");
    fetch("/api/consensus/rankings?window=30D", { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))).then((p: ConsensusPayload) => { if (active) { setData(p); setStatus("ready"); } }).catch(() => { if (active) setStatus("error"); });
    fetch("/api/consensus/flips?window=30D", { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject()).then((p: { flips: FlipRow[] }) => { if (active) setFlips(p.flips ?? []); }).catch(() => { if (active) setFlips([]); });
    return () => { active = false; };
  }, []);

  const q = query.trim().toUpperCase();
  const filterRow = (r: ConsensusRow) => !q || r.symbol.toUpperCase().includes(q) || (r.company_name ?? "").toUpperCase().includes(q);
  const people = useMemo(() => data ? [...new Set(data.latest_events.map((e) => e.person))] : [], [data]);
  const sources = useMemo(() => data ? [...new Set(data.latest_events.map((e) => e.source_title || new URL(e.source_url).hostname))] : [], [data]);

  if (status === "loading") return <Note>載入大佬觀點資料中…</Note>;
  if (status === "error") return <Note>目前無法連線共識資料服務，請稍後再試。</Note>;
  if (!data || data.empty) return <Note>目前尚無足夠觀點資料，累積足夠事件後即會顯示排行。</Note>;

  return <div>
    <div className="flex items-center justify-between">
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="依股票查看（例：NVDA）" className="w-64 rounded-lg border border-white/[0.15] bg-[#0c2137] px-3 py-2 text-[13px] outline-none placeholder:text-slate-500 focus:border-[#e9be6e]" />
      <span className="text-[12px] text-slate-400">涵蓋 {data.coverage_people ?? 0} 位大佬・{data.coverage_sources ?? 0} 個來源・資料日期 {data.as_of_date?.replaceAll("-", "/") ?? "-"}</span>
    </div>

    <div className="grid grid-cols-2 gap-6">
      <div>
        <SectionTitle right="依共識方向">看多排行</SectionTitle>
        <Card>{data.bullish.filter(filterRow).slice(0, 8).map((r) => <Row key={r.symbol}><div className="min-w-0"><b className="truncate">{r.symbol} {r.company_name ?? ""}</b><p className="mt-0.5 text-[11px] text-slate-400">{r.unique_people_count} 位大佬{r.direct_mentions ? `・直接點名 ${r.direct_mentions}` : r.inferred_mentions ? "・關聯推導" : ""}</p></div><b className={strengthColor(r.consensus_score)}>{strengthLabel(r.consensus_score)}</b></Row>)}
          {data.bullish.filter(filterRow).length === 0 && <Row><span className="text-slate-500">無符合資料</span></Row>}
        </Card>
      </div>
      <div>
        <SectionTitle right="依共識方向">看空排行</SectionTitle>
        <Card>{data.bearish.filter(filterRow).slice(0, 8).map((r) => <Row key={r.symbol}><div className="min-w-0"><b className="truncate">{r.symbol} {r.company_name ?? ""}</b><p className="mt-0.5 text-[11px] text-slate-400">{r.unique_people_count} 位大佬{r.direct_mentions ? `・直接點名 ${r.direct_mentions}` : r.inferred_mentions ? "・關聯推導" : ""}</p></div><b className={strengthColor(r.consensus_score)}>{strengthLabel(r.consensus_score)}</b></Row>)}
          {data.bearish.filter(filterRow).length === 0 && <Row><span className="text-slate-500">無符合資料</span></Row>}
        </Card>
      </div>
    </div>

    <SectionTitle right="30日內・同一人立場改變">觀點翻轉</SectionTitle>
    <Card>{(flips ?? []).length === 0 ? <Row><span className="text-slate-500">目前沒有近期觀點翻轉。</span></Row> : (flips ?? []).slice(0, 6).map((f) => <Row key={f.id}><div className="min-w-0"><b>{f.person}・{f.symbol} {f.company_name ?? ""}</b><p className="mt-0.5 text-[11px] text-slate-400">{f.previous_stance_zh} → {f.current_stance_zh}・{relDate(f.current_event_at)}</p></div><span className="text-[11px] text-slate-500">{f.relation_type === "DIRECT" ? "直接點名" : "關聯推導"}</span></Row>)}
    </Card>

    <SectionTitle right={data.as_of_date ? `資料日期 ${data.as_of_date.replaceAll("-", "/")}` : undefined}>大佬最新觀點</SectionTitle>
    <Card>{data.latest_events.slice(0, 8).map((e) => <Row key={e.id}><div className="min-w-0"><b>{e.person}{e.organization ? `（${e.organization}）` : ""}</b><p className="mt-0.5 line-clamp-2 text-[12px] text-slate-300">{e.summary_zh ?? "（摘要整理中）"}</p><p className="mt-0.5 text-[11px] text-slate-500">{relDate(e.event_at)}・來源：{e.source_title ?? e.source_url}{e.direct_symbols.length ? `・直接點名 ${e.direct_symbols.join("、")}` : ""}</p></div></Row>)}</Card>

    <div className="grid grid-cols-2 gap-6">
      <div><SectionTitle>依產業</SectionTitle><Card>{data.sectors.length ? data.sectors.slice(0, 6).map((s) => <Row key={s.sector}><span>{s.sector}</span><b className={strengthColor(s.consensus_score)}>{strengthLabel(s.consensus_score)}</b></Row>) : <Row><span className="text-slate-500">尚無產業層級資料</span></Row>}</Card></div>
      <div><SectionTitle>依人物 / 來源</SectionTitle><Card>
        <Row><span className="text-slate-400">追蹤人物</span><span className="max-w-[70%] truncate text-right">{people.slice(0, 6).join("、") || "—"}</span></Row>
        <Row><span className="text-slate-400">資料來源</span><span className="max-w-[70%] truncate text-right">{sources.slice(0, 6).join("、") || "—"}</span></Row>
      </Card></div>
    </div>
    <p className="mt-6 text-[11px] leading-5 text-slate-500">共識分數為 SmartMatch 依公開發言、來源等級與直接／關聯程度計算，非投資建議。</p>
  </div>;
}

// ---- 國會交易 — /api/mobile/congress-trades (same production API the App uses). Real US House
// PTR disclosures (STOCK Act). Senate not yet ingested. transaction_date and disclosure_date are
// always shown separately — never implies real-time trading.
type CongressRow = { id: string; person_name: string; chamber: string; state: string | null; party: string | null; asset_name: string; ticker: string | null; transaction_type: string; transaction_date: string; disclosure_date: string; amount_min: number | null; amount_max: number | null; owner: string | null; source_url: string; mapped: boolean };
type CongressUniverse = { latest_disclosures: CongressRow[]; recent_buys: CongressRow[]; recent_sells: CongressRow[]; people_covered: number; transactions_covered: number; latest_disclosure_date: string | null };
type CongressTickerPayload = { ticker: string; disclosures: CongressRow[] };
const amountRange = (min: number | null, max: number | null) => min === null ? "未揭露金額" : max !== null && max !== min ? `$${min.toLocaleString()} - $${max.toLocaleString()}` : `$${min.toLocaleString()}`;
const dateSlash = (s: string) => s.replaceAll("-", "/");
const chamberZh = (c: string) => c === "HOUSE" ? "眾議院" : "參議院";

function Congress() {
  const [universe, setUniverse] = useState<CongressUniverse | null>(null);
  const [uStatus, setUStatus] = useState<"loading" | "ready" | "error">("loading");
  const [query, setQuery] = useState("");
  const [searchTicker, setSearchTicker] = useState<string | null>(null);
  const [tickerData, setTickerData] = useState<CongressTickerPayload | null>(null);
  const [tStatus, setTStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    let active = true;
    fetch("/api/mobile/congress-trades", { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject()).then((p: { data: CongressUniverse }) => { if (active) { setUniverse(p.data); setUStatus("ready"); } }).catch(() => { if (active) setUStatus("error"); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!searchTicker) { setTickerData(null); setTStatus("idle"); return; }
    let active = true; setTStatus("loading");
    fetch(`/api/mobile/congress-trades?ticker=${encodeURIComponent(searchTicker)}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject()).then((p: { data: CongressTickerPayload }) => { if (active) { setTickerData(p.data); setTStatus("ready"); } }).catch(() => { if (active) setTStatus("error"); });
    return () => { active = false; };
  }, [searchTicker]);
  const ownerZh = (o: string | null) => o === "Joint" ? "共同持有" : o === "Spouse" ? "配偶" : o === "Dependent Child" ? "受扶養子女" : o;
  const personLine = (r: CongressRow) => `${r.person_name}（${chamberZh(r.chamber)}${r.state ? `・${r.state}` : ""}${r.owner && r.owner !== "Self" ? `・${ownerZh(r.owner)}` : ""}）`;

  return <div>
    <Note>這裡顯示的是美國國會議員依法揭露的股票交易（僅眾議院，參議院尚未接入），屬於「揭露資料」，不是即時交易。此資料為依法揭露資訊，揭露日可能晚於實際交易日。</Note>
    <div className="mt-4 flex gap-2">
      <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && setSearchTicker(query.trim().toUpperCase())} placeholder="依股票代號查看（例：NKE）" className="w-72 rounded-lg border border-white/[0.15] bg-[#0c2137] px-3 py-2 text-[13px] outline-none placeholder:text-slate-500 focus:border-[#e9be6e]" />
      <button onClick={() => setSearchTicker(query.trim().toUpperCase())} className="rounded-lg bg-gradient-to-br from-[#f1cf81] to-[#d9aa52] px-5 py-2 text-[13px] font-black text-[#17212a]">查詢</button>
    </div>
    {searchTicker && <div className="mt-4">
      {tStatus === "loading" && <Note>載入 {searchTicker} 揭露資料中…</Note>}
      {tStatus === "error" && <Note>目前無法連線國會交易資料服務，請稍後再試。</Note>}
      {tStatus === "ready" && tickerData && tickerData.disclosures.length === 0 && <Note>{searchTicker} 目前沒有已揭露的國會交易紀錄。</Note>}
      {tStatus === "ready" && tickerData && tickerData.disclosures.length > 0 && <>
        <SectionTitle>{searchTicker}・依股票查看</SectionTitle>
        <Card>{tickerData.disclosures.map((r) => <Row key={r.id}><div className="min-w-0"><b>{personLine(r)}</b><p className="mt-0.5 text-[11px] text-slate-400">交易日 {dateSlash(r.transaction_date)}・揭露日 {dateSlash(r.disclosure_date)}</p></div><span className={r.transaction_type === "P" ? "text-emerald-400" : "text-rose-400"}>{r.transaction_type === "P" ? "買進" : "賣出"}・{amountRange(r.amount_min, r.amount_max)}</span></Row>)}</Card>
      </>}
    </div>}
    {uStatus === "loading" && <Note>載入國會交易資料中…</Note>}
    {uStatus === "error" && <Note>目前無法連線國會交易資料服務，請稍後再試。</Note>}
    {uStatus === "ready" && universe && universe.transactions_covered === 0 && <div className="mt-6 rounded-[12px] border border-dashed border-white/[0.16] bg-[#0a1d30] py-16 text-center"><b>資料建置中</b><p className="mt-2 text-[12px] text-slate-400">國會交易資料建置中，尚未接入任何揭露來源。</p></div>}
    {uStatus === "ready" && universe && universe.transactions_covered > 0 && <>
      <p className="mt-4 text-[12px] text-slate-400">目前涵蓋 {universe.people_covered} 位議員・{universe.transactions_covered} 筆已揭露交易{universe.latest_disclosure_date ? `・最新揭露日 ${dateSlash(universe.latest_disclosure_date)}` : ""}（僅眾議院）。</p>
      <SectionTitle right="依揭露日排序">最新揭露</SectionTitle>
      <Card>{universe.latest_disclosures.slice(0, 10).map((r) => <Row key={r.id}><div className="min-w-0"><b>{r.ticker ?? r.asset_name}</b><p className="mt-0.5 text-[11px] text-slate-400">{personLine(r)}・交易日 {dateSlash(r.transaction_date)}・揭露日 {dateSlash(r.disclosure_date)}</p></div><span className={r.transaction_type === "P" ? "text-emerald-400" : "text-rose-400"}>{r.transaction_type === "P" ? "買進" : "賣出"}・{amountRange(r.amount_min, r.amount_max)}</span></Row>)}</Card>
      <div className="grid grid-cols-2 gap-6">
        <div><SectionTitle>近期買進</SectionTitle><Card>{universe.recent_buys.slice(0, 8).map((r) => <Row key={r.id}><span>{r.ticker ?? r.asset_name}</span><span className="text-slate-400">{personLine(r)}</span></Row>)}</Card></div>
        <div><SectionTitle>近期賣出</SectionTitle><Card>{universe.recent_sells.slice(0, 8).map((r) => <Row key={r.id}><span>{r.ticker ?? r.asset_name}</span><span className="text-slate-400">{personLine(r)}</span></Row>)}</Card></div>
      </div>
    </>}
  </div>;
}

// ---- 內部人交易 — /api/mobile/insider-trades (same production API the App uses). Real SEC Form 4
// data via canonical CIK->security_id mapping. Only transaction code P/S is ever shown as 買進/賣出;
// grants, option exercises, gifts and tax-withholding dispositions are bucketed separately.
type InsiderRow = { id: string; person_name: string; title: string | null; ticker: string; company: string; transaction_code: string; transaction_type: string; transaction_type_zh: string; shares: number; price: number | null; transaction_value: number | null; transaction_date: string; filing_date: string | null };
type InsiderUniverse = { latest_transactions: InsiderRow[]; insider_buys: InsiderRow[]; insider_sells: InsiderRow[]; issuers_covered: number; transactions_covered: number; transactions_last_30d: number };
type InsiderTickerPayload = { ticker: string; transactions: InsiderRow[] };
const insiderValueFmt = (n: number | null) => n === null ? "未揭露" : `$${Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + "M" : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + "K" : n.toFixed(0)}`;

function Insider() {
  const [universe, setUniverse] = useState<InsiderUniverse | null>(null);
  const [uStatus, setUStatus] = useState<"loading" | "ready" | "error">("loading");
  const [query, setQuery] = useState("");
  const [searchTicker, setSearchTicker] = useState<string | null>(null);
  const [tickerData, setTickerData] = useState<InsiderTickerPayload | null>(null);
  const [tStatus, setTStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    let active = true;
    fetch("/api/mobile/insider-trades", { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject()).then((p: { data: InsiderUniverse }) => { if (active) { setUniverse(p.data); setUStatus("ready"); } }).catch(() => { if (active) setUStatus("error"); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!searchTicker) { setTickerData(null); setTStatus("idle"); return; }
    let active = true; setTStatus("loading");
    fetch(`/api/mobile/insider-trades?ticker=${encodeURIComponent(searchTicker)}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject()).then((p: { data: InsiderTickerPayload }) => { if (active) { setTickerData(p.data); setTStatus("ready"); } }).catch(() => { if (active) setTStatus("error"); });
    return () => { active = false; };
  }, [searchTicker]);
  const rowDetail = (r: InsiderRow) => `${r.person_name}${r.title ? `・${r.title}` : ""}`;

  return <div>
    <Note>這裡顯示的是公司董事、高階主管與重要內部人依法揭露的交易紀錄（SEC Form 4）。目前優先涵蓋大型美股，資料範圍持續擴充中。</Note>
    <div className="mt-4 flex gap-2">
      <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && setSearchTicker(query.trim().toUpperCase())} placeholder="依股票代號查看（例：NVDA）" className="w-72 rounded-lg border border-white/[0.15] bg-[#0c2137] px-3 py-2 text-[13px] outline-none placeholder:text-slate-500 focus:border-[#e9be6e]" />
      <button onClick={() => setSearchTicker(query.trim().toUpperCase())} className="rounded-lg bg-gradient-to-br from-[#f1cf81] to-[#d9aa52] px-5 py-2 text-[13px] font-black text-[#17212a]">查詢</button>
    </div>
    {searchTicker && <div className="mt-4">
      {tStatus === "loading" && <Note>載入 {searchTicker} 內部人交易中…</Note>}
      {tStatus === "error" && <Note>目前無法連線內部人交易資料服務，請稍後再試。</Note>}
      {tStatus === "ready" && tickerData && tickerData.transactions.length === 0 && <Note>{searchTicker} 目前尚無已收錄的內部人交易紀錄。</Note>}
      {tStatus === "ready" && tickerData && tickerData.transactions.length > 0 && <>
        <SectionTitle>{searchTicker}・最新交易</SectionTitle>
        <Card>{tickerData.transactions.slice(0, 15).map((r) => <Row key={r.id}><div className="min-w-0"><b>{rowDetail(r)}</b><p className="mt-0.5 text-[11px] text-slate-400">{r.transaction_type_zh}・交易日 {dateSlash(r.transaction_date)}</p></div><span className="text-slate-300">{r.shares.toLocaleString()} 股{r.transaction_value !== null ? `・${insiderValueFmt(r.transaction_value)}` : ""}</span></Row>)}</Card>
      </>}
    </div>}
    {uStatus === "loading" && <Note>載入內部人交易資料中…</Note>}
    {uStatus === "error" && <Note>目前無法連線內部人交易資料服務，請稍後再試。</Note>}
    {uStatus === "ready" && universe && universe.transactions_covered === 0 && <div className="mt-6 rounded-[12px] border border-dashed border-white/[0.16] bg-[#0a1d30] py-16 text-center"><b>資料建置中</b><p className="mt-2 text-[12px] text-slate-400">內部人交易資料建置中，目前資料涵蓋範圍尚不足以顯示完整列表。</p></div>}
    {uStatus === "ready" && universe && universe.transactions_covered > 0 && <>
      <p className="mt-4 text-[12px] text-slate-400">目前涵蓋 {universe.issuers_covered} 家公司・{universe.transactions_covered} 筆交易・近 30 天 {universe.transactions_last_30d} 筆。</p>
      <SectionTitle right="依交易日排序">最新交易</SectionTitle>
      <Card>{universe.latest_transactions.slice(0, 10).map((r) => <Row key={r.id}><div className="min-w-0"><b>{r.ticker}</b><p className="mt-0.5 text-[11px] text-slate-400">{rowDetail(r)}・{r.transaction_type_zh}・{dateSlash(r.transaction_date)}</p></div><span className="text-slate-300">{r.shares.toLocaleString()} 股{r.transaction_value !== null ? `・${insiderValueFmt(r.transaction_value)}` : ""}</span></Row>)}</Card>
      <div className="grid grid-cols-2 gap-6">
        <div><SectionTitle>內部人買進</SectionTitle><Card>{universe.insider_buys.length ? universe.insider_buys.slice(0, 8).map((r) => <Row key={r.id}><span>{r.ticker}</span><span className="text-slate-400">{rowDetail(r)}・{r.shares.toLocaleString()} 股</span></Row>) : <Row><span className="text-slate-500">目前涵蓋範圍內沒有公開市場買進紀錄</span></Row>}</Card></div>
        <div><SectionTitle>內部人賣出</SectionTitle><Card>{universe.insider_sells.slice(0, 8).map((r) => <Row key={r.id}><span>{r.ticker}</span><span className="text-slate-400">{rowDetail(r)}・{r.shares.toLocaleString()} 股</span></Row>)}</Card></div>
      </div>
    </>}
  </div>;
}

// ---- 機構持股 — /api/mobile/institutional-holdings (same production API the App uses)
type MoverRow = { ticker: string; company_name: string; manager_name: string; report_period: string; shares: number; market_value: number; shares_change?: number; value_change?: number };
type UniversePayload = { latest_report_date: string | null; top_increases: MoverRow[]; top_decreases: MoverRow[]; latest_13f: MoverRow[]; mapped_ticker_count: number };
type HolderRow = { manager_name: string; report_period: string; shares: number; market_value: number; weight: number | null; shares_change?: number };
type TickerPayload = { ticker: string; mapped: boolean; latest_report_date: string | null; latest_holders: HolderRow[]; increased: HolderRow[]; decreased: HolderRow[] };
const sharesFmt = (n: number) => Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n));
const valueFmt = (n: number) => `$${Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(2) + "B" : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + "M" : (n / 1e3).toFixed(0) + "K"}`;

function Institutional() {
  const [universe, setUniverse] = useState<UniversePayload | null>(null);
  const [uStatus, setUStatus] = useState<"loading" | "ready" | "error">("loading");
  const [query, setQuery] = useState("");
  const [searchTicker, setSearchTicker] = useState<string | null>(null);
  const [tickerData, setTickerData] = useState<TickerPayload | null>(null);
  const [tStatus, setTStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [manager, setManager] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/mobile/institutional-holdings", { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject()).then((p: { data: UniversePayload }) => { if (active) { setUniverse(p.data); setUStatus("ready"); } }).catch(() => { if (active) setUStatus("error"); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!searchTicker) { setTickerData(null); setTStatus("idle"); return; }
    let active = true; setTStatus("loading");
    fetch(`/api/mobile/institutional-holdings?ticker=${encodeURIComponent(searchTicker)}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject()).then((p: { data: TickerPayload }) => { if (active) { setTickerData(p.data); setTStatus("ready"); } }).catch(() => { if (active) setTStatus("error"); });
    return () => { active = false; };
  }, [searchTicker]);

  const managers = useMemo(() => universe ? [...new Set(universe.latest_13f.map((r) => r.manager_name))] : [], [universe]);
  const filteredLatest = useMemo(() => !universe ? [] : manager ? universe.latest_13f.filter((r) => r.manager_name === manager) : universe.latest_13f, [universe, manager]);

  return <div>
    <Note>這裡顯示的是大型機構（13F Manager）對個股的持股與季度增減變化，資料來源為 SEC EDGAR 13F 公開申報。</Note>
    <div className="mt-4 flex gap-2">
      <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && setSearchTicker(query.trim().toUpperCase())} placeholder="依股票代號查看（例：NVDA）" className="w-72 rounded-lg border border-white/[0.15] bg-[#0c2137] px-3 py-2 text-[13px] outline-none placeholder:text-slate-500 focus:border-[#e9be6e]" />
      <button onClick={() => setSearchTicker(query.trim().toUpperCase())} className="rounded-lg bg-gradient-to-br from-[#f1cf81] to-[#d9aa52] px-5 py-2 text-[13px] font-black text-[#17212a]">查詢</button>
    </div>
    {searchTicker && <div className="mt-4">
      {tStatus === "loading" && <Note>載入 {searchTicker} 機構持股中…</Note>}
      {tStatus === "error" && <Note>目前無法連線機構持股資料服務，請稍後再試。</Note>}
      {tStatus === "ready" && tickerData && !tickerData.mapped && <Note>{searchTicker} 目前尚未完成個股對應，暫無法顯示機構持股（涵蓋範圍持續擴充中）。</Note>}
      {tStatus === "ready" && tickerData?.mapped && <>
        <SectionTitle right={tickerData.latest_report_date ? `最新申報季度 ${tickerData.latest_report_date.replaceAll("-", "/")}` : undefined}>{searchTicker}・最新機構持有</SectionTitle>
        <Card>{tickerData.latest_holders.slice(0, 10).map((h) => <Row key={h.manager_name}><span>{h.manager_name}</span><span className="text-slate-300">{sharesFmt(h.shares)} 股・{valueFmt(h.market_value)}{h.weight ? `・${(h.weight * 100).toFixed(2)}%` : ""}</span></Row>)}</Card>
      </>}
    </div>}

    {uStatus === "loading" && <Note>載入機構持股資料中…</Note>}
    {uStatus === "error" && <Note>目前無法連線機構持股資料服務，請稍後再試。</Note>}
    {uStatus === "ready" && universe && universe.mapped_ticker_count === 0 && <div className="mt-6 rounded-[12px] border border-dashed border-white/[0.16] bg-[#0a1d30] py-16 text-center"><b>資料建置中</b></div>}
    {uStatus === "ready" && universe && universe.mapped_ticker_count > 0 && <>
      <p className="mt-4 text-[12px] text-slate-400">目前僅涵蓋 {universe.mapped_ticker_count} 檔已完成個股對應的股票（來自 15 家機構的 SEC 13F 申報），涵蓋範圍持續擴充中，非全市場機構持股總覽。</p>
      <div className="grid grid-cols-2 gap-6">
        <div><SectionTitle right={universe.latest_report_date ? `最新申報季度 ${universe.latest_report_date.replaceAll("-", "/")}` : undefined}>熱門增持</SectionTitle>
          <Card>{universe.top_increases.slice(0, 8).map((m, i) => <Row key={`${m.ticker}${i}`}><div className="min-w-0"><b>{m.ticker}</b><p className="text-[11px] text-slate-400">{m.manager_name}</p></div><b className="text-emerald-400">+{sharesFmt(m.shares_change ?? 0)}</b></Row>)}</Card></div>
        <div><SectionTitle right={universe.latest_report_date ? `最新申報季度 ${universe.latest_report_date.replaceAll("-", "/")}` : undefined}>熱門減持</SectionTitle>
          <Card>{universe.top_decreases.slice(0, 8).map((m, i) => <Row key={`${m.ticker}${i}`}><div className="min-w-0"><b>{m.ticker}</b><p className="text-[11px] text-slate-400">{m.manager_name}</p></div><b className="text-rose-400">{sharesFmt(m.shares_change ?? 0)}</b></Row>)}</Card></div>
      </div>
      <SectionTitle right="依機構查看">最新 13F</SectionTitle>
      <div className="mb-2 flex flex-wrap gap-2">
        <button onClick={() => setManager(null)} className={`rounded-full border px-3 py-1 text-[12px] ${manager === null ? "border-[#e9be6e] text-[#f2c66e]" : "border-white/[0.15] text-slate-400"}`}>全部機構</button>
        {managers.map((m) => <button key={m} onClick={() => setManager(m)} className={`rounded-full border px-3 py-1 text-[12px] ${manager === m ? "border-[#e9be6e] text-[#f2c66e]" : "border-white/[0.15] text-slate-400"}`}>{m}</button>)}
      </div>
      <Card>{filteredLatest.slice(0, 12).map((m, i) => <Row key={`${m.ticker}${m.manager_name}${i}`}><div className="min-w-0"><b>{m.ticker}</b> {m.company_name}<p className="text-[11px] text-slate-400">{m.manager_name}</p></div><span className="text-slate-300">{sharesFmt(m.shares)} 股・{valueFmt(m.market_value)}</span></Row>)}</Card>
    </>}
  </div>;
}
