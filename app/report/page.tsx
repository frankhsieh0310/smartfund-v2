"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ETF_LIST } from "../etf/data";
import { FUND_LIST } from "../funds/data";

// ── 人格 type ─────────────────────────────────────────────────────────
type PersonalityKey = "conservative" | "balanced" | "growth" | "aggressive";
function isPersonalityKey(v: string | null): v is PersonalityKey {
  return v === "conservative" || v === "balanced" || v === "growth" || v === "aggressive";
}

// ── 配置規則 ──────────────────────────────────────────────────────────
type Allocation = { title: string; riskLabel: string; summary: string; stock: number; bond: number; cash: number };
const RULES: Record<PersonalityKey, Allocation> = {
  conservative: { title: "保守型", riskLabel: "風險承受度：中低", summary: "你重視資產的安全與穩定，對虧損的容忍度較低。配置以債券與現金為核心，少量股票資產提供基本成長動能。", stock: 15, bond: 60, cash: 25 },
  balanced:     { title: "穩健型", riskLabel: "風險承受度：中等", summary: "你希望在風險與報酬之間取得平衡，能接受一定程度的波動。股票與債券均衡配置，兼顧成長與穩定。",       stock: 50, bond: 30, cash: 20 },
  growth:       { title: "成長型", riskLabel: "風險承受度：中高", summary: "你願意承擔較高波動以追求資產成長，投資期間較長。以股票資產為主力，債券配置提供緩衝。",             stock: 70, bond: 22, cash:  8 },
  aggressive:   { title: "積極型", riskLabel: "風險承受度：高",   summary: "你能承受高度波動，追求長期最大化報酬。以高成長股票資產為核心，少量債券提供基本穩定性。",             stock: 85, bond: 10, cash:  5 },
};

// ── 商品篩選引擎（每組最多 3 檔）────────────────────────────────────
type EtfGroup  = { label: string; items: typeof ETF_LIST };
type FundGroup = { label: string; items: typeof FUND_LIST };
const TOP = 3;
const byR = (a: {return1y:number}, b: {return1y:number}) => b.return1y - a.return1y;

function getEtfGroups(key: PersonalityKey): EtfGroup[] {
  if (key === "conservative") return [
    { label: "市值型 ETF",  items: ETF_LIST.filter(e => e.sector === "市值型"  && e.region === "台灣").sort(byR).slice(0, TOP) },
    { label: "收益型 ETF",  items: ETF_LIST.filter(e => e.sector === "高股息").sort(byR).slice(0, TOP) },
    { label: "債券 ETF",    items: ETF_LIST.filter(e => e.sector === "債券").sort(byR).slice(0, TOP) },
  ];
  if (key === "balanced") return [
    { label: "市值型 ETF",  items: ETF_LIST.filter(e => e.sector === "市值型").sort(byR).slice(0, TOP) },
    { label: "收益型 ETF",  items: ETF_LIST.filter(e => e.sector === "高股息").sort(byR).slice(0, TOP) },
    { label: "債券 ETF",    items: ETF_LIST.filter(e => e.sector === "債券").sort(byR).slice(0, TOP) },
  ];
  if (key === "growth") return [
    { label: "市值型 ETF",        items: ETF_LIST.filter(e => e.sector === "市值型").sort(byR).slice(0, TOP) },
    { label: "科技產業 ETF",      items: ETF_LIST.filter(e => e.sector === "科技" || e.sector === "半導體").sort(byR).slice(0, TOP) },
    { label: "收益型 ETF",        items: ETF_LIST.filter(e => e.sector === "高股息").sort(byR).slice(0, TOP) },
  ];
  return [
    { label: "科技 / 半導體 ETF", items: ETF_LIST.filter(e => e.sector === "科技" || e.sector === "半導體" || e.sector === "創新科技").sort(byR).slice(0, TOP) },
    { label: "市值型 ETF",        items: ETF_LIST.filter(e => e.sector === "市值型" && e.region === "美國").sort(byR).slice(0, TOP) },
    { label: "主動式 ETF",        items: ETF_LIST.filter(e => e.sector === "主動式" || e.sector === "成長型").sort(byR).slice(0, TOP) },
  ];
}

