"use client";
// ============================================================
// components/home/MarketOverviewSection.tsx
// 全球市場概況 Section（首頁 ZONE 5）
// 從 app/page.tsx 拆出，不修改任何 UI 或邏輯
// ============================================================

import { useState } from "react";
import Link from "next/link";

// ── 型別 ──────────────────────────────────────────────────────
type MktItem  = { name: string; value: string; pts: string; pct: string; up: boolean };
type MktGroup = { id: string; label: string; sublabel: string; emoji: string; main: MktItem[]; more: MktItem[] };

// ── 市場資料（靜態示意）──────────────────────────────────────
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

// ── Sparkline ─────────────────────────────────────────────────
function Sparkline({ up }: { up: boolean }) {
  const pts = up ? [38,35,37,32,29,33,27,23,19,16,13,10] : [10,14,12,18,15,20,24,19,27,25,31,36];
  const minV = Math.min(...pts), maxV = Math.max(...pts), range = maxV - minV || 1;
  const W = 90, H = 32;
  const coords = pts.map((v,i) => `${((i/(pts.length-1))*W).toFixed(1)},${(H-((v-minV)/range)*(H-6)-3).toFixed(1)}`).join(" ");
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

// ── Market Row ────────────────────────────────────────────────
function MktRow({ group }: { group: MktGroup }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-white/[0.08] rounded-2xl overflow-hidden mb-4"
      style={{ background:"rgba(15,22,42,0.85)", backdropFilter:"blur(20px)" }}>
      <div className="px-7 py-5">
        <div className="flex items-center gap-6">
          <div className="w-[140px] shrink-0 flex items-center gap-3">
            <span className="text-[26px]">{group.emoji}</span>
            <div>
              <div className="text-[17px] font-bold text-white leading-tight">{group.label}</div>
              <div className="text-[10px] tracking-[3px] text-white/35 mt-0.5">{group.sublabel}</div>
            </div>
          </div>
          <div className="w-px h-12 bg-white/[0.08] shrink-0" />
          <div className="flex flex-1 gap-0 min-w-0">
            {group.main.map((item, i) => (
              <div key={item.name} className="flex items-center gap-5 flex-1 min-w-0 px-5">
                {i > 0 && <div className="w-px h-10 bg-white/[0.06] shrink-0 -ml-5" />}
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-white/50 mb-1 truncate">{item.name}</div>
                  <div className="text-[26px] font-bold text-white leading-none mb-1">{item.value}</div>
                  <div className={`text-[15px] font-semibold ${item.up?"text-[#22C55E]":"text-[#EF4444]"}`}>
                    {item.up?"▲":"▼"} {item.pts} <span className="text-[13px]">{item.pct}</span>
                  </div>
                </div>
                <Sparkline up={item.up} />
              </div>
            ))}
          </div>
          <button onClick={() => setOpen(!open)}
            className="shrink-0 text-[14px] font-semibold text-[#F5B700] hover:text-[#e0a800] transition-colors whitespace-nowrap ml-4">
            {open ? "收起 ▲" : "更多 ▼"}
          </button>
        </div>
      </div>
      {open && (
        <div className="px-7 pb-5 border-t border-white/[0.06]">
          <div className="flex gap-0 pt-4">
            <div className="w-[140px] shrink-0" />
            <div className="w-px bg-white/[0.06] shrink-0 mx-6" />
            <div className="flex flex-1 gap-0 min-w-0">
              {group.more.map((item, i) => (
                <div key={item.name} className="flex items-center gap-4 flex-1 min-w-0 px-5">
                  {i > 0 && <div className="w-px h-10 bg-white/[0.06] shrink-0 -ml-5" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-white/40 mb-1 truncate">{item.name}</div>
                    <div className="text-[21px] font-bold text-white leading-none mb-1">{item.value}</div>
                    <div className={`text-[13px] font-semibold ${item.up?"text-[#22C55E]":"text-[#EF4444]"}`}>
                      {item.up?"▲":"▼"} {item.pts} <span className="text-[12px]">{item.pct}</span>
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

// ── Export ────────────────────────────────────────────────────
export function MarketOverviewSection() {
  return (
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
  );
}
