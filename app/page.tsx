"use client";

import Link from "next/link";
import { useState } from "react";

// ── 熱門申購排行資料 ──────────────────────────────────────────────────
const ETF_HOT = [
  { rank: 1, code: "0050",  name: "元大台灣50",           flow: "+125.34億", change: "+0.72%", up: true  },
  { rank: 2, code: "00878", name: "國泰永續高股息",         flow: "+98.67億",  change: "+0.45%", up: true  },
  { rank: 3, code: "00919", name: "群益台灣精選高息",       flow: "+76.23億",  change: "+0.38%", up: true  },
  { rank: 4, code: "00940", name: "元大台灣價值高息",       flow: "+54.81億",  change: "+1.24%", up: true  },
  { rank: 5, code: "VOO",   name: "Vanguard S&P 500",     flow: "+48.32億",  change: "+0.68%", up: true  },
  { rank: 6, code: "QQQ",   name: "Invesco NASDAQ 100",   flow: "+38.14億",  change: "+0.85%", up: true  },
  { rank: 7, code: "00713", name: "元大台灣高息低波",       flow: "+29.44億",  change: "+0.43%", up: true  },
  { rank: 8, code: "VTI",   name: "Vanguard Total Market",flow: "+22.18億",  change: "+0.59%", up: true  },
  { rank: 9, code: "SOXX",  name: "iShares 半導體",        flow: "+18.92億",  change: "+1.23%", up: true  },
  { rank: 10, code: "00679B",name: "元大美債20年",          flow: "+14.77億",  change: "-0.32%", up: false },
];

const FUND_HOT = [
  { rank: 1,  name: "安聯台灣科技基金",     company: "安聯",  category: "股票型", flow: "+45.67億", change: "+1.25%", up: true  },
  { rank: 2,  name: "復華全球物聯網基金",   company: "復華",  category: "股票型", flow: "+32.18億", change: "+0.98%", up: true  },
  { rank: 3,  name: "國泰台灣5G+基金",      company: "國泰",  category: "股票型", flow: "+28.91億", change: "+1.12%", up: true  },
  { rank: 4,  name: "聯博全球高收益債券",   company: "聯博",  category: "債券型", flow: "+24.34億", change: "+0.42%", up: true  },
  { rank: 5,  name: "富達基金－美國基金",   company: "富達",  category: "股票型", flow: "+21.88億", change: "+0.81%", up: true  },
  { rank: 6,  name: "摩根美國科技基金",     company: "摩根",  category: "股票型", flow: "+19.24億", change: "+1.14%", up: true  },
  { rank: 7,  name: "安聯收益成長基金",     company: "安聯",  category: "平衡型", flow: "+16.42億", change: "+0.38%", up: true  },
  { rank: 8,  name: "貝萊德世界科技基金",   company: "貝萊德",category: "股票型", flow: "+13.88億", change: "+0.92%", up: true  },
  { rank: 9,  name: "野村亞太高股息基金",   company: "野村",  category: "股票型", flow: "+11.24億", change: "+0.44%", up: true  },
  { rank: 10, name: "施羅德環球股息收益",   company: "施羅德",category: "平衡型", flow: "+9.18億",  change: "+0.55%", up: true  },
];

// ── 全球市場概況資料 ─────────────────────────────────────────────────
type MktItem = { name: string; value: string; pts: string; pct: string; up: boolean };
type MktGroup = { id: string; label: string; sublabel: string; emoji: string; main: MktItem[]; more: MktItem[] };

const MARKET_GROUPS: MktGroup[] = [
  {
    id: "tw", label: "台灣市場", sublabel: "TAIWAN", emoji: "🇹🇼",
    main: [
      { name: "加權指數",   value: "22,184.32", pts: "+184.32", pct: "+0.84%", up: true  },
      { name: "台指期近月", value: "22,210.00", pts: "+128.00", pct: "+0.58%", up: true  },
      { name: "元大台灣50", value: "198.45",    pts: "+1.42",   pct: "+0.72%", up: true  },
    ],
    more: [
      { name: "櫃買指數", value: "248.32", pts: "+1.85",  pct: "+0.75%", up: true },
      { name: "金融指數", value: "2,184",  pts: "+12.40", pct: "+0.57%", up: true },
      { name: "電子指數", value: "1,092",  pts: "+9.84",  pct: "+0.91%", up: true },
    ],
  },
  {
    id: "us", label: "美國市場", sublabel: "UNITED STATES", emoji: "🇺🇸",
    main: [
      { name: "道瓊工業指數", value: "43,408.47", pts: "+228.41", pct: "+0.53%", up: true  },
      { name: "NASDAQ",       value: "19,271.34", pts: "+162.25", pct: "+0.85%", up: true  },
      { name: "S&P 500",      value: "5,842.01",  pts: "+39.52",  pct: "+0.68%", up: true  },
    ],
    more: [
      { name: "費城半導體",    value: "5,124.18", pts: "+62.10", pct: "+1.23%", up: true  },
      { name: "Russell 2000", value: "2,218.44", pts: "-6.89",   pct: "-0.31%", up: false },
      { name: "VIX 恐慌指數", value: "13.42",    pts: "-0.16",   pct: "-1.19%", up: false },
    ],
  },
  {
    id: "asia", label: "亞洲市場", sublabel: "ASIA", emoji: "🌏",
    main: [
      { name: "日經 225",   value: "39,842.21", pts: "+411.24", pct: "+1.04%", up: true  },
      { name: "恒生指數",   value: "23,184.45", pts: "-109.60", pct: "-0.47%", up: false },
      { name: "韓國 KOSPI", value: "2,621.15",  pts: "+15.92",  pct: "+0.61%", up: true  },
    ],
    more: [
      { name: "上證指數",         value: "3,412.18",  pts: "+7.48",  pct: "+0.22%", up: true },
      { name: "深圳成指",         value: "10,824.32", pts: "+98.42", pct: "+0.92%", up: true },
      { name: "MSCI Asia ex JP", value: "824.11",    pts: "+3.12",  pct: "+0.38%", up: true },
    ],
  },
  {
    id: "eu", label: "歐洲市場", sublabel: "EUROPE", emoji: "🇪🇺",
    main: [
      { name: "德國 DAX",      value: "22,854.12", pts: "+100.56", pct: "+0.44%", up: true },
      { name: "英國 FTSE 100", value: "8,732.11",  pts: "+24.44",  pct: "+0.28%", up: true },
      { name: "法國 CAC 40",   value: "7,981.26",  pts: "+15.16",  pct: "+0.19%", up: true },
    ],
    more: [
      { name: "Euro STOXX 50", value: "5,312.44",  pts: "+18.60", pct: "+0.35%", up: true },
      { name: "瑞士 SMI",      value: "12,184.20", pts: "+48.24", pct: "+0.40%", up: true },
      { name: "義大利 MIB",    value: "38,420.18", pts: "+84.12", pct: "+0.22%", up: true },
    ],
  },
  {
    id: "cmd", label: "商品市場", sublabel: "COMMODITIES", emoji: "🥇",
    main: [
      { name: "黃金 XAU/USD", value: "3,342.12", pts: "+30.18", pct: "+0.91%", up: true  },
      { name: "WTI 原油",     value: "71.28",    pts: "-0.60",  pct: "-0.83%", up: false },
      { name: "布蘭特原油",   value: "74.52",    pts: "-0.53",  pct: "-0.71%", up: false },
    ],
    more: [
      { name: "白銀 XAG/USD", value: "32.84", pts: "+0.37",  pct: "+1.14%", up: true  },
      { name: "銅",           value: "4.52",  pts: "+0.02",  pct: "+0.44%", up: true  },
      { name: "天然氣",       value: "2.18",  pts: "-0.04",  pct: "-1.80%", up: false },
    ],
  },
];