function getFundGroups(key: PersonalityKey): FundGroup[] {
  if (key === "conservative") return [
    { label: "收益型基金",   items: FUND_LIST.filter(f => f.category === "債券型" && f.dividendYieldA > 4).sort(byR).slice(0, TOP) },
    { label: "平衡型基金",   items: FUND_LIST.filter(f => f.category === "平衡型").sort(byR).slice(0, TOP) },
  ];
  if (key === "balanced") return [
    { label: "平衡型基金",   items: FUND_LIST.filter(f => f.category === "平衡型").sort(byR).slice(0, TOP) },
    { label: "收益型基金",   items: FUND_LIST.filter(f => f.category === "債券型" && f.dividendYieldA > 4).sort(byR).slice(0, TOP) },
    { label: "全球股票型基金", items: FUND_LIST.filter(f => f.category === "股票型" && f.region === "全球").sort(byR).slice(0, TOP) },
  ];
  if (key === "growth") return [
    { label: "全球股票型基金", items: FUND_LIST.filter(f => f.category === "股票型" && (f.region === "全球" || f.region === "美國")).sort(byR).slice(0, TOP) },
    { label: "科技主題基金",   items: FUND_LIST.filter(f => f.name.includes("科技") || f.name.includes("AI")).sort(byR).slice(0, TOP) },
    { label: "平衡型基金",     items: FUND_LIST.filter(f => f.category === "平衡型").sort(byR).slice(0, TOP) },
  ];
  return [
    { label: "高成長股票型基金",   items: FUND_LIST.filter(f => f.category === "股票型" && f.volatility > 18).sort(byR).slice(0, TOP) },
    { label: "科技 / AI 主題基金", items: FUND_LIST.filter(f => f.name.includes("科技") || f.name.includes("AI") || f.name.includes("人工智能")).sort(byR).slice(0, TOP) },
    { label: "新興市場基金",       items: FUND_LIST.filter(f => f.category === "股票型" && (f.region === "新興市場" || f.region === "印度")).sort(byR).slice(0, TOP) },
  ];
}

