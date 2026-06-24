"use client";

import Link from "next/link";
import { useState } from "react";

// ── 全球市場資料 ──────────────────────────────────────────────────────
type MktItem  = { name: string; value: string; pts: string; pct: string; up: boolean };
type MktGroup = { id: string; label: string; sublabel: string; emoji: string; main: MktItem[]; more: MktItem[] };

const MARKET_GROUPS: MktGroup[] = [
  { id:"tw", label:"台灣市場", sublabel:"TAIWAN", emoji:"🇹🇼",
    main:[
      { name:"加權指數",   value:"22,184", pts:"+184.32", pct:"+0.84%", up:true  },
      { name:"台指期近月", value:"22,210", pts:"+128.00", pct:"+0.58%", up:true  },
      { name:"元大台灣50", value:"198.45", pts:"+1.42",   pct:"+0.72%", up:true  },
    ],
    more:[
      { name:"櫃買指數", value:"248.32", pts:"+1.85",  pct:"+0.75%", up:true },
      { name:"金融指數", value:"2,184",  pts:"+12.40", pct:"+0.57%", up:true },
      { name:"電子指數", value:"1,092",  pts:"+9.84",  pct:"+0.91%", up:true },
    ],
  },
  { id:"us", label:"美國市場", sublabel:"UNITED STATES", emoji:"🇺🇸",
    main:[
      { name:"道瓊工業", value:"43,408", pts:"+228.41", pct:"+0.53%", up:true },
      { name:"NASDAQ",  value:"19,271", pts:"+162.25", pct:"+0.85%", up:true },
      { name:"S&P 500", value:"5,842",  pts:"+39.52",  pct:"+0.68%", up:true },
    ],
    more:[
      { name:"費城半導體",    value:"5,124", pts:"+62.10", pct:"+1.23%", up:true  },
      { name:"Russell 2000", value:"2,218", pts:"-6.89",  pct:"-0.31%", up:false },
      { name:"VIX",          value:"13.42", pts:"-0.16",  pct:"-1.19%", up:false },
    ],
  },
  { id:"asia", label:"亞洲市場", sublabel:"ASIA", emoji:"🌏",
    main:[
      { name:"日經 225",   value:"39,842", pts:"+411.24", pct:"+1.04%", up:true  },
      { name:"韓國 KOSPI", value:"2,621",  pts:"+15.92",  pct:"+0.61%", up:true  },
      { name:"恒生指數",   value:"23,184", pts:"-109.60", pct:"-0.47%", up:false },
    ],
    more:[
      { name:"上證指數", value:"3,412",  pts:"+7.48",  pct:"+0.22%", up:true },
      { name:"深圳成指", value:"10,824", pts:"+98.42", pct:"+0.92%", up:true },
      { name:"新加坡",   value:"3,822",  pts:"+18.40", pct:"+0.48%", up:true },
    ],
  },
  { id:"eu", label:"歐洲市場", sublabel:"EUROPE", emoji:"🇪🇺",
    main:[
      { name:"德國 DAX",      value:"22,854", pts:"+100.56", pct:"+0.44%", up:true },
      { name:"英國 FTSE 100", value:"8,732",  pts:"+24.44",  pct:"+0.28%", up:true },
      { name:"法國 CAC 40",   value:"7,981",  pts:"+15.16",  pct:"+0.19%", up:true },
    ],
    more:[
      { name:"Euro STOXX 50", value:"5,312",  pts:"+18.60", pct:"+0.35%", up:true },
      { name:"瑞士 SMI",      value:"12,184", pts:"+48.24", pct:"+0.40%", up:true },
      { name:"義大利 MIB",    value:"38,420", pts:"+84.12", pct:"+0.22%", up:true },
    ],
  },
  { id:"cmd", label:"商品市場", sublabel:"COMMODITIES", emoji:"🥇",
    main:[
      { name:"黃金 XAU", value:"3,342", pts:"+30.18", pct:"+0.91%", up:true  },
      { name:"WTI 原油",  value:"71.28", pts:"-0.60",  pct:"-0.83%", up:false },
      { name:"布蘭特",   value:"74.52", pts:"-0.53",  pct:"-0.71%", up:false },
    ],
    more:[
      { name:"白銀",  value:"32.84", pts:"+0.37", pct:"+1.14%", up:true  },
      { name:"銅",    value:"4.52",  pts:"+0.02", pct:"+0.44%", up:true  },
      { name:"天然氣", value:"2.18", pts:"-0.04", pct:"-1.80%", up:false },
    ],
  },
];

// ── 熱門排行 ──────────────────────────────────────────────────────────
const ETF_HOT = [
  { rank:1,  code:"0050",    name:"元大台灣50",           flow:"+125.3億", change:"+0.72%", up:true  },
  { rank:2,  code:"00878",   name:"國泰永續高股息",         flow:"+98.7億",  change:"+0.45%", up:true  },
  { rank:3,  code:"00919",   name:"群益台灣精選高息",       flow:"+76.2億",  change:"+0.38%", up:true  },
  { rank:4,  code:"00940",   name:"元大台灣價值高息",       flow:"+54.8億",  change:"+1.24%", up:true  },
  { rank:5,  code:"VOO",     name:"Vanguard S&P 500",     flow:"+48.3億",  change:"+0.68%", up:true  },
  { rank:6,  code:"QQQ",     name:"Invesco NASDAQ 100",   flow:"+38.1億",  change:"+0.85%", up:true  },
  { rank:7,  code:"00713",   name:"元大台灣高息低波",       flow:"+29.4億",  change:"+0.43%", up:true  },
  { rank:8,  code:"VTI",     name:"Vanguard Total Mkt",   flow:"+22.2億",  change:"+0.59%", up:true  },
  { rank:9,  code:"SOXX",    name:"iShares 半導體",        flow:"+18.9億",  change:"+1.23%", up:true  },
  { rank:10, code:"00679B",  name:"元大美債20年",           flow:"+14.8億",  change:"-0.32%", up:false },
];

