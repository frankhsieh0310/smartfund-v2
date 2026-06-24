"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ETF_LIST } from "../etf/data";
import { FUND_LIST } from "../funds/data";

// ── 列印樣式 ──────────────────────────────────────────────────────────
const PRINT_STYLE = `
@media print {
  @page { margin: 15mm; size: A4; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .no-print { display: none !important; }
  nav, footer { display: none !important; }
}
`;

// ── 人格 type ─────────────────────────────────────────────────────────
type PersonalityKey = "conservative" | "balanced" | "growth" | "aggressive";

function isPersonalityKey(v: string | null): v is PersonalityKey {
  return v === "conservative" || v === "balanced" || v === "growth" || v === "aggressive";
}

// ── 配置規則（規則引擎，寫死）────────────────────────────────────────
type Allocation = {
  title: string;
  riskLabel: string;
  summary: string;
  stock: number;
  bond: number;
  cash: number;
  colors: { stock: string; bond: string; cash: string };
};

const ALLOCATION_RULES: Record<PersonalityKey, Allocation> = {
  conservative: {
    title: "保守型",
    riskLabel: "風險承受度：中低",
    summary: "你重視資產的安全與穩定，對虧損的容忍度較低。配置以債券與現金為核心，少量股票資產提供基本成長動能。",
    stock: 15, bond: 60, cash: 25,
    colors: { stock: "#F5B700", bond: "#64748b", cash: "#334155" },
  },
  balanced: {
    title: "穩健型",
    riskLabel: "風險承受度：中等",
    summary: "你希望在風險與報酬之間取得平衡，能接受一定程度的波動。股票與債券均衡配置，兼顧成長與穩定。",
    stock: 50, bond: 30, cash: 20,
    colors: { stock: "#F5B700", bond: "#64748b", cash: "#334155" },
  },
  growth: {
    title: "成長型",
    riskLabel: "風險承受度：中高",
    summary: "你願意承擔較高波動以追求資產成長，投資期間較長。以股票資產為主力，債券配置提供緩衝。",
    stock: 70, bond: 22, cash: 8,
    colors: { stock: "#F5B700", bond: "#64748b", cash: "#334155" },
  },
  aggressive: {
    title: "積極型",
    riskLabel: "風險承受度：高",
    summary: "你能承受高度波動，追求長期最大化報酬。以高成長股票資產為核心，少量債券提供基本穩定性。",
    stock: 85, bond: 10, cash: 5,
    colors: { stock: "#F5B700", bond: "#64748b", cash: "#334155" },
  },
};

// ── 商品篩選引擎 ──────────────────────────────────────────────────────
type EtfGroup  = { label: string; items: typeof ETF_LIST };
type FundGroup = { label: string; items: typeof FUND_LIST };

function getEtfGroups(key: PersonalityKey): EtfGroup[] {
  const rule = ALLOCATION_RULES[key];
  const TOP = 4; // 每組最多顯示筆數
  const byReturn = (a: typeof ETF_LIST[0], b: typeof ETF_LIST[0]) => b.return1y - a.return1y;

  if (key === "conservative") {
    return [
      {
        label: "債券 ETF",
        items: ETF_LIST.filter(e => e.sector === "債券").sort(byReturn).slice(0, TOP),
      },
      {
        label: "高股息 ETF（收益來源）",
        items: ETF_LIST.filter(e => e.sector === "高股息" && e.region === "台灣").sort(byReturn).slice(0, TOP),
      },
    ];
  }
  if (key === "balanced") {
    return [
      {
        label: "市值型 ETF（股票部位）",
        items: ETF_LIST.filter(e => e.sector === "市值型").sort(byReturn).slice(0, TOP),
      },
      {
        label: "高股息 ETF（收益部位）",
        items: ETF_LIST.filter(e => e.sector === "高股息").sort(byReturn).slice(0, TOP),
      },
      {
        label: "債券 ETF（穩定部位）",
        items: ETF_LIST.filter(e => e.sector === "債券").sort(byReturn).slice(0, TOP),
      },
    ];
  }
  if (key === "growth") {
    return [
      {
        label: "市值型 ETF（核心部位）",
        items: ETF_LIST.filter(e => e.sector === "市值型").sort(byReturn).slice(0, TOP),
      },
      {
        label: "科技產業 ETF（成長部位）",
        items: ETF_LIST.filter(e => e.sector === "科技" || e.sector === "半導體").sort(byReturn).slice(0, TOP),
      },
      {
        label: "債券 ETF（緩衝部位）",
        items: ETF_LIST.filter(e => e.sector === "債券").sort(byReturn).slice(0, 3),
      },
    ];
  }
  // aggressive
  return [
    {
      label: "科技 / 半導體 ETF（核心部位）",
      items: ETF_LIST.filter(e => e.sector === "科技" || e.sector === "半導體" || e.sector === "創新科技").sort(byReturn).slice(0, TOP),
    },
    {
      label: "市值型 ETF（分散部位）",
      items: ETF_LIST.filter(e => e.sector === "市值型" && e.region === "美國").sort(byReturn).slice(0, TOP),
    },
    {
      label: "主動式 / 成長型 ETF",
      items: ETF_LIST.filter(e => e.sector === "主動式" || e.sector === "成長型").sort(byReturn).slice(0, 3),
    },
  ];
}