// ── localStorage helpers ──────────────────────────────────────────────
type ListItem = { id: string; type: "etf" | "fund"; name: string };
const KEY_FAV = "favorites";
const KEY_CMP = "compareList";
const KEY_CLI = "smartmatch_clients";
function loadList(key: string): ListItem[] { try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; } }
function saveList(key: string, list: ListItem[]) { localStorage.setItem(key, JSON.stringify(list)); }
function loadClients(): unknown[] { try { return JSON.parse(localStorage.getItem(KEY_CLI) || "[]"); } catch { return []; } }
function saveClients(c: unknown[]) { localStorage.setItem(KEY_CLI, JSON.stringify(c)); }
function newId() { return `${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }

// ── helpers ───────────────────────────────────────────────────────────
function Stars({ n }: { n: number }) { return <span className="text-[#F5B700] text-[13px]">{"★".repeat(n)}</span>; }
function Pct({ v }: { v: number }) {
  return <span className={v >= 0 ? "text-emerald-400 font-semibold" : "text-red-400 font-semibold"}>{v >= 0 ? "+" : ""}{v.toFixed(1)}%</span>;
}

// ── PDF export ────────────────────────────────────────────────────────
async function generatePdf(el: HTMLDivElement, filename: string) {
  // @ts-ignore
  if (!window.html2pdf) {
    await new Promise<void>((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
      s.onload = () => res(); s.onerror = () => rej();
      document.head.appendChild(s);
    });
  }
  // @ts-ignore
  await window.html2pdf().set({
    margin: [10,10,10,10], filename,
    image: { type:"jpeg", quality:0.95 },
    html2canvas: { scale:2, useCORS:true, backgroundColor:"#020817" },
    jsPDF: { unit:"mm", format:"a4", orientation:"portrait" },
    pagebreak: { mode:["avoid-all","css"] },
  }).from(el).save();
}

// ── Toast ─────────────────────────────────────────────────────────────
function Toast({ msg, onClose }: { msg: string; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 2500); return () => clearTimeout(t); }, [onClose]);
  return (
    <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[999] bg-[#1a2540] border border-white/20 text-white text-[14px] font-semibold px-6 py-3 rounded-full shadow-xl">
      {msg}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────
function ReportContent() {
  const searchParams = useSearchParams();
  const typeParam  = searchParams.get("type");
  const clientName = searchParams.get("client") || "";
  const scoreParam = searchParams.get("score")  || "";
  const clientId   = searchParams.get("clientId") || "";

  const type: PersonalityKey = isPersonalityKey(typeParam) ? typeParam : "balanced";
  const rule      = RULES[type];
  const etfGroups  = getEtfGroups(type);
  const fundGroups = getFundGroups(type);
  const today = new Date().toLocaleDateString("zh-TW", { year:"numeric", month:"2-digit", day:"2-digit" });
  const pdfRef = useRef<HTMLDivElement>(null);

  // Section 5 state
  const [toast,        setToast]        = useState<string | null>(null);
  const [savedClient,  setSavedClient]  = useState(false);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveName,     setSaveName]     = useState(clientName);
  const [favCount,     setFavCount]     = useState(0);
  const [cmpCount,     setCmpCount]     = useState(0);

  useEffect(() => {
    setFavCount(loadList(KEY_FAV).length);
    setCmpCount(loadList(KEY_CMP).length);
    if (clientId) {
      const c = loadClients() as {id:string}[];
      setSavedClient(!!c.find(x => x.id === clientId));
    }
  }, [clientId]);

  const alloc = [
    { label: "股票資產", value: rule.stock, color: "#F5B700" },
    { label: "債券資產", value: rule.bond,  color: "#64748b" },
    { label: "現金部位", value: rule.cash,  color: "#334155" },
  ];

  // 取得所有篩選結果的商品列表
  const allEtfs  = etfGroups.flatMap(g => g.items);
  const allFunds = fundGroups.flatMap(g => g.items);

  // ── Section 5 handlers ────────────────────────────────────────────
  function handleFavAll() {
    const store = loadList(KEY_FAV);
    let added = 0;
    const next = [...store];
    allEtfs.forEach(e => {
      if (!next.find(x => x.id === e.code)) { next.push({ id: e.code, type: "etf", name: e.name }); added++; }
    });
    allFunds.forEach(f => {
      if (!next.find(x => x.id === f.id)) { next.push({ id: f.id, type: "fund", name: f.name }); added++; }
    });
    saveList(KEY_FAV, next);
    setFavCount(next.length);
    setToast(`⭐ 已加入收藏 ${added} 檔商品`);
  }

  function handleCmpAll() {
    const store = loadList(KEY_CMP);
    let added = 0;
    const next = [...store];
    [...allEtfs, ...allFunds].forEach(item => {
      const id = "code" in item ? item.code : item.id;
      const type = "code" in item ? "etf" as const : "fund" as const;
      if (next.length < 10 && !next.find(x => x.id === id)) {
        next.push({ id, type, name: item.name }); added++;
      }
    });
    saveList(KEY_CMP, next);
    setCmpCount(next.length);
    setToast(`📊 已加入比較清單 ${added} 檔商品`);
  }

  function handleSaveClient() {
    if (!saveName.trim()) return;
    const clients = loadClients() as {id:string;name:string}[];
    if (clientId) {
      const updated = clients.map(c =>
        c.id === clientId
          ? { ...c, personality: type, personalityScore: scoreParam ? parseInt(scoreParam) : 0, updatedAt: new Date().toISOString() }
          : c
      );
      saveClients(updated);
    } else {
      if (clients.length >= 10) { setToast("免費版最多 10 位客戶，請升級方案"); return; }
      const now = new Date().toISOString();
      saveClients([...clients, {
        id: newId(), name: saveName.trim(),
        personality: type, personalityScore: scoreParam ? parseInt(scoreParam) : 0,
        notes: "", createdAt: now, updatedAt: now, meetings: [],
      }]);
    }
    setSavedClient(true);
    setShowSaveForm(false);
    setToast("👤 已儲存至客戶管理中心");
  }

  function handleExportPdf() {
    if (!pdfRef.current) return;
    const fn = clientName
      ? `SmartMatch_${clientName}_${type}_${today}.pdf`
      : `SmartMatch_${type}_${today}.pdf`;
    generatePdf(pdfRef.current, fn);
  }

  return (
    <main className="min-h-screen px-4 pt-28 pb-20">

      {/* NAVBAR */}
      <header className="fixed top-0 left-0 w-full z-50 bg-[#040a18]/85 backdrop-blur-xl border-b border-white/[0.08]">
        <div className="max-w-[1700px] mx-auto h-20 px-10 flex items-center justify-between">
          <Link href="/">
            <div className="text-[28px] font-black text-white leading-none">Smart<span className="text-[#F5B700]">Match</span></div>
            <div className="text-[11px] text-slate-400 mt-0.5">ETF & 基金資產配置分析平台</div>
          </Link>
          <nav className="hidden lg:flex gap-7 text-[14px] font-semibold text-slate-300">
            <Link href="/quiz"    className="hover:text-white transition-colors">投資人格分析</Link>
            <Link href="/etf"     className="hover:text-white transition-colors">ETF篩選器</Link>
            <Link href="/funds"   className="hover:text-white transition-colors">基金篩選器</Link>
            <Link href="/compare" className="hover:text-white transition-colors">比較中心</Link>
            <Link href="/clients" className="hover:text-white transition-colors">客戶管理</Link>
            <Link href="/pricing" className="hover:text-white transition-colors">方案</Link>
          </nav>
          <button onClick={handleExportPdf}
            className="flex items-center gap-2 bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-5 py-2 rounded-lg font-bold text-[14px] transition-colors">
            ⬇ 匯出 PDF
          </button>
        </div>
      </header>

      {/* ── PDF 內容區（隱藏用於匯出）───────────────────────────── */}
      <div ref={pdfRef} style={{ position:"absolute", left:"-9999px", top:0, width:"210mm", backgroundColor:"#020817", color:"#fff", fontFamily:"sans-serif" }}>

        {/* 封面 */}
        <div style={{ minHeight:"270mm", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", backgroundColor:"#020817", padding:"40px", pageBreakAfter:"always" }}>
          <div style={{ fontSize:"12px", letterSpacing:"8px", color:"#F5B700", marginBottom:"20px", fontWeight:700 }}>SMARTMATCH</div>
          <div style={{ fontSize:"38px", fontWeight:900, color:"#fff", textAlign:"center", marginBottom:"8px" }}>投資人格分析報告</div>
          <div style={{ width:"50px", height:"3px", backgroundColor:"#F5B700", margin:"16px auto 28px" }} />
          {clientName && <div style={{ fontSize:"18px", color:"#94a3b8", marginBottom:"8px" }}>客戶姓名：<span style={{ color:"#fff", fontWeight:700 }}>{clientName}</span></div>}
          <div style={{ fontSize:"14px", color:"#64748b", marginBottom:"6px" }}>分析日期：{today}</div>
          {scoreParam && <div style={{ fontSize:"13px", color:"#64748b" }}>問卷總分：{scoreParam} 分</div>}
          <div style={{ marginTop:"40px", fontSize:"12px", color:"#334155", textAlign:"center" }}>SmartMatch｜瑞宇智庫｜contact@smartmatch.tw</div>
        </div>

        {/* Section 1：人格分析 */}
        <div style={{ minHeight:"220mm", backgroundColor:"#020817", padding:"40px", pageBreakAfter:"always" }}>
          <div style={{ fontSize:"10px", letterSpacing:"6px", color:"#F5B700", fontWeight:700, marginBottom:"14px" }}>SECTION 1 · 投資人格分析</div>
          <div style={{ fontSize:"13px", color:"#64748b", marginBottom:"6px" }}>投資人格分析結果</div>
          <div style={{ fontSize:"48px", fontWeight:900, color:"#fff", marginBottom:"6px" }}>{rule.title}</div>
          <div style={{ fontSize:"13px", color:"#64748b", marginBottom:"24px" }}>{rule.riskLabel}</div>
          <div style={{ backgroundColor:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:"12px", padding:"24px" }}>
            <div style={{ fontSize:"14px", color:"#94a3b8", lineHeight:"1.9" }}>{rule.summary}</div>
          </div>
        </div>

        {/* Section 2：配置分析 */}
        <div style={{ minHeight:"200mm", backgroundColor:"#020817", padding:"40px", pageBreakAfter:"always" }}>
          <div style={{ fontSize:"10px", letterSpacing:"6px", color:"#F5B700", fontWeight:700, marginBottom:"14px" }}>SECTION 2 · 配置分析</div>
          <div style={{ fontSize:"26px", fontWeight:700, color:"#fff", marginBottom:"24px" }}>資產配置分析</div>
          <div style={{ display:"flex", height:"18px", borderRadius:"9px", overflow:"hidden", marginBottom:"20px" }}>
            {alloc.map(a => <div key={a.label} style={{ width:`${a.value}%`, backgroundColor:a.color }} />)}
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"14px" }}>
            {alloc.map(a => (
              <div key={a.label} style={{ backgroundColor:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:"10px", padding:"16px" }}>
                <div style={{ display:"flex", alignItems:"center", gap:"6px", marginBottom:"6px" }}>
                  <div style={{ width:"8px", height:"8px", backgroundColor:a.color, borderRadius:"2px" }} />
                  <div style={{ fontSize:"12px", color:"#94a3b8" }}>{a.label}</div>
                </div>
                <div style={{ fontSize:"36px", fontWeight:900, color:"#fff" }}>{a.value}%</div>
              </div>
            ))}
          </div>
        </div>

        {/* Section 3：ETF 篩選結果 */}
        <div style={{ minHeight:"240mm", backgroundColor:"#020817", padding:"40px", pageBreakAfter:"always" }}>
          <div style={{ fontSize:"10px", letterSpacing:"6px", color:"#F5B700", fontWeight:700, marginBottom:"14px" }}>SECTION 3 · ETF 篩選結果</div>
          <div style={{ fontSize:"26px", fontWeight:700, color:"#fff", marginBottom:"6px" }}>ETF 篩選結果</div>
          <div style={{ fontSize:"12px", color:"#64748b", marginBottom:"24px" }}>以下為依據本次配置分析條件，從 ETF 資料庫篩選出的商品，依近一年績效排序。</div>
          {etfGroups.map(g => (
            <div key={g.label} style={{ marginBottom:"20px" }}>
              <div style={{ display:"flex", alignItems:"center", gap:"6px", marginBottom:"8px" }}>
                <div style={{ width:"3px", height:"14px", backgroundColor:"#F5B700", borderRadius:"2px" }} />
                <div style={{ fontSize:"12px", fontWeight:600, color:"#cbd5e1" }}>{g.label}</div>
              </div>
              <table style={{ width:"100%", borderCollapse:"collapse" }}>
                <thead><tr style={{ backgroundColor:"rgba(255,255,255,0.04)" }}>
                  <th style={{ padding:"6px 10px", textAlign:"left", fontSize:"10px", color:"#64748b", width:"70px" }}>代碼</th>
                  <th style={{ padding:"6px 10px", textAlign:"left", fontSize:"10px", color:"#64748b" }}>商品名稱</th>
                  <th style={{ padding:"6px 10px", textAlign:"right", fontSize:"10px", color:"#64748b" }}>殖利率</th>
                  <th style={{ padding:"6px 10px", textAlign:"right", fontSize:"10px", color:"#64748b" }}>近1年</th>
                  <th style={{ padding:"6px 10px", textAlign:"right", fontSize:"10px", color:"#64748b" }}>波動度</th>
                </tr></thead>
                <tbody>
                  {g.items.map((e, i) => (
                    <tr key={e.code} style={{ backgroundColor: i%2===1?"rgba(255,255,255,0.02)":"transparent", borderTop:"1px solid rgba(255,255,255,0.05)" }}>
                      <td style={{ padding:"6px 10px", fontSize:"12px", fontWeight:700, color:"#F5B700" }}>{e.code}</td>
                      <td style={{ padding:"6px 10px", fontSize:"11px", color:"#cbd5e1" }}>{e.name.slice(0,26)}</td>
                      <td style={{ padding:"6px 10px", fontSize:"11px", color:"#94a3b8", textAlign:"right" }}>{e.dividendYield>0?`${e.dividendYield.toFixed(1)}%`:"—"}</td>
                      <td style={{ padding:"6px 10px", fontSize:"11px", textAlign:"right", color:e.return1y>=0?"#34d399":"#f87171", fontWeight:600 }}>{e.return1y>=0?"+":""}{e.return1y.toFixed(1)}%</td>
                      <td style={{ padding:"6px 10px", fontSize:"11px", color:"#94a3b8", textAlign:"right" }}>{e.volatility.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {/* Section 4：基金篩選結果 */}
        <div style={{ minHeight:"240mm", backgroundColor:"#020817", padding:"40px", pageBreakAfter:"always" }}>
          <div style={{ fontSize:"10px", letterSpacing:"6px", color:"#F5B700", fontWeight:700, marginBottom:"14px" }}>SECTION 4 · 基金篩選結果</div>
          <div style={{ fontSize:"26px", fontWeight:700, color:"#fff", marginBottom:"6px" }}>基金篩選結果</div>
          <div style={{ fontSize:"12px", color:"#64748b", marginBottom:"24px" }}>以下為依據本次配置分析條件，從基金資料庫篩選出的商品，依近一年績效排序。</div>
          {fundGroups.map(g => (
            <div key={g.label} style={{ marginBottom:"20px" }}>
              <div style={{ display:"flex", alignItems:"center", gap:"6px", marginBottom:"8px" }}>
                <div style={{ width:"3px", height:"14px", backgroundColor:"#F5B700", borderRadius:"2px" }} />
                <div style={{ fontSize:"12px", fontWeight:600, color:"#cbd5e1" }}>{g.label}</div>
              </div>
              <table style={{ width:"100%", borderCollapse:"collapse" }}>
                <thead><tr style={{ backgroundColor:"rgba(255,255,255,0.04)" }}>
                  <th style={{ padding:"6px 10px", textAlign:"left", fontSize:"10px", color:"#64748b", width:"56px" }}>公司</th>
                  <th style={{ padding:"6px 10px", textAlign:"left", fontSize:"10px", color:"#64748b" }}>基金名稱</th>
                  <th style={{ padding:"6px 10px", textAlign:"center", fontSize:"10px", color:"#64748b" }}>晨星</th>
                  <th style={{ padding:"6px 10px", textAlign:"right", fontSize:"10px", color:"#64748b" }}>年化配息</th>
                  <th style={{ padding:"6px 10px", textAlign:"right", fontSize:"10px", color:"#64748b" }}>近1年</th>
                </tr></thead>
                <tbody>
                  {g.items.map((f, i) => (
                    <tr key={f.id} style={{ backgroundColor: i%2===1?"rgba(255,255,255,0.02)":"transparent", borderTop:"1px solid rgba(255,255,255,0.05)" }}>
                      <td style={{ padding:"6px 10px", fontSize:"11px", fontWeight:700, color:"#fff" }}>{f.company}</td>
                      <td style={{ padding:"6px 10px", fontSize:"10px", color:"#cbd5e1" }}>{f.name.slice(0,22)}</td>
                      <td style={{ padding:"6px 10px", fontSize:"11px", color:"#F5B700", textAlign:"center" }}>{"★".repeat(f.morningstar)}</td>
                      <td style={{ padding:"6px 10px", fontSize:"11px", color:"#F5B700", textAlign:"right", fontWeight:600 }}>{f.dividendYieldA>0?`${f.dividendYieldA.toFixed(1)}%`:"—"}</td>
                      <td style={{ padding:"6px 10px", fontSize:"11px", textAlign:"right", color:f.return1y>=0?"#34d399":"#f87171", fontWeight:600 }}>{f.return1y>=0?"+":""}{f.return1y.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {/* 免責聲明 */}
        <div style={{ backgroundColor:"#020817", padding:"40px" }}>
          <div style={{ fontSize:"10px", letterSpacing:"6px", color:"#F5B700", fontWeight:700, marginBottom:"14px" }}>DISCLAIMER · 免責聲明</div>
          <div style={{ backgroundColor:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:"10px", padding:"24px" }}>
            <p style={{ fontSize:"12px", color:"#64748b", lineHeight:"2.0", margin:0 }}>
              本平台提供之資料、分析結果、篩選結果與研究工具，僅供資訊參考與研究用途，不構成任何投資建議、招攬、推介或保證獲利。投資人應自行判斷並承擔投資風險，並詳閱各商品公開說明書後謹慎決策。過去績效不代表未來表現。本平台不對任何投資損益負責。
            </p>
          </div>
          <div style={{ marginTop:"32px", textAlign:"center", fontSize:"11px", color:"#334155" }}>SmartMatch｜瑞宇智庫｜© {new Date().getFullYear()}</div>
        </div>
      </div>

      {/* ── 螢幕顯示版 ───────────────────────────────────────────── */}
      <div className="max-w-[860px] mx-auto">

        {/* 報告標頭 */}
        <div className="text-center mb-12">
          <div className="tracking-[10px] text-[#F5B700] text-[13px] font-semibold mb-5">SMARTMATCH 分析報告</div>
          {clientName && <div className="text-[14px] text-slate-400 mb-2">客戶：{clientName}</div>}
          {scoreParam  && <div className="text-[13px] text-slate-500 mb-1">總分 {scoreParam} 分</div>}
          <div className="text-[15px] text-slate-400 mb-3">投資人格分析結果</div>
          <h1 className="text-[60px] font-black text-white leading-tight">{rule.title}</h1>
          <div className="text-[14px] text-slate-500 mt-2">{rule.riskLabel}</div>
        </div>

        <p className="text-[17px] leading-[1.9] text-slate-400 text-center mb-12">{rule.summary}</p>

        {/* Section 1 badge */}
        <div className="text-[11px] tracking-[6px] text-[#F5B700] font-semibold mb-3">SECTION 1 · 投資人格分析</div>
        <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-6 mb-10">
          <div className="grid grid-cols-4 gap-4">
            {(["conservative","balanced","growth","aggressive"] as PersonalityKey[]).map(k => (
              <div key={k} className={`rounded-xl p-4 border transition-all ${type===k ? "border-[#F5B700] bg-[#F5B700]/10" : "border-white/[0.06] bg-white/[0.02]"}`}>
                <div className={`text-[15px] font-bold mb-1 ${type===k ? "text-[#F5B700]" : "text-slate-500"}`}>{RULES[k].title}</div>
                <div className={`text-[12px] ${type===k ? "text-white" : "text-slate-600"}`}>{RULES[k].riskLabel}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Section 2：配置分析 */}
        <div className="text-[11px] tracking-[6px] text-[#F5B700] font-semibold mb-3">SECTION 2 · 配置分析</div>
        <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-8 mb-10">
          <h2 className="text-[22px] font-bold text-white mb-6">資產配置分析</h2>
          <div className="flex h-5 rounded-full overflow-hidden mb-6">
            {alloc.map(a => <div key={a.label} style={{ width:`${a.value}%`, backgroundColor:a.color }} />)}
          </div>
          <div className="grid grid-cols-3 gap-5">
            {alloc.map(a => (
              <div key={a.label} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor:a.color }} />
                  <span className="text-[13px] text-slate-400">{a.label}</span>
                </div>
                <div className="text-[36px] font-black text-white">{a.value}%</div>
              </div>
            ))}
          </div>
        </div>

        {/* Section 3：ETF 篩選結果 */}
        <div className="text-[11px] tracking-[6px] text-[#F5B700] font-semibold mb-3">SECTION 3 · ETF 篩選結果</div>
        <h2 className="text-[22px] font-bold text-white mb-2">ETF 篩選結果</h2>
        <p className="text-[13px] text-slate-500 mb-6">依據本次配置分析條件，從 ETF 資料庫篩選出的商品，依近一年績效排序。</p>
        {etfGroups.map(g => (
          <div key={g.label} className="mb-6">
            <div className="text-[13px] font-semibold text-slate-300 mb-3 flex items-center gap-2">
              <span className="w-1 h-4 bg-[#F5B700] rounded-full" />{g.label}
            </div>
            <div className="border border-white/[0.08] rounded-xl overflow-hidden">
              <table className="w-full text-left">
                <thead><tr className="bg-white/[0.04] text-slate-500 text-[11px]">
                  <th className="px-4 py-2.5 font-semibold w-[80px]">代碼</th>
                  <th className="px-4 py-2.5 font-semibold">商品名稱</th>
                  <th className="px-4 py-2.5 font-semibold text-right">殖利率</th>
                  <th className="px-4 py-2.5 font-semibold text-right">近1年</th>
                  <th className="px-4 py-2.5 font-semibold text-right">波動度</th>
                </tr></thead>
                <tbody>
                  {g.items.map((e, i) => (
                    <tr key={e.code} className={`text-[13px] border-t border-white/[0.05] ${i%2===1?"bg-white/[0.02]":""}`}>
                      <td className="px-4 py-2.5 font-bold text-[#F5B700]">{e.code}</td>
                      <td className="px-4 py-2.5 text-slate-300 max-w-[220px] truncate">{e.name}</td>
                      <td className="px-4 py-2.5 text-right text-slate-400">{e.dividendYield>0?`${e.dividendYield.toFixed(1)}%`:"—"}</td>
                      <td className="px-4 py-2.5 text-right"><Pct v={e.return1y} /></td>
                      <td className="px-4 py-2.5 text-right text-slate-400">{e.volatility.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {/* Section 4：基金篩選結果 */}
        <div className="text-[11px] tracking-[6px] text-[#F5B700] font-semibold mb-3 mt-8">SECTION 4 · 基金篩選結果</div>
        <h2 className="text-[22px] font-bold text-white mb-2">基金篩選結果</h2>
        <p className="text-[13px] text-slate-500 mb-6">依據本次配置分析條件，從基金資料庫篩選出的商品，依近一年績效排序。</p>
        {fundGroups.map(g => (
          <div key={g.label} className="mb-6">
            <div className="text-[13px] font-semibold text-slate-300 mb-3 flex items-center gap-2">
              <span className="w-1 h-4 bg-[#F5B700] rounded-full" />{g.label}
            </div>
            <div className="border border-white/[0.08] rounded-xl overflow-hidden">
              <table className="w-full text-left">
                <thead><tr className="bg-white/[0.04] text-slate-500 text-[11px]">
                  <th className="px-4 py-2.5 font-semibold w-[64px]">公司</th>
                  <th className="px-4 py-2.5 font-semibold">基金名稱</th>
                  <th className="px-4 py-2.5 font-semibold text-center">晨星</th>
                  <th className="px-4 py-2.5 font-semibold text-right">年化配息</th>
                  <th className="px-4 py-2.5 font-semibold text-right">近1年</th>
                </tr></thead>
                <tbody>
                  {g.items.map((f, i) => (
                    <tr key={f.id} className={`text-[13px] border-t border-white/[0.05] ${i%2===1?"bg-white/[0.02]":""}`}>
                      <td className="px-4 py-2.5 font-bold text-white text-[12px]">{f.company}</td>
                      <td className="px-4 py-2.5 text-slate-300 max-w-[220px] truncate">{f.name}</td>
                      <td className="px-4 py-2.5 text-center"><Stars n={f.morningstar} /></td>
                      <td className="px-4 py-2.5 text-right text-[#F5B700] font-semibold">{f.dividendYieldA>0?`${f.dividendYieldA.toFixed(1)}%`:"—"}</td>
                      <td className="px-4 py-2.5 text-right"><Pct v={f.return1y} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {/* ── Section 5：快速操作 ──────────────────────────────────── */}
        <div className="text-[11px] tracking-[6px] text-[#F5B700] font-semibold mb-3 mt-10">SECTION 5 · 快速操作</div>
        <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-6 mb-10">
          <h2 className="text-[20px] font-bold text-white mb-6">快速操作</h2>
          <div className="grid grid-cols-3 gap-4">

            {/* ⭐ 收藏全部 */}
            <button onClick={handleFavAll}
              className="flex flex-col items-center gap-3 bg-[#F5B700]/10 border border-[#F5B700]/30 rounded-xl p-6 hover:bg-[#F5B700]/20 transition-all group">
              <span className="text-[28px]">⭐</span>
              <div className="text-[15px] font-bold text-[#F5B700]">收藏全部商品</div>
              <div className="text-[12px] text-slate-500">
                {allEtfs.length + allFunds.length} 檔商品加入收藏
              </div>
              <div className="text-[11px] text-slate-600">目前收藏：{favCount} 檔</div>
            </button>

            {/* 📊 加入比較 */}
            <button onClick={handleCmpAll}
              className="flex flex-col items-center gap-3 bg-emerald-900/20 border border-emerald-500/30 rounded-xl p-6 hover:bg-emerald-900/30 transition-all group">
              <span className="text-[28px]">📊</span>
              <div className="text-[15px] font-bold text-emerald-400">加入比較清單</div>
              <div className="text-[12px] text-slate-500">
                前往比較中心對比分析
              </div>
              <div className="text-[11px] text-slate-600">目前比較：{cmpCount} 檔</div>
            </button>

            {/* 👤 儲存客戶 */}
            <div className="flex flex-col items-center gap-3 bg-blue-900/20 border border-blue-500/30 rounded-xl p-6">
              <span className="text-[28px]">👤</span>
              <div className="text-[15px] font-bold text-blue-400">儲存至客戶管理</div>
              {savedClient ? (
                <div className="text-[12px] text-emerald-400 font-semibold">✓ 已儲存</div>
              ) : !showSaveForm ? (
                <button onClick={() => setShowSaveForm(true)}
                  className="bg-blue-600 hover:bg-blue-500 text-white text-[13px] font-bold px-5 py-2 rounded-lg transition-colors">
                  儲存客戶
                </button>
              ) : (
                <div className="w-full flex flex-col gap-2">
                  <input type="text" value={saveName} onChange={e => setSaveName(e.target.value)}
                    placeholder="客戶姓名"
                    className="bg-transparent border border-white/20 rounded-lg px-3 py-2 text-[13px] text-white focus:outline-none focus:border-blue-400 placeholder:text-slate-600" />
                  <div className="flex gap-2">
                    <button onClick={handleSaveClient}
                      className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-[12px] font-bold py-2 rounded-lg transition-colors">確認</button>
                    <button onClick={() => setShowSaveForm(false)}
                      className="border border-white/20 text-slate-400 text-[12px] px-3 py-2 rounded-lg">取消</button>
                  </div>
                </div>
              )}
            </div>

          </div>

          {/* 比較中心連結 */}
          {cmpCount > 0 && (
            <div className="mt-4 text-center">
              <Link href="/compare"
                className="text-[13px] text-emerald-400 hover:underline">
                前往比較中心查看 {cmpCount} 檔商品 →
              </Link>
            </div>
          )}
        </div>

        {/* 免責聲明 */}
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-6 mb-10">
          <div className="text-[12px] font-bold text-slate-400 mb-2">免責聲明</div>
          <p className="text-[12px] text-slate-600 leading-[1.9]">
            本平台提供之資料、分析結果、篩選結果與研究工具，僅供資訊參考與研究用途，不構成任何投資建議、招攬、推介或保證獲利。投資人應自行判斷並承擔投資風險，並詳閱各商品公開說明書後謹慎決策。過去績效不代表未來表現。
          </p>
        </div>

        {/* 底部按鈕 */}
        <div className="flex gap-4 justify-center flex-wrap">
          <button onClick={handleExportPdf}
            className="flex items-center gap-2 bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-8 py-3.5 rounded-lg font-bold text-[15px] transition-colors">
            ⬇ 匯出 PDF
          </button>
          <Link href="/quiz"
            className="border border-white/20 text-white px-8 py-3.5 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[15px]">
            重新分析
          </Link>
          <Link href="/clients"
            className="border border-white/20 text-white px-8 py-3.5 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[15px]">
            客戶管理
          </Link>
          <Link href="/"
            className="border border-white/20 text-white px-8 py-3.5 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[15px]">
            回到首頁
          </Link>
        </div>

      </div>

      {toast && <Toast msg={toast} onClose={() => setToast(null)} />}
    </main>
  );
}

export default function ReportPage() {
  return <Suspense fallback={null}><ReportContent /></Suspense>;
}