const FUND_HOT = [
  { rank:1,  name:"安聯台灣科技基金",   company:"安聯",  flow:"+45.7億", change:"+1.25%", up:true },
  { rank:2,  name:"復華全球物聯網基金", company:"復華",  flow:"+32.2億", change:"+0.98%", up:true },
  { rank:3,  name:"國泰台灣5G+基金",    company:"國泰",  flow:"+28.9億", change:"+1.12%", up:true },
  { rank:4,  name:"聯博全球高收益債券", company:"聯博",  flow:"+24.3億", change:"+0.42%", up:true },
  { rank:5,  name:"富達基金－美國基金", company:"富達",  flow:"+21.9億", change:"+0.81%", up:true },
  { rank:6,  name:"摩根美國科技基金",   company:"摩根",  flow:"+19.2億", change:"+1.14%", up:true },
  { rank:7,  name:"安聯收益成長基金",   company:"安聯",  flow:"+16.4億", change:"+0.38%", up:true },
  { rank:8,  name:"貝萊德世界科技基金", company:"貝萊德",flow:"+13.9億", change:"+0.92%", up:true },
  { rank:9,  name:"野村亞太高股息基金", company:"野村",  flow:"+11.2億", change:"+0.44%", up:true },
  { rank:10, name:"施羅德環球股息收益", company:"施羅德",flow:"+9.2億",  change:"+0.55%", up:true },
];