function getFundGroups(key: PersonalityKey): FundGroup[] {
  const TOP = 4;
  const byReturn = (a: typeof FUND_LIST[0], b: typeof FUND_LIST[0]) => b.return1y - a.return1y;

  if (key === "conservative") {
    return [
      {
        label: "債券型基金（核心部位）",
        items: FUND_LIST.filter(f => f.category === "債券型").sort(byReturn).slice(0, TOP),
      },
      {
        label: "貨幣型基金（現金部位）",
        items: FUND_LIST.filter(f => f.category === "貨幣型").sort(byReturn).slice(0, TOP),
      },
    ];
  }
  if (key === "balanced") {
    return [
      {
        label: "平衡型基金（股債兼顧）",
        items: FUND_LIST.filter(f => f.category === "平衡型").sort(byReturn).slice(0, TOP),
      },
      {
        label: "債券型基金（穩定部位）",
        items: FUND_LIST.filter(f => f.category === "債券型" && f.dividendYieldA > 4).sort(byReturn).slice(0, TOP),
      },
      {
        label: "全球股票型基金（成長部位）",
        items: FUND_LIST.filter(f => f.category === "股票型" && f.region === "全球").sort(byReturn).slice(0, TOP),
      },
    ];
  }
  if (key === "growth") {
    return [
      {
        label: "股票型基金（核心部位）",
        items: FUND_LIST.filter(f => f.category === "股票型" && (f.region === "全球" || f.region === "美國")).sort(byReturn).slice(0, TOP),
      },
      {
        label: "科技主題基金（成長部位）",
        items: FUND_LIST.filter(f => f.category === "股票型" && f.name.includes("科技")).sort(byReturn).slice(0, TOP),
      },
      {
        label: "平衡型基金（緩衝部位）",
        items: FUND_LIST.filter(f => f.category === "平衡型").sort(byReturn).slice(0, 3),
      },
    ];
  }
  // aggressive
  return [
    {
      label: "高成長股票型基金（核心部位）",
      items: FUND_LIST.filter(f => f.category === "股票型" && f.volatility > 18).sort(byReturn).slice(0, TOP),
    },
    {
      label: "科技 / AI 主題基金",
      items: FUND_LIST.filter(f => f.name.includes("科技") || f.name.includes("AI") || f.name.includes("人工智能")).sort(byReturn).slice(0, TOP),
    },
    {
      label: "新興市場股票型基金",
      items: FUND_LIST.filter(f => f.category === "股票型" && (f.region === "新興市場" || f.region === "印度")).sort(byReturn).slice(0, 3),
    },
  ];
}

// ── 晨星星星（只顯示金色）────────────────────────────────────────────
function Stars({ n }: { n: number }) {
  return <span className="text-[#F5B700] text-[13px]">{"★".repeat(n)}</span>;
}

// ── Pct ──────────────────────────────────────────────────────────────
function Pct({ v }: { v: number }) {
  return (
    <span className={v >= 0 ? "text-emerald-400 font-semibold" : "text-red-400 font-semibold"}>
      {v >= 0 ? "+" : ""}{v.toFixed(1)}%
    </span>
  );
}