// ── Sparkline SVG ────────────────────────────────────────────────────
function Sparkline({ up }: { up: boolean }) {
  const upSeq   = [38,35,37,32,29,33,27,23,19,16,13,10];
  const downSeq = [10,14,12,18,15,20,24,19,27,25,31,36];
  const pts = up ? upSeq : downSeq;
  const minV = Math.min(...pts), maxV = Math.max(...pts);
  const range = maxV - minV || 1;
  const W = 120, H = 40;
  const coords = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * W;
    const y = H - ((v - minV) / range) * (H - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const color = up ? "#22C55E" : "#EF4444";
  const gradId = `sp-${up ? "u" : "d"}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="shrink-0 opacity-90">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${coords} ${W},${H}`} fill={`url(#${gradId})`} />
      <polyline points={coords} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MktCol({ item }: { item: MktItem }) {
  const isUp = item.up;
  const color = isUp ? "text-[#22C55E]" : "text-[#EF4444]";
  const arrow = isUp ? "▲" : "▼";
  return (
    <div className="flex items-center gap-4 flex-1 min-w-0">
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold text-white/60 mb-1 truncate">{item.name}</div>
        <div className="text-[42px] font-bold text-white leading-none tracking-tight mb-1">{item.value}</div>
        <div className={`text-[18px] font-semibold ${color}`}>
          {arrow} {item.pts} &nbsp;<span className="text-[16px] font-semibold">{item.pct}</span>
        </div>
      </div>
      <Sparkline up={item.up} />
    </div>
  );
}

function MktRow({ group }: { group: MktGroup }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="rounded-2xl border border-white/[0.08] overflow-hidden transition-all hover:-translate-y-1"
      style={{
        background: "rgba(17,24,39,0.85)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        padding: "24px 28px",
        marginBottom: "16px",
      }}
    >
      <div className="flex items-center gap-8">
        <div className="w-[150px] shrink-0 flex items-center gap-3">
          <span className="text-[32px]">{group.emoji}</span>
          <div>
            <div className="text-[20px] font-bold text-white leading-tight">{group.label}</div>
            <div className="text-[10px] tracking-[3px] text-white/40 mt-0.5">{group.sublabel}</div>
          </div>
        </div>
        <div className="w-px h-14 bg-white/[0.08] shrink-0" />
        <div className="flex flex-1 gap-4 min-w-0">
          {group.main.map((item, i) => (
            <div key={item.name} className="flex items-center gap-4 flex-1 min-w-0">
              <MktCol item={item} />
              {i < group.main.length - 1 && <div className="w-px h-12 bg-white/[0.06] shrink-0" />}
            </div>
          ))}
        </div>
        <button
          onClick={() => setOpen(!open)}
          className="shrink-0 text-[13px] font-semibold text-[#F5B700] hover:text-[#e0a800] transition-colors whitespace-nowrap ml-4"
        >
          {open ? "收起 ↑" : "查看更多 →"}
        </button>
      </div>
      {open && (
        <div className="flex items-center gap-8 mt-5 pt-5 border-t border-white/[0.06]">
          <div className="w-[150px] shrink-0" />
          <div className="w-px h-12 bg-white/[0.06] shrink-0" />
          <div className="flex flex-1 gap-4 min-w-0">
            {group.more.map((item, i) => (
              <div key={item.name} className="flex items-center gap-4 flex-1 min-w-0">
                <MktCol item={item} />
                {i < group.more.length - 1 && <div className="w-px h-12 bg-white/[0.06] shrink-0" />}
              </div>
            ))}
          </div>
          <div className="w-[100px] shrink-0" />
        </div>
      )}
    </div>
  );
}