// ── Sparkline ─────────────────────────────────────────────────────────
function Sparkline({ up }: { up: boolean }) {
  const pts = up
    ? [38,35,37,32,29,33,27,23,19,16,13,10]
    : [10,14,12,18,15,20,24,19,27,25,31,36];
  const minV = Math.min(...pts), maxV = Math.max(...pts), range = maxV - minV || 1;
  const W = 100, H = 36;
  const coords = pts.map((v,i) => {
    const x = (i/(pts.length-1))*W;
    const y = H - ((v-minV)/range)*(H-6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const color = up ? "#22C55E" : "#EF4444";
  const gid = `sp${up?"u":"d"}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="shrink-0">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${coords} ${W},${H}`} fill={`url(#${gid})`} />
      <polyline points={coords} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Market Row ────────────────────────────────────────────────────────
function MktRow({ group }: { group: MktGroup }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-white/[0.08] rounded-2xl overflow-hidden mb-4"
      style={{ background:"rgba(15,22,42,0.85)", backdropFilter:"blur(20px)" }}>
      <div className="px-7 py-5">
        <div className="flex items-center gap-6">
          {/* 區域標籤 */}
          <div className="w-[148px] shrink-0 flex items-center gap-3">
            <span className="text-[28px]">{group.emoji}</span>
            <div>
              <div className="text-[18px] font-bold text-white leading-tight">{group.label}</div>
              <div className="text-[10px] tracking-[3px] text-white/35 mt-0.5">{group.sublabel}</div>
            </div>
          </div>
          <div className="w-px h-12 bg-white/[0.08] shrink-0" />
          {/* 三個主要指標 */}
          <div className="flex flex-1 gap-0 min-w-0">
            {group.main.map((item, i) => (
              <div key={item.name} className="flex items-center gap-5 flex-1 min-w-0 px-5">
                {i > 0 && <div className="w-px h-10 bg-white/[0.06] shrink-0 -ml-5" />}
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] text-white/50 mb-1 truncate">{item.name}</div>
                  <div className="text-[28px] font-bold text-white leading-none mb-1">{item.value}</div>
                  <div className={`text-[16px] font-semibold ${item.up?"text-[#22C55E]":"text-[#EF4444]"}`}>
                    {item.up?"▲":"▼"} {item.pts} <span className="text-[14px]">{item.pct}</span>
                  </div>
                </div>
                <Sparkline up={item.up} />
              </div>
            ))}
          </div>
          {/* 展開按鈕 */}
          <button onClick={() => setOpen(!open)}
            className="shrink-0 text-[14px] font-semibold text-[#F5B700] hover:text-[#e0a800] transition-colors whitespace-nowrap ml-4">
            {open ? "收起 ▲" : "更多 ▼"}
          </button>
        </div>
      </div>
      {open && (
        <div className="px-7 pb-5 border-t border-white/[0.06]">
          <div className="flex gap-0 pt-4">
            <div className="w-[148px] shrink-0" />
            <div className="w-px bg-white/[0.06] shrink-0 mx-6" />
            <div className="flex flex-1 gap-0 min-w-0">
              {group.more.map((item, i) => (
                <div key={item.name} className="flex items-center gap-4 flex-1 min-w-0 px-5">
                  {i > 0 && <div className="w-px h-10 bg-white/[0.06] shrink-0 -ml-5" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-white/40 mb-1 truncate">{item.name}</div>
                    <div className="text-[22px] font-bold text-white leading-none mb-1">{item.value}</div>
                    <div className={`text-[14px] font-semibold ${item.up?"text-[#22C55E]":"text-[#EF4444]"}`}>
                      {item.up?"▲":"▼"} {item.pts} <span className="text-[13px]">{item.pct}</span>
                    </div>
                  </div>
                  <Sparkline up={item.up} />
                </div>
              ))}
            </div>
            <div className="w-[80px] shrink-0" />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pricing helpers ───────────────────────────────────────────────────
function PF({ text }: { text: string }) {
  return <div className="flex items-start gap-2 text-[15px] text-slate-300"><span className="text-emerald-400 mt-0.5 shrink-0">✓</span>{text}</div>;
}
function PFN({ text }: { text: string }) {
  return <div className="flex items-start gap-2 text-[15px] text-slate-600"><span className="mt-0.5 shrink-0">✗</span>{text}</div>;
}

// ── Main ──────────────────────────────────────────────────────────────
export default function Home() {
  return (
    <main className="min-h-screen">

      {/* ══ NAVBAR ══════════════════════════════════════════════════ */}
      <header className="fixed top-0 left-0 w-full z-50 bg-[#040a18]/90 backdrop-blur-xl border-b border-white/[0.08]">
        <div className="max-w-[1600px] mx-auto h-20 px-10 flex items-center justify-between">
          <div>
            <div className="text-[32px] font-black text-white leading-none">Smart<span className="text-[#F5B700]">Match</span></div>
            <div className="text-[12px] text-slate-400 mt-0.5">Investment Intelligence Platform</div>
          </div>
          <nav className="hidden lg:flex gap-8 text-[18px] font-semibold text-slate-300">
            <Link href="/quiz"    className="hover:text-white transition-colors">投資人格分析</Link>
            <Link href="/etf"     className="hover:text-white transition-colors">ETF篩選器</Link>
            <Link href="/funds"   className="hover:text-white transition-colors">基金篩選器</Link>
            <Link href="/markets" className="hover:text-white transition-colors">市場中心</Link>
            <Link href="/clients" className="hover:text-white transition-colors">客戶管理</Link>
            <Link href="/pricing" className="hover:text-[#F5B700] transition-colors">方案</Link>
          </nav>
          <div className="flex items-center gap-4">
            <a href="#" className="text-[16px] font-semibold text-slate-300 border border-white/30 px-5 py-2.5 rounded-lg hover:bg-white/10 transition-colors">登入</a>
            <Link href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-6 py-2.5 rounded-lg font-bold text-[16px] transition-colors">免費開始</Link>
          </div>
        </div>
      </header>

      {/* ══ ZONE 1：HERO（深藍 + 金融大樓）══════════════════════════ */}
      <section className="relative z-10 min-h-screen">
        {/* 問題三修正：Overlay 降至 35~40% */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#020817]/75 via-[#020817]/40 to-transparent z-[1]" />
        <div className="relative z-10 max-w-[1600px] mx-auto px-10 flex items-center min-h-screen pt-20">
          <div className="grid lg:grid-cols-[50%_50%] w-full items-center gap-12 py-20">

            {/* LEFT */}
            <div className="space-y-7">
              <div className="text-[15px] tracking-[10px] text-[#F5B700] font-semibold">SMARTMATCH</div>

              {/* 問題一：主標題縮小至 52~56px */}
              <div>
                <h1 className="text-[54px] font-black leading-[1.15] text-white mb-4">
                  3分鐘完成投資分析<br />
                  <span className="text-[#F5B700]">建立更有系統的</span><br />
                  資產配置
                </h1>
                <p className="text-[20px] text-white/70 leading-[1.8] max-w-[500px]">
                  透過投資人格分析、ETF 與基金資料庫，以及全球市場資訊，快速建立投資決策流程。
                </p>
              </div>

              {/* 問題五：CTA 改為具體 */}
              <div className="flex gap-4 flex-wrap">
                <Link href="/quiz"
                  className="bg-[#F5B700] hover:bg-[#e0a800] text-[#020817] px-9 py-4 rounded-xl font-black text-[19px] transition-colors shadow-[0_0_40px_rgba(245,183,0,0.25)]">
                  3分鐘取得分析結果 →
                </Link>
                <Link href="/etf"
                  className="bg-white/[0.08] backdrop-blur-md border border-white/[0.15] text-white px-7 py-4 rounded-xl font-semibold text-[17px] hover:bg-white/[0.15] transition-colors">
                  瀏覽 ETF 與基金資料庫
                </Link>
              </div>

              {/* 四統計卡 */}
              <div className="grid grid-cols-4 gap-3 pt-1">
                {[
                  { num:"95+",  label:"ETF 資料" },
                  { num:"269+", label:"基金資料" },
                  { num:"34+",  label:"全球市場指標" },
                  { num:"20題", label:"投資人格分析" },
                ].map(s => (
                  <div key={s.label} className="bg-white/[0.07] backdrop-blur-sm border border-white/[0.1] rounded-2xl p-4 text-center">
                    <div className="text-[44px] font-black text-[#F5B700] leading-none mb-1">{s.num}</div>
                    <div className="text-[15px] text-white/55 leading-tight">{s.label}</div>
                  </div>
                ))}
              </div>

              {/* 問題四：資料來源信任背書 */}
              <div className="pt-1">
                <div className="text-[13px] text-white/30 mb-2">資料來源參考</div>
                <div className="flex flex-wrap gap-3">
                  {["Morningstar","公開資訊觀測站","投信投顧公會","基金公司公開資料"].map(src => (
                    <span key={src} className="text-[13px] text-white/40 border border-white/[0.1] px-3 py-1 rounded-full">{src}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* RIGHT — 問題二：真實分析報告預覽 */}
            <div className="rounded-3xl border border-white/[0.12] overflow-hidden shadow-[0_40px_120px_rgba(0,0,0,0.5)]"
              style={{ background:"rgba(8,15,32,0.88)", backdropFilter:"blur(28px)", maxHeight:"580px", overflowY:"auto" }}>

              {/* 頂部標題列 */}
              <div className="flex items-center justify-between px-6 py-3.5 border-b border-white/[0.08] sticky top-0 z-10"
                style={{ background:"rgba(8,15,32,0.96)" }}>
                <div className="flex items-center gap-3">
                  <div className="flex gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500/50" />
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50" />
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500/50" />
                  </div>
                  <div className="text-[12px] font-bold text-white/50 tracking-[4px]">SMARTMATCH REPORT</div>
                </div>
                <div className="text-[12px] text-white/35">2026/06/24</div>
              </div>

              <div className="p-5 space-y-3">

                {/* 客戶資訊列 */}
                <div className="flex items-center justify-between px-4 py-3 bg-white/[0.03] border border-white/[0.05] rounded-xl">
                  <div className="flex items-center gap-4">
                    <div className="w-9 h-9 rounded-full bg-[#F5B700]/20 flex items-center justify-center text-[16px] font-black text-[#F5B700]">王</div>
                    <div>
                      <div className="text-[16px] font-bold text-white">王小明</div>
                      <div className="text-[12px] text-white/40">客戶編號 #2024-0042</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[13px] text-[#F5B700] font-semibold">穩健型投資人</div>
                    <div className="text-[12px] text-white/35">風險承受度：中等</div>
                  </div>
                </div>

                {/* 配置分析 */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-[13px] font-semibold text-white/70">配置分析</div>
                    <div className="text-[12px] text-white/35">總分 58 分</div>
                  </div>
                  <div className="flex h-2.5 rounded-full overflow-hidden mb-3">
                    <div style={{ width:"50%", backgroundColor:"#F5B700" }} />
                    <div style={{ width:"30%", backgroundColor:"#64748b" }} />
                    <div style={{ width:"20%", backgroundColor:"#334155" }} />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[["股票","50%","#F5B700"],["債券","30%","#64748b"],["現金","20%","#475569"]].map(([l,v,c])=>(
                      <div key={l} className="text-center bg-white/[0.03] rounded-lg py-2">
                        <div className="text-[20px] font-black text-white">{v}</div>
                        <div className="text-[11px] mt-0.5" style={{ color:c as string }}>{l}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ETF 篩選結果 */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="text-[13px] font-semibold text-white/70 mb-3">ETF 篩選結果</div>
                  <div className="space-y-2">
                    {[
                      ["0050",  "元大台灣50",     "市值型", "+21.6%", true ],
                      ["006208","富邦台灣50",     "市值型", "+20.8%", true ],
                      ["00919", "群益台灣精選高息","收益型", "+14.2%", true ],
                    ].map(([code,name,type,ret,up])=>(
                      <div key={code as string} className="flex items-center justify-between py-1.5 border-b border-white/[0.04] last:border-0">
                        <div className="flex items-center gap-2.5">
                          <span className="text-[13px] font-bold text-[#F5B700] w-14">{code}</span>
                          <span className="text-[12px] text-white/55 truncate max-w-[90px]">{name}</span>
                          <span className="text-[10px] text-white/25 hidden xl:block">{type}</span>
                        </div>
                        <span className={`text-[13px] font-semibold ${up ? "text-emerald-400" : "text-red-400"}`}>{ret}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 基金篩選結果 */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="text-[13px] font-semibold text-white/70 mb-3">基金篩選結果</div>
                  <div className="space-y-2">
                    {[
                      ["霸菱","霸菱優先順位資產基金","★★★★","6.2%"],
                      ["聯博","聯博美國收益基金",    "★★★★","6.1%"],
                      ["貝萊德","貝萊德全球多元收益","★★★★","5.8%"],
                    ].map(([co,name,stars,div])=>(
                      <div key={name as string} className="flex items-center justify-between py-1.5 border-b border-white/[0.04] last:border-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-bold text-white/50 w-10 shrink-0">{co}</span>
                          <span className="text-[12px] text-white/55 truncate max-w-[100px]">{name}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[11px] text-[#F5B700]">{stars}</span>
                          <span className="text-[13px] font-semibold text-[#F5B700]">{div}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 市場概況 */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="text-[13px] font-semibold text-white/70 mb-3">今日市場概況</div>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      ["台股加權","22,184","▲ +0.84%",true],
                      ["NASDAQ","19,271","▲ +1.24%",true],
                      ["黃金 XAU","3,342","▲ +0.91%",true],
                      ["WTI 原油","71.28","▼ -0.83%",false],
                    ].map(([name,val,chg,up])=>(
                      <div key={name as string} className="flex items-center justify-between bg-white/[0.03] rounded-lg px-3 py-2">
                        <div>
                          <div className="text-[11px] text-white/40">{name}</div>
                          <div className="text-[15px] font-bold text-white">{val}</div>
                        </div>
                        <div className={`text-[12px] font-semibold ${up ? "text-emerald-400" : "text-red-400"}`}>{chg}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 快速操作 */}
                <div className="grid grid-cols-3 gap-2 pt-1">
                  {[["⭐","收藏商品"],["📊","加入比較"],["⬇","匯出 PDF"]].map(([icon,label])=>(
                    <div key={label as string} className="bg-[#F5B700]/[0.07] border border-[#F5B700]/20 rounded-xl py-2.5 text-center">
                      <div className="text-[15px] mb-0.5">{icon}</div>
                      <div className="text-[12px] font-semibold text-[#F5B700]/70">{label}</div>
                    </div>
                  ))}
                </div>

              </div>
            </div>

          </div>
        </div>
      </section>

      {/* ══ 問題六：理專痛點 → SmartMatch 解決方案（窄區塊）══════ */}
      <section className="relative z-10 py-16" style={{ backgroundColor:"rgba(2,8,23,0.92)" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            {/* 左：痛點 */}
            <div>
              <div className="text-[14px] tracking-[8px] text-[#F5B700] font-semibold mb-5">PAIN POINTS</div>
              <h3 className="text-[28px] font-black text-white mb-6">理專常見痛點</h3>
              <div className="space-y-4">
                {[
                  "客戶不知道自己適合什麼商品",
                  "ETF 與基金選擇過多，難以聚焦",
                  "不知道如何建立有系統的資產配置",
                  "缺乏一致的分析流程與報告工具",
                ].map((pain, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <span className="text-red-400 text-[18px] shrink-0 mt-0.5">✗</span>
                    <span className="text-[18px] text-white/70">{pain}</span>
                  </div>
                ))}
              </div>
            </div>
            {/* 右：解決方案 */}
            <div>
              <div className="text-[14px] tracking-[8px] text-[#F5B700] font-semibold mb-5">SOLUTION</div>
              <h3 className="text-[28px] font-black text-white mb-6">SmartMatch 如何解決</h3>
              <div className="space-y-4">
                {[
                  ["投資人格分析",   "20題問卷，精準評估風險屬性與投資目標"],
                  ["配置分析",       "自動產生股票、債券、現金配置比例"],
                  ["商品篩選",       "從 ETF 與基金資料庫篩選符合條件商品"],
                  ["報告輸出",       "一鍵匯出 PDF，儲存客戶分析結果"],
                ].map(([title, desc]) => (
                  <div key={title} className="flex items-start gap-3">
                    <span className="text-emerald-400 text-[18px] shrink-0 mt-0.5">✓</span>
                    <div>
                      <span className="text-[18px] font-bold text-white">{title}</span>
                      <span className="text-[16px] text-white/50 ml-2">{desc}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══ ZONE 2：為什麼使用 SmartMatch（白底）══════════════════ */}
      <section className="relative z-10 py-24" style={{ backgroundColor:"#ffffff" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-14">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-4">FEATURES</div>
            <h2 className="text-[40px] font-black text-[#0a1628]">為什麼使用 SmartMatch</h2>
            <p className="text-[18px] text-slate-500 mt-3 max-w-[580px] mx-auto">
              整合投資人格分析、商品資料庫與市場資訊，一站完成投資分析流程。
            </p>
          </div>
          <div className="grid grid-cols-4 gap-6">
            {[
              { icon:"🧠", title:"投資人格分析", desc:"20題問卷評估風險屬性，產生配置分析與商品篩選結果", href:"/quiz" },
              { icon:"📊", title:"ETF 資料庫",   desc:"95 檔 ETF，完整配息、績效、波動度數據，支援篩選排序", href:"/etf" },
              { icon:"🏦", title:"基金資料庫",   desc:"269 檔基金，前20大基金公司，晨星評等與配息資料", href:"/funds" },
              { icon:"🌐", title:"全球市場中心", desc:"34 個市場指標，台灣、美國、亞洲、歐洲、商品即時概況", href:"/markets" },
            ].map(f => (
              <Link key={f.title} href={f.href}
                className="bg-white border border-slate-100 rounded-2xl p-8 hover:shadow-lg hover:border-[#F5B700]/40 transition-all group">
                <div className="text-[40px] mb-5">{f.icon}</div>
                <div className="text-[20px] font-bold text-[#0a1628] mb-3 group-hover:text-[#b38600] transition-colors">{f.title}</div>
                <div className="text-[16px] text-slate-500 leading-relaxed">{f.desc}</div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ══ ZONE 3：分析流程（#F5F7FA）══════════════════════════════ */}
      <section className="relative z-10 py-24" style={{ backgroundColor:"#F5F7FA" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-14">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-4">HOW IT WORKS</div>
            <h2 className="text-[40px] font-black text-[#0a1628]">投資分析流程</h2>
          </div>
          <div className="grid grid-cols-5 gap-4 relative">
            {[
              { step:"STEP 1", icon:"📝", title:"完成問卷",    desc:"回答 20 題投資情境問題" },
              { step:"STEP 2", icon:"🧠", title:"人格分析",    desc:"系統評估風險承受度與投資屬性" },
              { step:"STEP 3", icon:"📈", title:"配置分析",    desc:"產生股票、債券、現金配置比例" },
              { step:"STEP 4", icon:"🔍", title:"ETF與基金篩選",desc:"從資料庫篩選符合條件商品" },
              { step:"STEP 5", icon:"📄", title:"建立報告",    desc:"匯出 PDF，儲存至客戶管理" },
            ].map((s,i) => (
              <div key={s.step} className="relative">
                {i < 4 && (
                  <div className="absolute top-[52px] left-[calc(100%-8px)] w-[calc(100%-16px)] h-0.5 z-10 hidden lg:block"
                    style={{ background:"linear-gradient(90deg,#F5B700,rgba(245,183,0,0.2))" }} />
                )}
                <div className="bg-white border border-slate-100 rounded-2xl p-6 text-center hover:shadow-md transition-shadow relative z-20">
                  <div className="text-[11px] tracking-[4px] text-[#F5B700] font-semibold mb-3">{s.step}</div>
                  <div className="text-[36px] mb-3">{s.icon}</div>
                  <div className="text-[18px] font-bold text-[#0a1628] mb-2">{s.title}</div>
                  <div className="text-[16px] text-slate-500 leading-relaxed">{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="text-center mt-10">
            <Link href="/quiz"
              className="inline-block bg-[#F5B700] hover:bg-[#e0a800] text-[#020817] px-12 py-4 rounded-xl font-black text-[20px] transition-colors">
              立即開始分析 →
            </Link>
          </div>
        </div>
      </section>

      {/* ══ ZONE 4：分析結果範例（白底）═════════════════════════════ */}
      <section className="relative z-10 py-24" style={{ backgroundColor:"#ffffff" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-14">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-4">SAMPLE REPORT</div>
            <h2 className="text-[40px] font-black text-[#0a1628]">分析結果範例</h2>
            <p className="text-[18px] text-slate-500 mt-3">完成問卷後，你會看到以下分析結果</p>
          </div>
          <div className="grid lg:grid-cols-[360px_1fr] gap-8 items-start">
            {/* 左：保守型配置 */}
            <div className="bg-[#0a1628] rounded-2xl p-8 text-white">
              <div className="text-[13px] tracking-[5px] text-[#F5B700] font-semibold mb-5">保守型投資人</div>
              <div className="text-[16px] text-white/60 mb-4">資產配置分析</div>
              <div className="flex h-4 rounded-full overflow-hidden mb-6">
                <div style={{ width:"15%", backgroundColor:"#F5B700" }} />
                <div style={{ width:"60%", backgroundColor:"#64748b" }} />
                <div style={{ width:"25%", backgroundColor:"#334155" }} />
              </div>
              <div className="space-y-4">
                {[["股票資產","15%","#F5B700"],["債券資產","60%","#64748b"],["現金部位","25%","#475569"]].map(([l,v,c])=>(
                  <div key={l} className="flex items-center justify-between py-3 border-b border-white/[0.06]">
                    <div className="flex items-center gap-3">
                      <div className="w-3 h-3 rounded-sm" style={{ backgroundColor:c as string }} />
                      <span className="text-[17px] text-white/70">{l}</span>
                    </div>
                    <span className="text-[28px] font-black text-white">{v}</span>
                  </div>
                ))}
              </div>
              <div className="mt-6 pt-6 border-t border-white/[0.08]">
                <div className="text-[14px] text-white/40">風險承受度：中低</div>
                <div className="text-[14px] text-white/40 mt-1">總分：35 分</div>
              </div>
            </div>
            {/* 右：ETF + 基金結果 */}
            <div className="space-y-5">
              {/* ETF 表格 */}
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <div className="bg-slate-50 px-6 py-4 border-b border-slate-100">
                  <div className="text-[16px] font-bold text-[#0a1628]">ETF 篩選結果</div>
                  <div className="text-[14px] text-slate-400 mt-0.5">依配置條件從 ETF 資料庫篩選</div>
                </div>
                <table className="w-full">
                  <thead><tr className="text-[14px] text-slate-400 border-b border-slate-100">
                    <th className="px-6 py-3 text-left font-semibold">代碼</th>
                    <th className="px-6 py-3 text-left font-semibold">名稱</th>
                    <th className="px-6 py-3 text-left font-semibold">類型</th>
                    <th className="px-6 py-3 text-right font-semibold">殖利率</th>
                    <th className="px-6 py-3 text-right font-semibold">近1年</th>
                  </tr></thead>
                  <tbody>
                    {[
                      ["00679B","元大美債20年","債券","3.8%","-1.8%",false],
                      ["00720B","元大投資級公司債","債券","4.2%","+2.4%",true],
                      ["00919","群益台灣精選高息","收益型","8.4%","+14.2%",true],
                    ].map(([code,name,type,yld,ret,up],i)=>(
                      <tr key={code as string} className={`text-[15px] border-b border-slate-50 hover:bg-slate-50 transition-colors ${i%2===1?"bg-slate-50/50":""}`}>
                        <td className="px-6 py-3.5 font-bold text-[#b38600]">{code}</td>
                        <td className="px-6 py-3.5 text-slate-700">{name}</td>
                        <td className="px-6 py-3.5 text-slate-400">{type}</td>
                        <td className="px-6 py-3.5 text-right text-slate-600">{yld}</td>
                        <td className={`px-6 py-3.5 text-right font-semibold ${up?"text-emerald-600":"text-red-500"}`}>{ret}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* 基金表格 */}
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <div className="bg-slate-50 px-6 py-4 border-b border-slate-100">
                  <div className="text-[16px] font-bold text-[#0a1628]">基金篩選結果</div>
                  <div className="text-[14px] text-slate-400 mt-0.5">依配置條件從基金資料庫篩選</div>
                </div>
                <table className="w-full">
                  <thead><tr className="text-[14px] text-slate-400 border-b border-slate-100">
                    <th className="px-6 py-3 text-left font-semibold">公司</th>
                    <th className="px-6 py-3 text-left font-semibold">基金名稱</th>
                    <th className="px-6 py-3 text-center font-semibold">晨星</th>
                    <th className="px-6 py-3 text-right font-semibold">年化配息</th>
                    <th className="px-6 py-3 text-right font-semibold">近1年</th>
                  </tr></thead>
                  <tbody>
                    {[
                      ["霸菱","霸菱優先順位資產抵押債券基金","★★★★","5.8%","+6.2%"],
                      ["聯博","聯博收益債券基金","★★★★","6.1%","+7.1%"],
                      ["貝萊德","貝萊德全球政府債券基金","★★★","3.8%","+4.2%"],
                    ].map(([co,name,stars,div,ret],i)=>(
                      <tr key={name as string} className={`text-[15px] border-b border-slate-50 hover:bg-slate-50 transition-colors ${i%2===1?"bg-slate-50/50":""}`}>
                        <td className="px-6 py-3.5 font-bold text-[#0a1628]">{co}</td>
                        <td className="px-6 py-3.5 text-slate-700 max-w-[200px] truncate">{name}</td>
                        <td className="px-6 py-3.5 text-center text-[#b38600]">{stars}</td>
                        <td className="px-6 py-3.5 text-right font-semibold text-[#b38600]">{div}</td>
                        <td className="px-6 py-3.5 text-right font-semibold text-emerald-600">{ret}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="text-center pt-2">
                <Link href="/quiz"
                  className="inline-block bg-[#0a1628] hover:bg-[#0d1f3c] text-white px-10 py-3.5 rounded-xl font-bold text-[18px] transition-colors">
                  立即開始你的分析 →
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══ ZONE 5：全球市場概況（深藍）════════════════════════════ */}
      <section className="relative z-10 py-20" style={{ backgroundColor:"#0a1628" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="flex items-end justify-between mb-8">
            <div>
              <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-3">GLOBAL MARKETS</div>
              <h2 className="text-[40px] font-black text-white">全球市場概況</h2>
              <p className="text-[16px] text-white/40 mt-1">示意資料・非即時行情</p>
            </div>
            <Link href="/markets" className="text-[16px] font-semibold text-[#F5B700] border border-[#F5B700]/40 px-5 py-2.5 rounded-lg hover:bg-[#F5B700]/10 transition-colors">
              完整市場中心 →
            </Link>
          </div>
          {MARKET_GROUPS.map(g => <MktRow key={g.id} group={g} />)}
        </div>
      </section>

      {/* ══ ZONE 6：熱門申購排行（白底）════════════════════════════ */}
      <section className="relative z-10 py-24" style={{ backgroundColor:"#ffffff" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-12">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-3">HOT PICKS</div>
            <h2 className="text-[40px] font-black text-[#0a1628]">熱門申購排行榜</h2>
            <p className="text-[16px] text-slate-400 mt-2">近一週資金淨流入排行・示意資料</p>
          </div>
          <div className="grid grid-cols-2 gap-8">
            {/* ETF */}
            <div>
              <div className="flex items-center gap-3 mb-4">
                <span className="text-[22px]">📊</span>
                <h3 className="text-[20px] font-bold text-[#0a1628]">ETF 熱門申購 TOP 10</h3>
              </div>
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <table className="w-full text-[15px]">
                  <thead><tr className="bg-slate-50 text-slate-400 text-[13px]">
                    <th className="px-4 py-3 text-left w-8">#</th>
                    <th className="px-4 py-3 text-left">代碼</th>
                    <th className="px-4 py-3 text-left">名稱</th>
                    <th className="px-4 py-3 text-right">淨流入</th>
                    <th className="px-4 py-3 text-right">漲跌</th>
                  </tr></thead>
                  <tbody>
                    {ETF_HOT.map(e => (
                      <tr key={e.rank} className="border-t border-slate-50 hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-2.5">
                          <span className={`text-[14px] font-bold ${e.rank<=3?"text-[#b38600]":"text-slate-300"}`}>{e.rank}</span>
                        </td>
                        <td className="px-4 py-2.5 font-bold text-[#b38600]">{e.code}</td>
                        <td className="px-4 py-2.5 text-slate-600 truncate max-w-[140px]">{e.name}</td>
                        <td className="px-4 py-2.5 text-right text-emerald-600 font-semibold">{e.flow}</td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${e.up?"text-emerald-600":"text-red-500"}`}>{e.change}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 text-right">
                <Link href="/etf" className="text-[14px] text-[#b38600] hover:underline">查看完整 ETF 資料庫 →</Link>
              </div>
            </div>
            {/* 基金 */}
            <div>
              <div className="flex items-center gap-3 mb-4">
                <span className="text-[22px]">🏦</span>
                <h3 className="text-[20px] font-bold text-[#0a1628]">基金熱門申購 TOP 10</h3>
              </div>
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <table className="w-full text-[15px]">
                  <thead><tr className="bg-slate-50 text-slate-400 text-[13px]">
                    <th className="px-4 py-3 text-left w-8">#</th>
                    <th className="px-4 py-3 text-left">公司</th>
                    <th className="px-4 py-3 text-left">基金名稱</th>
                    <th className="px-4 py-3 text-right">淨流入</th>
                    <th className="px-4 py-3 text-right">漲跌</th>
                  </tr></thead>
                  <tbody>
                    {FUND_HOT.map(f => (
                      <tr key={f.rank} className="border-t border-slate-50 hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-2.5">
                          <span className={`text-[14px] font-bold ${f.rank<=3?"text-[#b38600]":"text-slate-300"}`}>{f.rank}</span>
                        </td>
                        <td className="px-4 py-2.5 text-slate-500 text-[13px] whitespace-nowrap">{f.company}</td>
                        <td className="px-4 py-2.5 text-slate-600 truncate max-w-[160px]">{f.name}</td>
                        <td className="px-4 py-2.5 text-right text-emerald-600 font-semibold">{f.flow}</td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${f.up?"text-emerald-600":"text-red-500"}`}>{f.change}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 text-right">
                <Link href="/funds" className="text-[14px] text-[#b38600] hover:underline">查看完整基金資料庫 →</Link>
              </div>
            </div>
          </div>
          <p className="text-[14px] text-slate-400 mt-6 text-center">
            以上排行為示意範例，非即時申購數據，僅供功能展示。
          </p>
        </div>
      </section>

      {/* ══ ZONE 7：About SmartMatch（深藍）════════════════════════ */}
      <section className="relative z-10 py-24" style={{ backgroundColor:"#0a1628" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-14">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-4">ABOUT SMARTMATCH</div>
            <h2 className="text-[40px] font-black text-white">關於 SmartMatch</h2>
            <p className="text-[18px] text-slate-400 mt-3 max-w-[700px] mx-auto leading-relaxed">
              投資資料分析平台。整合市場數據、ETF 與基金資料庫、商品比較、客戶管理與資產配置工具，協助投資人建立更有系統的投資分析流程。
            </p>
          </div>
          <div className="grid lg:grid-cols-3 gap-6 mb-10">
            <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-7">
              <div className="text-[12px] tracking-[4px] text-[#F5B700] font-semibold mb-4">PLATFORM</div>
              <h3 className="text-[20px] font-bold text-white mb-4">平台介紹</h3>
              <div className="space-y-3 text-[16px] text-slate-400 leading-relaxed">
                <p>SmartMatch 為<span className="text-white font-semibold">瑞宇智庫</span>旗下投資資料分析平台。</p>
                <p>提供投資人格分析、ETF 與基金資料庫、商品比較中心、客戶管理 CRM 與資產配置工具。</p>
                <p>定位類似 Morningstar、Bloomberg，以<span className="text-white">客觀數據</span>為核心，不提供主觀投資建議。</p>
              </div>
            </div>
            <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-7">
              <div className="text-[12px] tracking-[4px] text-[#F5B700] font-semibold mb-4">BACKGROUND</div>
              <h3 className="text-[20px] font-bold text-white mb-4">創辦背景</h3>
              <div className="space-y-3 text-[16px] text-slate-400 leading-relaxed">
                <p>團隊來自銀行財富管理、基金研究與資產配置領域。</p>
                <p>長期觀察到理專與投資人缺乏一套整合的分析工具，決策流程高度仰賴人工與零散資訊。</p>
                <p>SmartMatch 的使命是讓每一位投資人都能擁有<span className="text-white">系統化投資分析流程</span>。</p>
              </div>
            </div>
            <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-7">
              <div className="text-[12px] tracking-[4px] text-[#F5B700] font-semibold mb-4">DISCLAIMER</div>
              <h3 className="text-[20px] font-bold text-white mb-4">免責聲明</h3>
              <div className="space-y-3 text-[16px] text-slate-400 leading-relaxed">
                <p>本平台所有內容均為<span className="text-slate-300">資料分析結果</span>，不構成任何投資建議或買賣推薦。</p>
                <p>投資人應自行評估風險，並詳閱各商品公開說明書後謹慎決策。</p>
                <p>過去績效不代表未來表現。本平台不對任何投資損益負責。</p>
              </div>
            </div>
          </div>
          {/* 數據規模 */}
          <div className="grid grid-cols-4 gap-4">
            {[
              { num:"95+",  label:"ETF 商品",     sub:"台股＋美股" },
              { num:"269+", label:"基金商品",       sub:"前20大基金公司" },
              { num:"34+",  label:"全球市場指標",   sub:"台灣、美國、亞歐、商品" },
              { num:"20題", label:"投資人格問卷",   sub:"四大人格類型" },
            ].map(s => (
              <div key={s.label} className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5 text-center">
                <div className="text-[36px] font-black text-[#F5B700] leading-none mb-1">{s.num}</div>
                <div className="text-[16px] font-semibold text-white mb-1">{s.label}</div>
                <div className="text-[14px] text-slate-500">{s.sub}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══ FOOTER ══════════════════════════════════════════════════ */}
      <footer className="relative z-10 bg-[#060e1e] border-t border-white/[0.06] py-10">
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
            <div>
              <div className="text-[24px] font-black text-white">Smart<span className="text-[#F5B700]">Match</span></div>
              <div className="text-[14px] text-slate-500 mt-1">瑞宇智庫｜投資資料分析平台</div>
            </div>
            <div className="flex flex-wrap gap-6 text-[16px] text-slate-500">
              <Link href="/markets" className="hover:text-slate-300 transition-colors">市場中心</Link>
              <Link href="/etf"     className="hover:text-slate-300 transition-colors">ETF資料庫</Link>
              <Link href="/funds"   className="hover:text-slate-300 transition-colors">基金資料庫</Link>
              <Link href="/compare" className="hover:text-slate-300 transition-colors">比較中心</Link>
              <Link href="/quiz"    className="hover:text-slate-300 transition-colors">人格分析</Link>
              <Link href="/clients" className="hover:text-slate-300 transition-colors">客戶管理</Link>
              <Link href="/pricing" className="hover:text-slate-300 transition-colors">方案說明</Link>
              <a href="mailto:contact@smartmatch.tw" className="hover:text-slate-300 transition-colors">聯絡我們</a>
            </div>
            <div className="text-[13px] text-slate-600 text-right">
              <div>以上資料為示意範例，不構成投資建議</div>
              <div className="mt-1">© 2026 SmartMatch｜瑞宇智庫 版權所有</div>
            </div>
          </div>
        </div>
      </footer>

    </main>
  );
}