// ── Report Content ────────────────────────────────────────────────────
function ReportContent() {
  const searchParams = useSearchParams();
  const typeParam   = searchParams.get("type");
  const clientName  = searchParams.get("client") || "";
  const scoreParam  = searchParams.get("score") || "";

  const type: PersonalityKey = isPersonalityKey(typeParam) ? typeParam : "balanced";
  const rule     = ALLOCATION_RULES[type];
  const etfGroups  = getEtfGroups(type);
  const fundGroups = getFundGroups(type);

  useEffect(() => {
    const style = document.createElement("style");
    style.innerHTML = PRINT_STYLE;
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); };
  }, []);

  const alloc = [
    { label: "股票資產", value: rule.stock,  color: rule.colors.stock },
    { label: "債券資產", value: rule.bond,   color: rule.colors.bond  },
    { label: "現金部位", value: rule.cash,   color: rule.colors.cash  },
  ];

  return (
    <main className="min-h-screen px-6 pt-28 pb-20">

      {/* NAVBAR */}
      <header className="fixed top-0 left-0 w-full z-50 bg-[#040a18]/85 backdrop-blur-xl border-b border-white/[0.08] no-print">
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
          <div className="flex items-center gap-3">
            <button onClick={() => window.print()}
              className="flex items-center gap-2 bg-white/[0.08] hover:bg-white/[0.15] text-white px-5 py-2 rounded-lg font-semibold text-[14px] transition-colors">
              ⬇ 匯出 PDF
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-[860px] mx-auto">

        {/* 列印標頭 */}
        <div className="hidden print:block mb-8 pb-4 border-b border-white/10">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[18px] font-black text-white">SmartMatch</div>
              <div className="text-[11px] text-slate-400">ETF & 基金資產配置分析平台</div>
            </div>
            <div className="text-right text-[11px] text-slate-400">
              <div>投資人格分析報告</div>
              <div>{new Date().toLocaleDateString("zh-TW")}</div>
              {clientName && <div className="font-semibold text-white mt-1">客戶：{clientName}</div>}
            </div>
          </div>
        </div>

        {/* 報告標頭 */}
        <div className="text-center mb-12">
          <div className="tracking-[10px] text-[#F5B700] text-[13px] font-semibold mb-5">SMARTMATCH 分析報告</div>
          {clientName && <div className="text-[14px] text-slate-400 mb-2">客戶：{clientName}</div>}
          {scoreParam  && <div className="text-[13px] text-slate-500 mb-2">總分 {scoreParam} 分</div>}
          <div className="text-[16px] text-slate-400 mb-3">投資人格分析結果</div>
          <h1 className="text-[60px] font-black text-white leading-tight">{rule.title}</h1>
          <div className="text-[14px] text-slate-500 mt-2">{rule.riskLabel}</div>
        </div>

        <p className="text-[17px] leading-[1.9] text-slate-400 text-center mb-14">{rule.summary}</p>

        {/* ── 第一階段：配置分析 ────────────────────────────────── */}
        <section className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-8 mb-10">
          <div className="text-[11px] tracking-[6px] text-[#F5B700] font-semibold mb-5">PHASE 1 · 配置分析</div>
          <h2 className="text-[22px] font-bold text-white mb-6">資產配置分析</h2>

          {/* 長條圖 */}
          <div className="flex h-5 rounded-full overflow-hidden mb-6">
            {alloc.map(a => (
              <div key={a.label} style={{ width: `${a.value}%`, backgroundColor: a.color }} />
            ))}
          </div>

          {/* 數值 */}
          <div className="grid grid-cols-3 gap-5 mb-6">
            {alloc.map(a => (
              <div key={a.label} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: a.color }} />
                  <span className="text-[13px] text-slate-400">{a.label}</span>
                </div>
                <div className="text-[36px] font-black text-white">{a.value}%</div>
              </div>
            ))}
          </div>

          <p className="text-[12px] text-slate-600 leading-relaxed">
            以上為依據投資人格分析結果產生之資產配置參考比例。實際配置應依個人財務狀況、投資期間與市場情況調整。
          </p>
        </section>

        {/* ── 第二階段：ETF 篩選結果 ───────────────────────────── */}
        <section className="mb-10">
          <div className="text-[11px] tracking-[6px] text-[#F5B700] font-semibold mb-5">PHASE 2 · ETF 篩選結果</div>
          <h2 className="text-[22px] font-bold text-white mb-2">ETF 篩選結果</h2>
          <p className="text-[13px] text-slate-500 mb-6">
            以下為依據本次配置分析條件，從 ETF 資料庫篩選出的商品，依近一年績效排序。
          </p>

          {etfGroups.map(group => (
            <div key={group.label} className="mb-6">
              <div className="text-[13px] font-semibold text-slate-300 mb-3 flex items-center gap-2">
                <span className="w-1 h-4 bg-[#F5B700] rounded-full inline-block" />
                {group.label}
              </div>
              <div className="border border-white/[0.08] rounded-xl overflow-hidden">
                <table className="w-full text-left">
                  <thead>
                    <tr className="bg-white/[0.04] text-slate-500 text-[11px]">
                      <th className="px-4 py-2.5 font-semibold w-[80px]">代碼</th>
                      <th className="px-4 py-2.5 font-semibold">商品名稱</th>
                      <th className="px-4 py-2.5 font-semibold text-right">殖利率</th>
                      <th className="px-4 py-2.5 font-semibold text-right">近1年</th>
                      <th className="px-4 py-2.5 font-semibold text-right">波動度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((etf, i) => (
                      <tr key={etf.code}
                        className={`text-[13px] border-t border-white/[0.05] ${i % 2 === 1 ? "bg-white/[0.02]" : ""}`}>
                        <td className="px-4 py-2.5 font-bold text-[#F5B700]">{etf.code}</td>
                        <td className="px-4 py-2.5 text-slate-300 max-w-[240px] truncate">{etf.name}</td>
                        <td className="px-4 py-2.5 text-right text-slate-400">
                          {etf.dividendYield > 0 ? `${etf.dividendYield.toFixed(1)}%` : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right"><Pct v={etf.return1y} /></td>
                        <td className="px-4 py-2.5 text-right text-slate-400">{etf.volatility.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <p className="text-[11px] text-slate-600 mt-2">
            以上為 SmartMatch ETF 資料庫篩選結果，非投資建議。數值為示意資料。
          </p>
        </section>

        {/* ── 第二階段：基金篩選結果 ───────────────────────────── */}
        <section className="mb-12">
          <div className="text-[11px] tracking-[6px] text-[#F5B700] font-semibold mb-5">PHASE 2 · 基金篩選結果</div>
          <h2 className="text-[22px] font-bold text-white mb-2">基金篩選結果</h2>
          <p className="text-[13px] text-slate-500 mb-6">
            以下為依據本次配置分析條件，從基金資料庫篩選出的商品，依近一年績效排序。
          </p>

          {fundGroups.map(group => (
            <div key={group.label} className="mb-6">
              <div className="text-[13px] font-semibold text-slate-300 mb-3 flex items-center gap-2">
                <span className="w-1 h-4 bg-[#F5B700] rounded-full inline-block" />
                {group.label}
              </div>
              <div className="border border-white/[0.08] rounded-xl overflow-hidden">
                <table className="w-full text-left">
                  <thead>
                    <tr className="bg-white/[0.04] text-slate-500 text-[11px]">
                      <th className="px-4 py-2.5 font-semibold w-[64px]">公司</th>
                      <th className="px-4 py-2.5 font-semibold">基金名稱</th>
                      <th className="px-4 py-2.5 font-semibold text-center">晨星</th>
                      <th className="px-4 py-2.5 font-semibold text-right">年化配息</th>
                      <th className="px-4 py-2.5 font-semibold text-right">近1年</th>
                      <th className="px-4 py-2.5 font-semibold text-right">波動度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((fund, i) => (
                      <tr key={fund.id}
                        className={`text-[13px] border-t border-white/[0.05] ${i % 2 === 1 ? "bg-white/[0.02]" : ""}`}>
                        <td className="px-4 py-2.5 font-bold text-white text-[12px]">{fund.company}</td>
                        <td className="px-4 py-2.5 text-slate-300 max-w-[220px] truncate">{fund.name}</td>
                        <td className="px-4 py-2.5 text-center"><Stars n={fund.morningstar} /></td>
                        <td className="px-4 py-2.5 text-right text-[#F5B700] font-semibold">
                          {fund.dividendYieldA > 0 ? `${fund.dividendYieldA.toFixed(1)}%` : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right"><Pct v={fund.return1y} /></td>
                        <td className="px-4 py-2.5 text-right text-slate-400">{fund.volatility.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <p className="text-[11px] text-slate-600 mt-2">
            以上為 SmartMatch 基金資料庫篩選結果，非投資建議。數值為示意資料。
          </p>
        </section>

        {/* 免責聲明 */}
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-6 mb-10">
          <div className="text-[12px] font-bold text-slate-400 mb-2">免責聲明</div>
          <p className="text-[12px] text-slate-600 leading-[1.9]">
            本平台提供之資料、分析結果、篩選結果與研究工具，僅供資訊參考與研究用途，
            不構成任何投資建議、招攬或保證獲利。投資人應自行評估風險，並詳閱各商品公開說明書後謹慎決策。
            過去績效不代表未來表現。本平台不對任何投資損益負責。
          </p>
        </div>

        {/* 操作按鈕 */}
        <div className="flex gap-4 justify-center no-print">
          <button onClick={() => window.print()}
            className="bg-white/[0.08] hover:bg-white/[0.15] text-white px-8 py-3.5 rounded-lg font-semibold text-[15px] transition-colors">
            ⬇ 匯出 PDF
          </button>
          <Link href="/quiz"
            className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-8 py-3.5 rounded-lg font-bold text-[15px] transition-colors">
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
    </main>
  );
}

export default function ReportPage() {
  return (
    <Suspense fallback={null}>
      <ReportContent />
    </Suspense>
  );
}