function MarketDashboard() {
  return (
    <div>
      {MARKET_GROUPS.map((g) => <MktRow key={g.id} group={g} />)}
    </div>
  );
}

export default function Home() {
  return (
    <main className="min-h-screen relative">
      {/* 背景由 layout.tsx GlobalBackground 統一處理 */}

      {/* NAVBAR */}
      <header className="fixed top-0 left-0 w-full z-50 bg-[#040a18]/85 backdrop-blur-xl border-b border-white/[0.08]">
        <div className="max-w-[1700px] mx-auto h-20 px-10 flex items-center justify-between">
          <div>
            <div className="text-[36px] font-black text-white leading-none">
              Smart<span className="text-[#F5B700]">Match</span>
            </div>
            <div className="text-[12px] text-slate-400 mt-0.5">ETF & 基金資產配置分析平台</div>
          </div>
          <nav className="hidden lg:flex gap-8 text-[15px] font-semibold text-slate-300">
            <Link href="/quiz" className="hover:text-white transition-colors">投資人格分析</Link>
            <Link href="/etf" className="hover:text-white transition-colors">ETF篩選器</Link>
            <Link href="/funds" className="hover:text-white transition-colors">基金篩選器</Link>
            <Link href="/compare" className="hover:text-white transition-colors">比較中心</Link>
            <Link href="/clients" className="hover:text-white transition-colors">客戶管理</Link>
            <Link href="/pricing" className="hover:text-white transition-colors text-[#F5B700]">方案</Link>
          </nav>
          <div className="flex items-center gap-4">
            <a href="#" className="text-[15px] font-semibold text-slate-300 border border-white/30 px-5 py-2.5 rounded-lg hover:bg-white/10 transition-colors">登入</a>
            <Link href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-6 py-2.5 rounded-lg font-bold text-[15px] transition-colors">
              免費註冊
            </Link>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="relative z-10 min-h-screen">
        {/* 左側漸層讓文字更清晰 */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#020817]/80 via-[#020817]/40 to-transparent z-[1]" />

        <div className="relative z-10 max-w-[1600px] mx-auto px-10 flex items-center min-h-screen pt-20">
          <div className="grid lg:grid-cols-[55%_45%] w-full items-center gap-12 py-20">

            {/* LEFT */}
            <div className="space-y-8">
              <div className="tracking-[10px] text-[#F5B700] text-[16px] font-semibold">SMARTMATCH</div>

              {/* 主標題 */}
              <div>
                <h1 className="text-[64px] font-black leading-[1.1] text-white tracking-tight mb-4">
                  3分鐘了解你的<br />
                  <span className="text-[#F5B700]">投資風格</span>
                </h1>
                <p className="text-[22px] text-white/70 leading-[1.7] max-w-[540px]">
                  透過投資人格分析、ETF 與基金資料庫，以及全球市場資訊，
                  快速建立屬於自己的投資決策流程。
                </p>
              </div>

              {/* 按鈕 */}
              <div className="flex gap-4 flex-wrap">
                <a href="/quiz"
                  className="bg-[#F5B700] hover:bg-[#e0a800] text-[#020817] px-10 py-4 rounded-xl font-black text-[20px] transition-colors shadow-[0_0_40px_rgba(245,183,0,0.3)]">
                  免費開始分析 →
                </a>
                <a href="/etf"
                  className="bg-white/[0.08] backdrop-blur-md border border-white/[0.15] text-white px-10 py-4 rounded-xl font-semibold text-[20px] hover:bg-white/[0.15] transition-colors">
                  瀏覽 ETF 與基金資料庫
                </a>
              </div>

              {/* 四個統計卡 */}
              <div className="grid grid-cols-4 gap-4 pt-4">
                {[
                  { num: "95+",  label: "ETF 資料" },
                  { num: "269+", label: "基金資料" },
                  { num: "34+",  label: "全球市場指標" },
                  { num: "20題", label: "投資人格分析" },
                ].map((s) => (
                  <div key={s.label}
                    className="bg-white/[0.06] backdrop-blur-sm border border-white/[0.1] rounded-2xl p-5 text-center">
                    <div className="text-[42px] font-black text-[#F5B700] leading-none mb-2">{s.num}</div>
                    <div className="text-[14px] text-white/60 leading-tight">{s.label}</div>
                  </div>
                ))}
              </div>

              <p className="text-[16px] text-white/35">適合理財顧問、ETF 投資人、基金投資人與自主投資者</p>
            </div>

            {/* RIGHT — 大型 Dashboard Mockup */}
            <div
              className="rounded-3xl border border-white/[0.12] overflow-hidden shadow-[0_40px_120px_rgba(0,0,0,0.6)]"
              style={{ background: "rgba(10,17,35,0.85)", backdropFilter: "blur(24px)" }}
            >
              {/* 頂部 bar */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08]">
                <div className="text-[13px] font-bold text-white/60 tracking-[4px]">SMARTMATCH REPORT</div>
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-red-500/60" />
                  <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
                  <div className="w-3 h-3 rounded-full bg-green-500/60" />
                </div>
              </div>

              <div className="p-6 space-y-5">

                {/* 人格分析 */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="text-[11px] tracking-[4px] text-[#F5B700] mb-2">投資人格分析結果</div>
                  <div className="flex items-center justify-between">
                    <div className="text-[28px] font-black text-white">穩健型</div>
                    <div className="text-[#F5B700] text-[18px]">★★★☆☆</div>
                  </div>
                  <div className="text-[13px] text-white/50 mt-1">風險承受度：中等｜總分 58 分</div>
                </div>

                {/* 配置分析 */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="text-[11px] tracking-[4px] text-[#F5B700] mb-3">配置分析</div>
                  <div className="flex h-3 rounded-full overflow-hidden mb-3">
                    <div style={{ width:"50%", backgroundColor:"#F5B700" }} />
                    <div style={{ width:"30%", backgroundColor:"#64748b" }} />
                    <div style={{ width:"20%", backgroundColor:"#334155" }} />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[["股票資產","50%","#F5B700"],["債券資產","30%","#64748b"],["現金部位","20%","#334155"]].map(([l,v,c])=>(
                      <div key={l} className="text-center">
                        <div className="text-[20px] font-black text-white">{v}</div>
                        <div className="text-[11px] mt-0.5" style={{ color: c as string }}>{l}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ETF 篩選結果 */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="text-[11px] tracking-[4px] text-[#F5B700] mb-3">ETF 篩選結果</div>
                  <div className="space-y-2">
                    {[["0050","元大台灣50","+21.6%"],["00919","群益台灣精選高息","+14.2%"],["BND","Vanguard Bond ETF","+3.8%"]].map(([code,name,ret])=>(
                      <div key={code} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-bold text-[#F5B700] w-14">{code}</span>
                          <span className="text-[12px] text-white/50 truncate max-w-[140px]">{name}</span>
                        </div>
                        <span className="text-[13px] font-semibold text-emerald-400">{ret}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 基金篩選結果 */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="text-[11px] tracking-[4px] text-[#F5B700] mb-3">基金篩選結果</div>
                  <div className="space-y-2">
                    {[["霸菱","霸菱優先順位資產基金","★★★★","6.2%"],["聯博","聯博收益債券基金","★★★★","6.1%"],["貝萊德","貝萊德全球多元收益","★★★★","5.8%"]].map(([co,name,stars,div])=>(
                      <div key={name} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-bold text-white/60 w-10">{co}</span>
                          <span className="text-[12px] text-white/50 truncate max-w-[120px]">{name}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-[#F5B700]">{stars}</span>
                          <span className="text-[12px] font-semibold text-[#F5B700]">{div}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 快速操作列 */}
                <div className="flex gap-2">
                  <div className="flex-1 bg-[#F5B700]/15 border border-[#F5B700]/30 rounded-lg py-2 text-center text-[12px] font-bold text-[#F5B700]">⭐ 收藏商品</div>
                  <div className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg py-2 text-center text-[12px] font-bold text-white/60">📊 加入比較</div>
                  <div className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg py-2 text-center text-[12px] font-bold text-white/60">⬇ 匯出 PDF</div>
                </div>

              </div>
            </div>

          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section className="relative z-10 py-32 border-t border-white/[0.06]">
        <div className="max-w-[1400px] mx-auto px-10">
          <div className="text-center mb-16">
            <div className="text-[16px] tracking-[10px] text-[#F5B700] font-semibold mb-4">FEATURES</div>
            <h2 className="text-[56px] font-black text-white">核心功能</h2>
          </div>
          <div className="grid grid-cols-4 gap-6">
            {[
              { icon: "👤", title: "投資人格分析", desc: "20題問卷精準評估風險屬性，自動產生個人化配置建議", href: "/quiz" },
              { icon: "📊", title: "ETF / 基金資料庫", desc: "95檔ETF＋270檔基金，完整搜尋篩選與排序功能", href: "/etf" },
              { icon: "⚖️", title: "ETF＋基金比較中心", desc: "可同時比較ETF與基金的分析工具", href: "/compare" },
              { icon: "👥", title: "客戶管理 CRM", desc: "理專專屬客戶管理，支援PDF報告一鍵匯出", href: "/clients" },
            ].map((f) => (
              <Link key={f.title} href={f.href} className="bg-white/[0.05] border border-white/10 rounded-2xl p-8 hover:bg-white/[0.09] hover:border-[#F5B700]/40 transition-all group">
                <div className="text-[40px] mb-4">{f.icon}</div>
                <div className="text-[20px] font-bold text-white mb-3 group-hover:text-[#F5B700] transition-colors">{f.title}</div>
                <div className="text-[15px] text-slate-400 leading-relaxed">{f.desc}</div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* PERSONALITY TYPES */}
      <section className="relative z-10 py-32 border-t border-white/[0.06]">
        <div className="max-w-[1400px] mx-auto px-10">
          <div className="text-center mb-16">
            <div className="text-[16px] tracking-[10px] text-[#F5B700] font-semibold mb-4">PERSONALITY</div>
            <h2 className="text-[56px] font-black text-white">四大投資人格</h2>
          </div>
          <div className="grid grid-cols-4 gap-5">
            {[
              { tag: "保守型", risk: "★★☆☆☆", desc: "重視穩定收益，以債券與現金為主", color: "#64748b" },
              { tag: "穩健型", risk: "★★★☆☆", desc: "股債均衡配置，追求長期穩健成長", color: "#3b82f6" },
              { tag: "成長型", risk: "★★★★☆", desc: "偏重股票配置，接受中等波動", color: "#F5B700" },
              { tag: "積極型", risk: "★★★★★", desc: "高度成長導向，承受較大短期波動", color: "#ef4444" },
            ].map((p) => (
              <div key={p.tag} className="bg-white/[0.05] border border-white/10 rounded-2xl p-7 hover:border-white/20 transition-all">
                <div className="inline-block px-3 py-1 rounded-full text-[13px] font-bold mb-4" style={{ backgroundColor: p.color + "33", border: `1px solid ${p.color}55`, color: p.color }}>
                  {p.tag}
                </div>
                <div className="text-[#F5B700] text-[16px] mb-3">{p.risk}</div>
                <div className="text-[15px] text-slate-400 leading-relaxed">{p.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="relative z-10 py-32 border-t border-white/[0.06]">
        <div className="max-w-[1400px] mx-auto px-10">
          <div className="text-center mb-16">
            <div className="text-[16px] tracking-[10px] text-[#F5B700] font-semibold mb-4">HOW IT WORKS</div>
            <h2 className="text-[56px] font-black text-white">投資分析流程</h2>
          </div>
          <div className="grid grid-cols-4 gap-6">
            {[
              { step: "STEP 1", title: "投資人格分析", desc: "了解風險偏好與投資屬性", icon: "🧠" },
              { step: "STEP 2", title: "ETF / 基金篩選", desc: "依條件快速篩選與比較標的", icon: "🔍" },
              { step: "STEP 3", title: "資產配置分析", desc: "生成個人化配置參考", icon: "📈" },
              { step: "STEP 4", title: "匯出分析報告", desc: "PDF格式，完整留存紀錄", icon: "📄" },
            ].map((s, i) => (
              <div key={s.step} className="relative">
                {i < 3 && <div className="absolute top-8 left-[calc(100%-24px)] w-12 h-0.5 bg-[#F5B700]/30 z-10 hidden lg:block" />}
                <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-7 text-center">
                  <div className="text-[11px] tracking-[4px] text-[#F5B700] font-semibold mb-3">{s.step}</div>
                  <div className="text-[36px] mb-4">{s.icon}</div>
                  <div className="text-[18px] font-bold text-white mb-2">{s.title}</div>
                  <div className="text-[14px] text-slate-400">{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 熱門申購排行榜 */}
      <section className="relative z-10 py-24 border-t border-white/[0.06]">
        <div className="max-w-[1400px] mx-auto px-10">
          <div className="text-center mb-14">
            <div className="text-[16px] tracking-[10px] text-[#F5B700] font-semibold mb-3">HOT PICKS</div>
            <h2 className="text-[48px] font-black text-white">熱門申購排行榜</h2>
            <p className="text-[16px] text-slate-400 mt-3">近一週資金淨流入排行</p>
          </div>
          <div className="grid grid-cols-2 gap-8">
            <div>
              <div className="flex items-center gap-3 mb-5">
                <span className="text-[20px]">📊</span>
                <h3 className="text-[22px] font-bold text-white">ETF 熱門申購 TOP 10</h3>
              </div>
              <div className="bg-white/[0.03] border border-white/10 rounded-2xl overflow-hidden">
                <table className="w-full text-[14px]">
                  <thead>
                    <tr className="bg-white/[0.05] text-slate-400 text-[12px]">
                      <th className="px-4 py-3 text-left w-8">#</th>
                      <th className="px-4 py-3 text-left">代碼</th>
                      <th className="px-4 py-3 text-left">名稱</th>
                      <th className="px-4 py-3 text-right">淨流入</th>
                      <th className="px-4 py-3 text-right">漲跌</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ETF_HOT.map((e) => (
                      <tr key={e.rank} className="border-t border-white/[0.06] hover:bg-white/[0.03] transition-colors">
                        <td className="px-4 py-2.5"><span className={`text-[13px] font-bold ${e.rank <= 3 ? "text-[#F5B700]" : "text-slate-600"}`}>{e.rank}</span></td>
                        <td className="px-4 py-2.5 font-bold text-[#F5B700]">{e.code}</td>
                        <td className="px-4 py-2.5 text-slate-300 truncate max-w-[140px]">{e.name}</td>
                        <td className="px-4 py-2.5 text-right text-emerald-400 font-semibold">{e.flow}</td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${e.up ? "text-emerald-400" : "text-red-400"}`}>{e.change}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 text-right">
                <Link href="/etf" className="text-[13px] text-[#F5B700] hover:underline">查看完整 ETF 資料庫 →</Link>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-3 mb-5">
                <span className="text-[20px]">🏦</span>
                <h3 className="text-[22px] font-bold text-white">基金熱門申購 TOP 10</h3>
              </div>
              <div className="bg-white/[0.03] border border-white/10 rounded-2xl overflow-hidden">
                <table className="w-full text-[14px]">
                  <thead>
                    <tr className="bg-white/[0.05] text-slate-400 text-[12px]">
                      <th className="px-4 py-3 text-left w-8">#</th>
                      <th className="px-4 py-3 text-left">公司</th>
                      <th className="px-4 py-3 text-left">基金名稱</th>
                      <th className="px-4 py-3 text-right">淨流入</th>
                      <th className="px-4 py-3 text-right">漲跌</th>
                    </tr>
                  </thead>
                  <tbody>
                    {FUND_HOT.map((f) => (
                      <tr key={f.rank} className="border-t border-white/[0.06] hover:bg-white/[0.03] transition-colors">
                        <td className="px-4 py-2.5"><span className={`text-[13px] font-bold ${f.rank <= 3 ? "text-[#F5B700]" : "text-slate-600"}`}>{f.rank}</span></td>
                        <td className="px-4 py-2.5 text-slate-400 text-[12px] whitespace-nowrap">{f.company}</td>
                        <td className="px-4 py-2.5 text-slate-300 truncate max-w-[160px]">{f.name}</td>
                        <td className="px-4 py-2.5 text-right text-emerald-400 font-semibold">{f.flow}</td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${f.up ? "text-emerald-400" : "text-red-400"}`}>{f.change}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 text-right">
                <Link href="/funds" className="text-[13px] text-[#F5B700] hover:underline">查看完整基金資料庫 →</Link>
              </div>
            </div>
          </div>
          <p className="text-[12px] text-slate-600 mt-6 text-center">
            以上排行為示意範例，非即時申購數據，僅供功能展示。實際申購排行請參考各基金公司或投信投顧公會公開資料。
          </p>
        </div>
      </section>

      {/* PRICING */}
      <section className="relative z-10 py-32 border-t border-white/[0.06]" id="pricing">
        <div className="max-w-[1400px] mx-auto px-10">
          <div className="text-center mb-16">
            <div className="text-[16px] tracking-[10px] text-[#F5B700] font-semibold mb-4">PRICING</div>
            <h2 className="text-[56px] font-black text-white">選擇適合你的方案</h2>
            <p className="text-[18px] text-slate-400 mt-4">從免費開始，隨時升級。所有方案均含核心分析功能。</p>
          </div>
          <div className="grid grid-cols-5 gap-4 mb-12">
            <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-6 flex flex-col">
              <div className="text-[12px] font-semibold text-slate-400 tracking-[2px] mb-3">免費版</div>
              <div className="text-[40px] font-black text-white leading-none mb-1">$0</div>
              <div className="text-[13px] text-slate-500 mb-6">永久免費</div>
              <div className="flex flex-col gap-2.5 flex-1 mb-6">
                <PF text="人格分析（無限次）" /><PF text="客戶管理（10 位）" /><PF text="ETF / 基金資料庫" /><PF text="5 檔走勢比較" /><PF text="PDF（每月1份）" /><PFN text="客戶標籤" /><PFN text="混合分析" />
              </div>
              <a href="/clients" className="block text-center border border-white/20 text-white py-2.5 rounded-xl font-semibold text-[14px] hover:bg-white/10 transition-colors">免費開始</a>
            </div>
            <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-6 flex flex-col">
              <div className="text-[12px] font-semibold text-slate-400 tracking-[2px] mb-3">Lite</div>
              <div className="text-[40px] font-black text-white leading-none mb-1">NT$99</div>
              <div className="text-[13px] text-slate-500 mb-6">每月</div>
              <div className="flex flex-col gap-2.5 flex-1 mb-6">
                <PF text="人格分析（無限次）" /><PF text="客戶管理（30 位）" /><PF text="ETF / 基金資料庫" /><PF text="10 檔走勢比較" /><PF text="PDF（每月20份）" /><PF text="客戶標籤" /><PFN text="混合分析" />
              </div>
              <button onClick={() => alert("付款功能即將推出，我們會第一時間通知您。")} className="block w-full text-center border border-white/20 text-white py-2.5 rounded-xl font-semibold text-[14px] hover:bg-white/10 transition-colors">選擇 Lite</button>
            </div>
            <div className="bg-[#F5B700]/10 border-2 border-[#F5B700] rounded-2xl p-6 flex flex-col relative">
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-[#F5B700] text-[#0B1220] text-[11px] font-bold px-3 py-1.5 rounded-full whitespace-nowrap">主力方案</div>
              <div className="text-[12px] font-semibold text-[#F5B700] tracking-[2px] mb-3">Pro</div>
              <div className="text-[40px] font-black text-white leading-none mb-1">NT$299</div>
              <div className="text-[13px] text-slate-400 mb-6">每月</div>
              <div className="flex flex-col gap-2.5 flex-1 mb-6">
                <PF text="人格分析（無限次）" /><PF text="客戶管理（100 位）" /><PF text="ETF / 基金資料庫" /><PF text="20 檔走勢比較" /><PF text="無限 PDF 匯出" /><PF text="客戶標籤" /><PF text="ETF＋基金混合分析" />
              </div>
              <button onClick={() => alert("付款功能即將推出，我們會第一時間通知您。")} className="block w-full text-center bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] py-2.5 rounded-xl font-bold text-[14px] transition-colors">選擇 Pro</button>
            </div>
            <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-6 flex flex-col">
              <div className="text-[12px] font-semibold text-slate-400 tracking-[2px] mb-3">Advisor</div>
              <div className="text-[40px] font-black text-white leading-none mb-1">NT$599</div>
              <div className="text-[13px] text-slate-500 mb-6">每月</div>
              <div className="flex flex-col gap-2.5 flex-1 mb-6">
                <PF text="Pro 全部功能" /><PF text="客戶管理（500 位）" /><PF text="無限走勢比較" /><PF text="商品重疊度分析" /><PF text="組合回測分析" /><PF text="理專儀表板" /><PFN text="多人帳號" />
              </div>
              <button onClick={() => alert("付款功能即將推出，我們會第一時間通知您。")} className="block w-full text-center border border-white/20 text-white py-2.5 rounded-xl font-semibold text-[14px] hover:bg-white/10 transition-colors">選擇 Advisor</button>
            </div>
            <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-6 flex flex-col">
              <div className="text-[12px] font-semibold text-[#F5B700] tracking-[2px] mb-3">Team</div>
              <div className="text-[40px] font-black text-white leading-none mb-1">NT$1,499</div>
              <div className="text-[13px] text-slate-500 mb-6">每月</div>
              <div className="flex flex-col gap-2.5 flex-1 mb-6">
                <PF text="Advisor 全部功能" /><PF text="客戶管理（無限）" /><PF text="多人帳號（5人起）" /><PF text="客戶共享" /><PF text="理專主管儀表板" /><PF text="優先客服支援" /><PF text="客製化報告模板" />
              </div>
              <button onClick={() => alert("請聯繫我們取得團隊版方案。")} className="block w-full text-center border border-[#F5B700]/50 text-[#F5B700] py-2.5 rounded-xl font-bold text-[14px] hover:bg-[#F5B700]/10 transition-colors">聯繫我們</button>
            </div>
          </div>
          <div className="border border-white/10 rounded-2xl overflow-hidden mb-10">
            <table className="w-full text-left text-[14px]">
              <thead>
                <tr className="bg-white/[0.05] border-b border-white/10">
                  <th className="px-5 py-4 font-bold text-white w-[28%]">功能</th>
                  <th className="px-4 py-4 font-bold text-slate-400 text-center">免費</th>
                  <th className="px-4 py-4 font-bold text-slate-400 text-center">Lite</th>
                  <th className="px-4 py-4 font-bold text-[#F5B700] text-center">Pro</th>
                  <th className="px-4 py-4 font-bold text-slate-400 text-center">Advisor</th>
                  <th className="px-4 py-4 font-bold text-slate-400 text-center">Team</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["客戶管理","10位","30位","100位","500位","無限",true],
                  ["投資人格分析","無限","無限","無限","無限","無限"],
                  ["ETF/基金資料庫","✓","✓","✓","✓","✓",true],
                  ["走勢比較","5檔","10檔","20檔","無限","無限"],
                  ["PDF報告","1份/月","20份/月","無限","無限","無限",true],
                  ["客戶標籤","✗","✓","✓","✓","✓"],
                  ["ETF+基金混合分析","✗","✗","✓","✓","✓",true],
                  ["商品重疊分析","✗","✗","✗","✓","✓"],
                  ["組合回測","✗","✗","✗","✓","✓",true],
                  ["多人帳號","✗","✗","✗","✗","5人起"],
                  ["客戶共享","✗","✗","✗","✗","✓",true],
                ].map(([label,free,lite,pro,advisor,team,highlight],i)=>(
                  <tr key={i} className={`border-b border-white/[0.06] ${highlight?"bg-white/[0.03]":""}`}>
                    <td className="px-5 py-3 font-medium text-slate-300">{label}</td>
                    <td className={`px-4 py-3 text-center ${free==="✗"?"text-slate-600":"text-slate-400"}`}>{free}</td>
                    <td className={`px-4 py-3 text-center ${lite==="✗"?"text-slate-600":"text-slate-400"}`}>{lite}</td>
                    <td className={`px-4 py-3 text-center font-semibold ${pro==="✗"?"text-slate-600":"text-white"}`}>{pro}</td>
                    <td className={`px-4 py-3 text-center ${advisor==="✗"?"text-slate-600":"text-slate-400"}`}>{advisor}</td>
                    <td className={`px-4 py-3 text-center ${team==="✗"?"text-slate-600":"text-slate-400"}`}>{team}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-center">
            <a href="/pricing" className="inline-block border border-white/20 text-white px-10 py-4 rounded-lg hover:bg-white/10 transition-colors font-semibold text-[16px]">查看完整方案說明 →</a>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          Phase 1：About SmartMatch — 信任感建立
      ══════════════════════════════════════════════════════════════ */}
      <section className="relative z-10 py-24 border-t border-white/[0.06]">
        <div className="max-w-[1400px] mx-auto px-10">

          {/* 標題 */}
          <div className="text-center mb-16">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-4">ABOUT SMARTMATCH</div>
            <h2 className="text-[48px] font-black text-white leading-tight mb-4">關於 SmartMatch</h2>
            <p className="text-[18px] text-slate-400 max-w-[720px] mx-auto leading-relaxed">
              投資資料分析平台。整合市場數據、ETF 與基金資料庫、商品比較、客戶管理與資產配置工具，協助投資人建立更有系統的投資分析流程。
            </p>
            <p className="text-[14px] text-slate-600 mt-3">
              本平台不提供投資建議，所有資訊僅供研究與資料分析使用。
            </p>
          </div>

          {/* 三欄：平台介紹 / 創辦背景 / 數據規模 */}
          <div className="grid lg:grid-cols-3 gap-6 mb-12">

            {/* 平台介紹 */}
            <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-7">
              <div className="text-[13px] tracking-[4px] text-[#F5B700] font-semibold mb-4">PLATFORM</div>
              <h3 className="text-[22px] font-bold text-white mb-4">平台介紹</h3>
              <div className="space-y-3 text-[14px] text-slate-400 leading-relaxed">
                <p>SmartMatch 為<span className="text-white font-semibold">瑞宇智庫</span>旗下投資資料分析平台。</p>
                <p>提供投資人格分析、ETF 與基金資料庫、商品比較中心、客戶管理 CRM 與資產配置工具。</p>
                <p>定位類似 Morningstar、Bloomberg、FactSet，以<span className="text-white">客觀數據</span>為核心，不提供主觀投資建議。</p>
              </div>
            </div>

            {/* 創辦背景 */}
            <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-7">
              <div className="text-[13px] tracking-[4px] text-[#F5B700] font-semibold mb-4">BACKGROUND</div>
              <h3 className="text-[22px] font-bold text-white mb-4">創辦背景</h3>
              <div className="space-y-3 text-[14px] text-slate-400 leading-relaxed">
                <p>團隊來自銀行財富管理、基金研究與資產配置領域。</p>
                <p>長期觀察到理專與投資人缺乏一套整合的分析工具，決策流程高度仰賴人工與零散資訊。</p>
                <p>SmartMatch 的使命是讓每一位投資人都能擁有屬於自己的<span className="text-white">系統化投資分析流程</span>。</p>
              </div>
            </div>

            {/* 資料來源 */}
            <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-7">
              <div className="text-[13px] tracking-[4px] text-[#F5B700] font-semibold mb-4">DATA SOURCES</div>
              <h3 className="text-[22px] font-bold text-white mb-4">資料來源</h3>
              <div className="space-y-2 text-[14px] text-slate-400">
                <div className="flex items-start gap-2"><span className="text-[#F5B700] shrink-0 mt-0.5">·</span><span>ETF 資料：各發行商公開說明書</span></div>
                <div className="flex items-start gap-2"><span className="text-[#F5B700] shrink-0 mt-0.5">·</span><span>基金資料：投信投顧公會公開資料</span></div>
                <div className="flex items-start gap-2"><span className="text-[#F5B700] shrink-0 mt-0.5">·</span><span>市場指數：各交易所公開資訊</span></div>
                <div className="flex items-start gap-2"><span className="text-[#F5B700] shrink-0 mt-0.5">·</span><span>申購排行：投信投顧公會月報</span></div>
                <p className="text-[12px] text-slate-600 mt-3 leading-relaxed">
                  目前版本使用示意數據供功能展示。正式版本將接入即時資料來源。
                </p>
              </div>
            </div>

          </div>

          {/* 數據規模 */}
          <div className="grid grid-cols-4 gap-4 mb-12">
            {[
              { num: "95+",  label: "ETF 商品",       sub: "台股＋美股" },
              { num: "269+", label: "基金商品",         sub: "前20大基金公司" },
              { num: "34+",  label: "全球市場指標",     sub: "台灣、美國、亞歐、商品" },
              { num: "20題", label: "投資人格問卷",     sub: "四大人格類型" },
            ].map((s) => (
              <div key={s.label} className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5 text-center">
                <div className="text-[36px] font-black text-[#F5B700] leading-none mb-1">{s.num}</div>
                <div className="text-[15px] font-semibold text-white mb-1">{s.label}</div>
                <div className="text-[12px] text-slate-500">{s.sub}</div>
              </div>
            ))}
          </div>

          {/* 公司資訊、法律聲明、隱私權 */}
          <div className="grid lg:grid-cols-3 gap-5">

            <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-6">
              <div className="text-[14px] font-bold text-white mb-4">🏢 公司資訊</div>
              <div className="space-y-2.5 text-[13px]">
                <div className="flex gap-3"><span className="text-slate-500 w-20 shrink-0">平台名稱</span><span className="text-white">SmartMatch</span></div>
                <div className="flex gap-3"><span className="text-slate-500 w-20 shrink-0">母公司</span><span className="text-white">瑞宇智庫</span></div>
                <div className="flex gap-3"><span className="text-slate-500 w-20 shrink-0">平台定位</span><span className="text-slate-300">投資資料分析平台</span></div>
                <div className="flex gap-3"><span className="text-slate-500 w-20 shrink-0">服務對象</span><span className="text-slate-300">理財顧問、理專、自主投資人</span></div>
                <div className="flex gap-3"><span className="text-slate-500 w-20 shrink-0">聯絡信箱</span>
                  <a href="mailto:contact@smartmatch.tw" className="text-[#F5B700] hover:underline">contact@smartmatch.tw</a>
                </div>
              </div>
            </div>

            <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-6">
              <div className="text-[14px] font-bold text-white mb-4">⚖️ 免責聲明</div>
              <p className="text-[13px] text-slate-500 leading-[1.9]">
                本平台所有內容（包含投資人格分析結果、ETF 及基金資料、資產配置分析）均為<span className="text-slate-300">資料分析結果</span>，不構成任何投資建議或買賣推薦。
              </p>
              <p className="text-[13px] text-slate-500 leading-[1.9] mt-2">
                投資人應自行評估風險，並詳閱各商品公開說明書後謹慎決策。過去績效不代表未來表現。本平台不對任何投資損益負責。
              </p>
            </div>

            <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-6">
              <div className="text-[14px] font-bold text-white mb-4">🔒 隱私權政策</div>
              <p className="text-[13px] text-slate-500 leading-[1.9]">
                目前版本之客戶資料與分析結果儲存於使用者<span className="text-slate-300">本機瀏覽器（localStorage）</span>，不會上傳至外部伺服器，亦不會與第三方共享。
              </p>
              <p className="text-[13px] text-slate-500 leading-[1.9] mt-2">
                正式版本將提供符合個人資料保護法規範之加密雲端儲存服務，並提供完整的資料刪除機制。
              </p>
            </div>

          </div>

        </div>
      </section>

      {/* FOOTER */}
      <footer className="relative z-10 bg-[#040a18]/80 backdrop-blur-xl border-t border-white/10 py-10">
        <div className="max-w-[1400px] mx-auto px-10">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
            <div>
              <div className="text-[24px] font-black text-white">Smart<span className="text-[#F5B700]">Match</span></div>
              <div className="text-[13px] text-slate-500 mt-1">瑞宇智庫｜投資資料分析平台</div>
            </div>
            <div className="flex flex-wrap gap-5 text-[13px] text-slate-500">
              <a href="/markets" className="hover:text-slate-300 transition-colors">市場中心</a>
              <a href="/etf" className="hover:text-slate-300 transition-colors">ETF資料庫</a>
              <a href="/funds" className="hover:text-slate-300 transition-colors">基金資料庫</a>
              <a href="/compare" className="hover:text-slate-300 transition-colors">比較中心</a>
              <a href="/quiz" className="hover:text-slate-300 transition-colors">人格分析</a>
              <a href="/clients" className="hover:text-slate-300 transition-colors">客戶管理</a>
              <a href="/pricing" className="hover:text-slate-300 transition-colors">方案說明</a>
              <a href="mailto:contact@smartmatch.tw" className="hover:text-slate-300 transition-colors">聯絡我們</a>
            </div>
            <div className="text-[12px] text-slate-600 text-right">
              <div>以上資料為示意範例，不構成投資建議</div>
              <div className="mt-1">© 2026 SmartMatch｜瑞宇智庫 版權所有</div>
            </div>
          </div>
        </div>
      </footer>

    </main>
  );
}

function PF({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-[13px] text-slate-300">
      <span className="text-green-400 mt-0.5 shrink-0">✓</span>{text}
    </div>
  );
}

function PFN({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-[13px] text-slate-600">
      <span className="mt-0.5 shrink-0">✗</span>{text}
    </div>
  );
}