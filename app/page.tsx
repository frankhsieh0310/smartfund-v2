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

// ── 全球市場概況資料（依設計指令規格）─────────────────────────────
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

// ── Sparkline（SVG，無外部套件，寬120px 高40px）────────────────────
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

// ── 單一指數欄位 ─────────────────────────────────────────────────────
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

// ── 市場列（橫向大卡，Glassmorphism）────────────────────────────────
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
      {/* 主列 */}
      <div className="flex items-center gap-8">
        {/* 市場標籤 */}
        <div className="w-[150px] shrink-0 flex items-center gap-3">
          <span className="text-[32px]">{group.emoji}</span>
          <div>
            <div className="text-[20px] font-bold text-white leading-tight">{group.label}</div>
            <div className="text-[10px] tracking-[3px] text-white/40 mt-0.5">{group.sublabel}</div>
          </div>
        </div>

        <div className="w-px h-14 bg-white/[0.08] shrink-0" />

        {/* 3 指數 */}
        <div className="flex flex-1 gap-4 min-w-0">
          {group.main.map((item, i) => (
            <div key={item.name} className="flex items-center gap-4 flex-1 min-w-0">
              <MktCol item={item} />
              {i < group.main.length - 1 && (
                <div className="w-px h-12 bg-white/[0.06] shrink-0" />
              )}
            </div>
          ))}
        </div>

        {/* 查看更多 */}
        <button
          onClick={() => setOpen(!open)}
          className="shrink-0 text-[13px] font-semibold text-[#F5B700] hover:text-[#e0a800] transition-colors whitespace-nowrap ml-4"
        >
          {open ? "收起 ↑" : "查看更多 →"}
        </button>
      </div>

      {/* 展開行 */}
      {open && (
        <div className="flex items-center gap-8 mt-5 pt-5 border-t border-white/[0.06]">
          <div className="w-[150px] shrink-0" />
          <div className="w-px h-12 bg-white/[0.06] shrink-0" />
          <div className="flex flex-1 gap-4 min-w-0">
            {group.more.map((item, i) => (
              <div key={item.name} className="flex items-center gap-4 flex-1 min-w-0">
                <MktCol item={item} />
                {i < group.more.length - 1 && (
                  <div className="w-px h-12 bg-white/[0.06] shrink-0" />
                )}
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
    <main className="min-h-screen relative" style={{
        backgroundImage: "url('https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=2600')",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundAttachment: "fixed",
      }}>
      {/* 全站遮罩：深藍漸層，讓大樓可見度 15~25% */}
      <div className="fixed inset-0 z-0 pointer-events-none" style={{
        backgroundColor: "rgba(4,10,24,0.45)",
        backgroundImage: "linear-gradient(180deg, rgba(4,10,24,0.20) 0%, rgba(4,10,24,0.40) 50%, rgba(4,10,24,0.55) 100%)",
      }} />

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
        {/* 左側深藍漸層，讓文字清晰可讀 */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#040a18]/90 via-[#040a18]/60 to-transparent z-[1]" />
        {/* 金色光暈 */}
        <div className="absolute top-40 left-20 w-[500px] h-[500px] rounded-full bg-[#F5B700] opacity-[0.07] blur-[140px] z-[1]" />

        <div className="relative z-10 max-w-[1700px] mx-auto px-10 flex items-center min-h-screen pt-20">
          <div className="grid lg:grid-cols-[50%_50%] w-full items-center gap-8 py-20">

            <div className="space-y-8">
              <div className="tracking-[14px] text-[#F5B700] text-[18px] font-semibold">SMARTMATCH</div>
              <div className="inline-block py-6 px-10 rounded-[32px] backdrop-blur-md bg-white/[0.06] border border-white/10">
                <h1 className="text-[72px] font-black leading-[1.1] text-white tracking-[0.01em]">
                  從投資人格<br />到資產配置
                </h1>
              </div>
              <div className="space-y-1">
                <p className="text-[28px] font-semibold text-white/90">投資人格分析</p>
                <p className="text-[28px] font-semibold text-white/90">商品比較分析</p>
                <p className="text-[28px] font-semibold text-white/90">資產配置規劃</p>
                <p className="text-[28px] font-bold text-[#F5B700] mt-2">一站完成。</p>
              </div>
              <div className="flex gap-5">
                <Link href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-black px-12 py-5 rounded-lg font-bold text-[22px] transition-colors">開始投資人格分析</Link>
                <Link href="/etf" className="bg-white/10 backdrop-blur-md border border-white/10 text-white px-12 py-5 rounded-lg hover:bg-white/20 transition-colors font-semibold text-[22px]">瀏覽資料庫</Link>
              </div>
              <div className="grid grid-cols-4 gap-3">
                {[
                  { icon: "🧠", title: "20題人格分析", href: "/quiz" },
                  { icon: "⚖️", title: "商品比較中心", href: "/compare" },
                  { icon: "📊", title: "資產配置分析", href: "/report" },
                  { icon: "👥", title: "客戶管理中心", href: "/clients" },
                ].map((item) => (
                  <Link key={item.title} href={item.href} className="bg-white/[0.06] border border-white/10 rounded-2xl p-4 text-center hover:bg-white/[0.12] hover:border-[#F5B700]/40 transition-all group">
                    <div className="text-[24px] mb-2">{item.icon}</div>
                    <div className="text-[13px] font-semibold text-white/80 group-hover:text-white leading-tight">{item.title}</div>
                  </Link>
                ))}
              </div>
              <p className="text-[15px] text-white/45">適合理財顧問、ETF投資人、基金投資人與自主投資者</p>
              <div className="flex items-center gap-4">
                <Link href="/pricing" className="flex items-center gap-2 text-[15px] text-[#F5B700] border border-[#F5B700]/40 px-5 py-2.5 rounded-lg hover:bg-[#F5B700]/10 transition-colors font-semibold">查看收費方案 →</Link>
                <span className="text-[14px] text-white/30">免費版不需要信用卡</span>
              </div>
            </div>

            {/* RIGHT — Dashboard 卡片 */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-[#0B1220]/70 backdrop-blur-xl border border-white/10 rounded-[32px] p-8 text-white shadow-[0_40px_120px_rgba(0,0,0,0.45)]">
                <div className="flex justify-between items-center mb-6">
                  <div className="font-bold text-[22px]">市場概覽</div>
                  <div className="text-[13px] text-slate-400">即時更新 15:30</div>
                </div>
                <div className="space-y-5 text-[17px]">
                  {[["S&P 500","+0.68%",true],["NASDAQ","+0.85%",true],["DOW JONES","+0.53%",true],["MSCI ACWI","+0.62%",true],["VIX","-1.19%",false]].map(([name,val,up])=>(
                    <div key={name as string} className="flex justify-between">
                      <span className="text-slate-300">{name as string}</span>
                      <span className={up ? "text-green-400 font-semibold" : "text-red-400 font-semibold"}>{val as string}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-[#0B1220]/70 backdrop-blur-xl border border-white/10 rounded-[32px] p-8 text-white shadow-[0_40px_120px_rgba(0,0,0,0.45)]">
                <div className="font-bold text-[22px] mb-6">資產配置分析</div>
                <div className="flex items-center justify-center mb-5">
                  <svg viewBox="0 0 120 120" className="w-28 h-28">
                    <circle cx="60" cy="60" r="44" fill="none" stroke="#1e2a3a" strokeWidth="20" />
                    <circle cx="60" cy="60" r="44" fill="none" stroke="#F5B700" strokeWidth="20" strokeDasharray="179 277" strokeDashoffset="69" />
                    <circle cx="60" cy="60" r="44" fill="none" stroke="#94a3b8" strokeWidth="20" strokeDasharray="55 401" strokeDashoffset="-110" />
                    <circle cx="60" cy="60" r="44" fill="none" stroke="#334155" strokeWidth="20" strokeDasharray="41 415" strokeDashoffset="-165" />
                  </svg>
                </div>
                <div className="space-y-2.5 text-[15px]">
                  {[["#F5B700","股票","65%"],["#94a3b8","債券","20%"],["#334155","現金","15%"]].map(([c,l,p])=>(
                    <div key={l} className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5"><span className="w-3 h-3 rounded-full" style={{backgroundColor:c}}/><span className="text-slate-300">{l}</span></div>
                      <span className="font-bold">{p}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-[#0B1220]/70 backdrop-blur-xl border border-white/10 rounded-[32px] p-8 text-white shadow-[0_40px_120px_rgba(0,0,0,0.45)]">
                <div className="font-bold text-[22px] mb-1">投資組合績效</div>
                <div className="text-[13px] text-slate-400 mb-5">年化報酬率</div>
                <div className="text-[56px] font-black text-[#F5B700] leading-none mb-5">8.47%</div>
                <svg viewBox="0 0 200 60" className="w-full h-12">
                  <defs><linearGradient id="perfGlow" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#F5B700" stopOpacity="0.35"/><stop offset="100%" stopColor="#F5B700" stopOpacity="0"/></linearGradient></defs>
                  <polygon points="0,60 0,50 25,42 50,46 75,35 100,38 125,28 150,32 175,18 200,12 200,60" fill="url(#perfGlow)"/>
                  <polyline points="0,50 25,42 50,46 75,35 100,38 125,28 150,32 175,18 200,12" fill="none" stroke="#F5B700" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>

              <div className="bg-[#0B1220]/70 backdrop-blur-xl border border-white/10 rounded-[32px] p-8 text-white shadow-[0_40px_120px_rgba(0,0,0,0.45)]">
                <div className="font-bold text-[22px] mb-6">ETF 熱門排行</div>
                <div className="space-y-4 text-[15px]">
                  {[["VG","VOO","+0.63%","#e67e22"],["IN","QQQ","+0.85%","#2980b9"],["VG","VTI","+0.59%","#e67e22"],["VG","VXUS","+0.31%","#e67e22"],["VG","BND","+0.21%","#27ae60"]].map(([abbr,code,val,color])=>(
                    <div key={code as string} className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white" style={{backgroundColor:color as string}}>{abbr}</span>
                        <span className="font-semibold">{code as string}</span>
                      </div>
                      <span className="text-green-400 font-semibold">{val as string}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          全球市場概況（Bloomberg 風格）
      ══════════════════════════════════════════════════════════════ */}
      <section className="relative z-10 py-16 border-t border-white/[0.06]">
        <div className="max-w-[1600px] mx-auto px-10">

          <div className="flex items-start justify-between mb-6">
            <div>
              <div className="text-[13px] tracking-[10px] text-[#F5B700] font-semibold mb-2">GLOBAL MARKETS</div>
              <h2 className="text-[40px] font-black text-white leading-tight">全球市場概覽</h2>
              <p className="text-[15px] text-white/40 mt-1">掌握全球主要市場動態</p>
            </div>
            <div className="flex items-center gap-4 mt-2">
              <span className="text-[12px] text-white/30">⊙ 即時更新 15:30</span>
              <a href="/markets" className="text-[13px] font-semibold text-[#F5B700] border border-[#F5B700]/40 px-4 py-2 rounded-lg hover:bg-[#F5B700]/10 transition-colors">
                完整市場數據 →
              </a>
            </div>
          </div>

          <MarketDashboard />

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
              { icon: "⚖️", title: "ETF＋基金比較中心", desc: "台灣唯一可同時比較ETF與基金的分析工具", href: "/compare" },
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
            <h2 className="text-[56px] font-black text-white">投資流程</h2>
          </div>
          <div className="grid grid-cols-4 gap-6">
            {[
              { step: "STEP 1", title: "投資人格分析", desc: "了解風險偏好與投資屬性", icon: "🧠" },
              { step: "STEP 2", title: "ETF / 基金篩選", desc: "依條件快速比較標的", icon: "🔍" },
              { step: "STEP 3", title: "資產配置分析", desc: "生成專屬投資組合", icon: "📈" },
              { step: "STEP 4", title: "產生投資報告", desc: "可執行的長期策略", icon: "📄" },
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

      {/* ══════════════════════════════════════════════════════════════
          熱門申購排行榜
      ══════════════════════════════════════════════════════════════ */}
      <section className="relative z-10 py-24 border-t border-white/[0.06]">
        <div className="max-w-[1400px] mx-auto px-10">

          <div className="text-center mb-14">
            <div className="text-[16px] tracking-[10px] text-[#F5B700] font-semibold mb-3">HOT PICKS</div>
            <h2 className="text-[48px] font-black text-white">熱門申購排行榜</h2>
            <p className="text-[16px] text-slate-400 mt-3">近一週資金淨流入排行，掌握市場資金動向</p>
          </div>

          <div className="grid grid-cols-2 gap-8">

            {/* ETF TOP 10 */}
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
                        <td className="px-4 py-2.5">
                          <span className={`text-[13px] font-bold ${e.rank <= 3 ? "text-[#F5B700]" : "text-slate-600"}`}>{e.rank}</span>
                        </td>
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

            {/* 基金 TOP 10 */}
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
                        <td className="px-4 py-2.5">
                          <span className={`text-[13px] font-bold ${f.rank <= 3 ? "text-[#F5B700]" : "text-slate-600"}`}>{f.rank}</span>
                        </td>
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
            以上排行為示意範例，非即時申購數據，僅供功能展示。實際申購排行請參考各基金公司或投信公會公開資料。
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
          公司介紹 About SmartMatch
      ══════════════════════════════════════════════════════════════ */}
      <section className="relative z-10 py-24 border-t border-white/[0.06]">
        <div className="max-w-[1400px] mx-auto px-10">
          <div className="grid lg:grid-cols-[1fr_1fr] gap-16 items-start">

            <div>
              <div className="text-[16px] tracking-[10px] text-[#F5B700] font-semibold mb-6">ABOUT</div>
              <h2 className="text-[44px] font-black text-white leading-tight mb-6">
                關於 SmartMatch
              </h2>
              <p className="text-[17px] text-slate-400 leading-[1.9] mb-6">
                SmartMatch 為<span className="text-white font-semibold">瑞宇智庫</span>旗下投資研究平台，專注於資產配置、基金研究、ETF 分析與投資決策工具開發，協助投資人建立更有系統的投資流程。
              </p>
              <p className="text-[17px] text-slate-400 leading-[1.9] mb-8">
                我們相信，每一位投資人都應該擁有屬於自己的投資藍圖。透過科學化的人格分析與完整的商品資料庫，SmartMatch 讓資產配置不再是金融機構的專利。
              </p>
              <div className="grid grid-cols-3 gap-4">
                {[
                  { num: "364+", label: "ETF & 基金商品" },
                  { num: "20題", label: "人格測驗題庫" },
                  { num: "5種", label: "訂閱方案" },
                ].map((s) => (
                  <div key={s.label} className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-4 text-center">
                    <div className="text-[28px] font-black text-[#F5B700]">{s.num}</div>
                    <div className="text-[13px] text-slate-400 mt-1">{s.label}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-6">
                <div className="text-[15px] font-bold text-white mb-3">🏢 公司資訊</div>
                <div className="space-y-2 text-[14px] text-slate-400">
                  <div className="flex gap-3"><span className="text-slate-500 w-20 shrink-0">平台名稱</span><span className="text-white">SmartMatch</span></div>
                  <div className="flex gap-3"><span className="text-slate-500 w-20 shrink-0">母公司</span><span className="text-white">瑞宇智庫</span></div>
                  <div className="flex gap-3"><span className="text-slate-500 w-20 shrink-0">定位</span><span className="text-white">財富管理分析平台</span></div>
                  <div className="flex gap-3"><span className="text-slate-500 w-20 shrink-0">聯絡信箱</span><span className="text-[#F5B700]">contact@smartmatch.tw</span></div>
                </div>
              </div>

              <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-6">
                <div className="text-[15px] font-bold text-white mb-3">⚖️ 法律聲明</div>
                <p className="text-[13px] text-slate-500 leading-[1.8]">
                  本平台所有內容（包含投資人格分析結果、ETF 及基金資料、資產配置建議）均為資料分析結果，<span className="text-slate-400">不構成任何投資建議或買賣推薦。</span>投資人應自行評估風險，並詳閱各商品公開說明書後謹慎決策。過去績效不代表未來表現。
                </p>
              </div>

              <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-6">
                <div className="text-[15px] font-bold text-white mb-3">🔒 隱私權政策</div>
                <p className="text-[13px] text-slate-500 leading-[1.8]">
                  目前版本之客戶資料與分析結果儲存於使用者本機瀏覽器（localStorage），不會上傳至外部伺服器。正式版本將提供符合個資法規範之加密雲端儲存服務。
                </p>
              </div>
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
              <div className="text-[13px] text-slate-500 mt-1">瑞宇智庫 ETF & 基金資產配置分析平台</div>
            </div>
            <div className="flex gap-6 text-[13px] text-slate-500">
              <a href="/pricing" className="hover:text-slate-300 transition-colors">方案說明</a>
              <a href="/quiz" className="hover:text-slate-300 transition-colors">人格分析</a>
              <a href="/etf" className="hover:text-slate-300 transition-colors">ETF資料庫</a>
              <a href="/funds" className="hover:text-slate-300 transition-colors">基金資料庫</a>
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