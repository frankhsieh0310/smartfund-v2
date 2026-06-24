"use client";

import { Suspense, useEffect, useRef } from "react";
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
type Allocation = {
  title: string;
  riskLabel: string;
  summary: string;
  stock: number;
  bond: number;
  cash: number;
};

const ALLOCATION_RULES: Record<PersonalityKey, Allocation> = {
  conservative: {
    title: "保守型", riskLabel: "風險承受度：中低",
    summary: "你重視資產的安全與穩定，對虧損的容忍度較低。配置以債券與現金為核心，少量股票資產提供基本成長動能。",
    stock: 15, bond: 60, cash: 25,
  },
  balanced: {
    title: "穩健型", riskLabel: "風險承受度：中等",
    summary: "你希望在風險與報酬之間取得平衡，能接受一定程度的波動。股票與債券均衡配置，兼顧成長與穩定。",
    stock: 50, bond: 30, cash: 20,
  },
  growth: {
    title: "成長型", riskLabel: "風險承受度：中高",
    summary: "你願意承擔較高波動以追求資產成長，投資期間較長。以股票資產為主力，債券配置提供緩衝。",
    stock: 70, bond: 22, cash: 8,
  },
  aggressive: {
    title: "積極型", riskLabel: "風險承受度：高",
    summary: "你能承受高度波動，追求長期最大化報酬。以高成長股票資產為核心，少量債券提供基本穩定性。",
    stock: 85, bond: 10, cash: 5,
  },
};

// ── 商品篩選引擎 ──────────────────────────────────────────────────────
type EtfGroup  = { label: string; items: typeof ETF_LIST };
type FundGroup = { label: string; items: typeof FUND_LIST };

function getEtfGroups(key: PersonalityKey): EtfGroup[] {
  const TOP = 4;
  const byReturn = (a: typeof ETF_LIST[0], b: typeof ETF_LIST[0]) => b.return1y - a.return1y;
  if (key === "conservative") return [
    { label: "債券 ETF", items: ETF_LIST.filter(e => e.sector === "債券").sort(byReturn).slice(0, TOP) },
    { label: "高股息 ETF（收益來源）", items: ETF_LIST.filter(e => e.sector === "高股息" && e.region === "台灣").sort(byReturn).slice(0, TOP) },
  ];
  if (key === "balanced") return [
    { label: "市值型 ETF（股票部位）", items: ETF_LIST.filter(e => e.sector === "市值型").sort(byReturn).slice(0, TOP) },
    { label: "高股息 ETF（收益部位）", items: ETF_LIST.filter(e => e.sector === "高股息").sort(byReturn).slice(0, TOP) },
    { label: "債券 ETF（穩定部位）", items: ETF_LIST.filter(e => e.sector === "債券").sort(byReturn).slice(0, TOP) },
  ];
  if (key === "growth") return [
    { label: "市值型 ETF（核心部位）", items: ETF_LIST.filter(e => e.sector === "市值型").sort(byReturn).slice(0, TOP) },
    { label: "科技產業 ETF（成長部位）", items: ETF_LIST.filter(e => e.sector === "科技" || e.sector === "半導體").sort(byReturn).slice(0, TOP) },
    { label: "債券 ETF（緩衝部位）", items: ETF_LIST.filter(e => e.sector === "債券").sort(byReturn).slice(0, 3) },
  ];
  return [
    { label: "科技 / 半導體 ETF（核心部位）", items: ETF_LIST.filter(e => e.sector === "科技" || e.sector === "半導體" || e.sector === "創新科技").sort(byReturn).slice(0, TOP) },
    { label: "市值型 ETF（分散部位）", items: ETF_LIST.filter(e => e.sector === "市值型" && e.region === "美國").sort(byReturn).slice(0, TOP) },
    { label: "主動式 / 成長型 ETF", items: ETF_LIST.filter(e => e.sector === "主動式" || e.sector === "成長型").sort(byReturn).slice(0, 3) },
  ];
}

function getFundGroups(key: PersonalityKey): FundGroup[] {
  const TOP = 4;
  const byReturn = (a: typeof FUND_LIST[0], b: typeof FUND_LIST[0]) => b.return1y - a.return1y;
  if (key === "conservative") return [
    { label: "債券型基金（核心部位）", items: FUND_LIST.filter(f => f.category === "債券型").sort(byReturn).slice(0, TOP) },
    { label: "貨幣型基金（現金部位）", items: FUND_LIST.filter(f => f.category === "貨幣型").sort(byReturn).slice(0, TOP) },
  ];
  if (key === "balanced") return [
    { label: "平衡型基金（股債兼顧）", items: FUND_LIST.filter(f => f.category === "平衡型").sort(byReturn).slice(0, TOP) },
    { label: "債券型基金（穩定部位）", items: FUND_LIST.filter(f => f.category === "債券型" && f.dividendYieldA > 4).sort(byReturn).slice(0, TOP) },
    { label: "全球股票型基金（成長部位）", items: FUND_LIST.filter(f => f.category === "股票型" && f.region === "全球").sort(byReturn).slice(0, TOP) },
  ];
  if (key === "growth") return [
    { label: "股票型基金（核心部位）", items: FUND_LIST.filter(f => f.category === "股票型" && (f.region === "全球" || f.region === "美國")).sort(byReturn).slice(0, TOP) },
    { label: "科技主題基金（成長部位）", items: FUND_LIST.filter(f => f.category === "股票型" && f.name.includes("科技")).sort(byReturn).slice(0, TOP) },
    { label: "平衡型基金（緩衝部位）", items: FUND_LIST.filter(f => f.category === "平衡型").sort(byReturn).slice(0, 3) },
  ];
  return [
    { label: "高成長股票型基金（核心部位）", items: FUND_LIST.filter(f => f.category === "股票型" && f.volatility > 18).sort(byReturn).slice(0, TOP) },
    { label: "科技 / AI 主題基金", items: FUND_LIST.filter(f => f.name.includes("科技") || f.name.includes("AI") || f.name.includes("人工智能")).sort(byReturn).slice(0, TOP) },
    { label: "新興市場股票型基金", items: FUND_LIST.filter(f => f.category === "股票型" && (f.region === "新興市場" || f.region === "印度")).sort(byReturn).slice(0, 3) },
  ];
}

// ── helpers ───────────────────────────────────────────────────────────
function Stars({ n }: { n: number }) {
  return <span className="text-[#F5B700] text-[13px]">{"★".repeat(n)}</span>;
}
function Pct({ v }: { v: number }) {
  return <span className={v >= 0 ? "text-emerald-400 font-semibold" : "text-red-400 font-semibold"}>{v >= 0 ? "+" : ""}{v.toFixed(1)}%</span>;
}

// ── PDF 產生（html2pdf.js via CDN）───────────────────────────────────
async function generatePdf(
  contentRef: React.RefObject<HTMLDivElement>,
  filename: string
) {
  // 動態載入 html2pdf
  if (typeof window === "undefined") return;
  // @ts-ignore
  if (!window.html2pdf) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
      script.onload = () => resolve();
      script.onerror = () => reject();
      document.head.appendChild(script);
    });
  }
  const el = contentRef.current;
  if (!el) return;

  // @ts-ignore
  await window.html2pdf()
    .set({
      margin:      [10, 10, 10, 10],
      filename,
      image:       { type: "jpeg", quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: "#020817" },
      jsPDF:       { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak:   { mode: ["avoid-all", "css"] },
    })
    .from(el)
    .save();
}

// ── Report Content ────────────────────────────────────────────────────
function ReportContent() {
  const searchParams = useSearchParams();
  const typeParam  = searchParams.get("type");
  const clientName = searchParams.get("client") || "";
  const scoreParam = searchParams.get("score")  || "";
  const type: PersonalityKey = isPersonalityKey(typeParam) ? typeParam : "balanced";
  const rule      = ALLOCATION_RULES[type];
  const etfGroups  = getEtfGroups(type);
  const fundGroups = getFundGroups(type);
  const today = new Date().toLocaleDateString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit" });
  const pdfRef = useRef<HTMLDivElement>(null);

  const alloc = [
    { label: "股票資產", value: rule.stock,  color: "#F5B700" },
    { label: "債券資產", value: rule.bond,   color: "#64748b" },
    { label: "現金部位", value: rule.cash,   color: "#334155" },
  ];

  function handleExportPdf() {
    const filename = clientName
      ? `SmartMatch_${clientName}_${type}_${today}.pdf`
      : `SmartMatch_${type}_${today}.pdf`;
    generatePdf(pdfRef, filename);
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

      {/* PDF 匯出區塊 */}
      <div ref={pdfRef}
        style={{ backgroundColor: "#020817", color: "#ffffff", fontFamily: "sans-serif", padding: "0" }}>

        {/* ── 封面 ─────────────────────────────────────────────────── */}
        <div style={{
          minHeight: "270mm", display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          backgroundColor: "#020817", padding: "40px",
          pageBreakAfter: "always",
        }}>
          <div style={{ fontSize: "13px", letterSpacing: "8px", color: "#F5B700", marginBottom: "24px", fontWeight: 700 }}>
            SMARTMATCH
          </div>
          <div style={{ fontSize: "42px", fontWeight: 900, color: "#ffffff", marginBottom: "8px", textAlign: "center" }}>
            投資人格分析報告
          </div>
          <div style={{ width: "60px", height: "3px", backgroundColor: "#F5B700", margin: "20px auto 32px" }} />
          {clientName && (
            <div style={{ fontSize: "20px", color: "#94a3b8", marginBottom: "12px" }}>
              客戶姓名：<span style={{ color: "#ffffff", fontWeight: 700 }}>{clientName}</span>
            </div>
          )}
          <div style={{ fontSize: "16px", color: "#64748b", marginBottom: "8px" }}>分析日期：{today}</div>
          {scoreParam && <div style={{ fontSize: "15px", color: "#64748b" }}>問卷總分：{scoreParam} 分</div>}
          <div style={{ marginTop: "48px", fontSize: "13px", color: "#334155", textAlign: "center" }}>
            本報告由 SmartMatch 投資資料分析平台產生<br />
            瑞宇智庫｜contact@smartmatch.tw
          </div>
        </div>

        {/* ── 第二頁：人格分析 ─────────────────────────────────────── */}
        <div style={{
          minHeight: "270mm", backgroundColor: "#020817", padding: "48px 40px",
          pageBreakAfter: "always",
        }}>
          <div style={{ fontSize: "11px", letterSpacing: "6px", color: "#F5B700", fontWeight: 700, marginBottom: "16px" }}>
            SECTION 1 · 投資人格分析
          </div>
          <div style={{ fontSize: "15px", color: "#64748b", marginBottom: "8px" }}>投資人格分析結果</div>
          <div style={{ fontSize: "52px", fontWeight: 900, color: "#ffffff", marginBottom: "8px" }}>{rule.title}</div>
          <div style={{ fontSize: "14px", color: "#64748b", marginBottom: "32px" }}>{rule.riskLabel}</div>
          <div style={{
            backgroundColor: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: "16px", padding: "28px",
          }}>
            <div style={{ fontSize: "15px", color: "#94a3b8", lineHeight: "1.9" }}>{rule.summary}</div>
          </div>
          {/* 星星數 */}
          <div style={{ marginTop: "32px" }}>
            <div style={{ fontSize: "13px", color: "#64748b", marginBottom: "8px" }}>風險等級</div>
            <div style={{ fontSize: "28px", color: "#F5B700" }}>
              {"★".repeat(type === "conservative" ? 2 : type === "balanced" ? 3 : type === "growth" ? 4 : 5)}
            </div>
          </div>
        </div>

        {/* ── 第三頁：配置分析 ─────────────────────────────────────── */}
        <div style={{
          minHeight: "270mm", backgroundColor: "#020817", padding: "48px 40px",
          pageBreakAfter: "always",
        }}>
          <div style={{ fontSize: "11px", letterSpacing: "6px", color: "#F5B700", fontWeight: 700, marginBottom: "16px" }}>
            SECTION 2 · 配置分析
          </div>
          <div style={{ fontSize: "28px", fontWeight: 700, color: "#ffffff", marginBottom: "32px" }}>資產配置分析</div>

          {/* 長條圖 */}
          <div style={{ display: "flex", height: "20px", borderRadius: "10px", overflow: "hidden", marginBottom: "24px" }}>
            {alloc.map(a => (
              <div key={a.label} style={{ width: `${a.value}%`, backgroundColor: a.color }} />
            ))}
          </div>

          {/* 三欄數值 */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px", marginBottom: "32px" }}>
            {alloc.map(a => (
              <div key={a.label} style={{
                backgroundColor: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: "12px", padding: "20px",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                  <div style={{ width: "10px", height: "10px", backgroundColor: a.color, borderRadius: "2px" }} />
                  <div style={{ fontSize: "13px", color: "#94a3b8" }}>{a.label}</div>
                </div>
                <div style={{ fontSize: "40px", fontWeight: 900, color: "#ffffff" }}>{a.value}%</div>
              </div>
            ))}
          </div>

          <div style={{ fontSize: "12px", color: "#475569", lineHeight: "1.8" }}>
            以上為依據投資人格分析結果產生之資產配置參考比例。實際配置應依個人財務狀況、投資期間與市場情況調整。
          </div>
        </div>

        {/* ── 第四頁：ETF 篩選結果 ─────────────────────────────────── */}
        <div style={{
          minHeight: "270mm", backgroundColor: "#020817", padding: "48px 40px",
          pageBreakAfter: "always",
        }}>
          <div style={{ fontSize: "11px", letterSpacing: "6px", color: "#F5B700", fontWeight: 700, marginBottom: "16px" }}>
            SECTION 3 · ETF 篩選結果
          </div>
          <div style={{ fontSize: "28px", fontWeight: 700, color: "#ffffff", marginBottom: "8px" }}>ETF 篩選結果</div>
          <div style={{ fontSize: "13px", color: "#64748b", marginBottom: "28px" }}>
            以下為依據本次配置分析條件，從 ETF 資料庫篩選出的商品，依近一年績效排序。
          </div>

          {etfGroups.map(group => (
            <div key={group.label} style={{ marginBottom: "24px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                <div style={{ width: "3px", height: "16px", backgroundColor: "#F5B700", borderRadius: "2px" }} />
                <div style={{ fontSize: "13px", fontWeight: 600, color: "#cbd5e1" }}>{group.label}</div>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ backgroundColor: "rgba(255,255,255,0.04)" }}>
                    <th style={{ padding: "8px 12px", textAlign: "left", fontSize: "11px", color: "#64748b", width: "80px" }}>代碼</th>
                    <th style={{ padding: "8px 12px", textAlign: "left", fontSize: "11px", color: "#64748b" }}>商品名稱</th>
                    <th style={{ padding: "8px 12px", textAlign: "right", fontSize: "11px", color: "#64748b" }}>殖利率</th>
                    <th style={{ padding: "8px 12px", textAlign: "right", fontSize: "11px", color: "#64748b" }}>近1年</th>
                    <th style={{ padding: "8px 12px", textAlign: "right", fontSize: "11px", color: "#64748b" }}>波動度</th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((etf, i) => (
                    <tr key={etf.code} style={{ backgroundColor: i % 2 === 1 ? "rgba(255,255,255,0.02)" : "transparent", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                      <td style={{ padding: "8px 12px", fontSize: "13px", fontWeight: 700, color: "#F5B700" }}>{etf.code}</td>
                      <td style={{ padding: "8px 12px", fontSize: "12px", color: "#cbd5e1" }}>{etf.name.slice(0, 28)}</td>
                      <td style={{ padding: "8px 12px", fontSize: "12px", color: "#94a3b8", textAlign: "right" }}>
                        {etf.dividendYield > 0 ? `${etf.dividendYield.toFixed(1)}%` : "—"}
                      </td>
                      <td style={{ padding: "8px 12px", fontSize: "12px", textAlign: "right", color: etf.return1y >= 0 ? "#34d399" : "#f87171", fontWeight: 600 }}>
                        {etf.return1y >= 0 ? "+" : ""}{etf.return1y.toFixed(1)}%
                      </td>
                      <td style={{ padding: "8px 12px", fontSize: "12px", color: "#94a3b8", textAlign: "right" }}>{etf.volatility.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {/* ── 第五頁：基金篩選結果 ─────────────────────────────────── */}
        <div style={{
          minHeight: "270mm", backgroundColor: "#020817", padding: "48px 40px",
          pageBreakAfter: "always",
        }}>
          <div style={{ fontSize: "11px", letterSpacing: "6px", color: "#F5B700", fontWeight: 700, marginBottom: "16px" }}>
            SECTION 4 · 基金篩選結果
          </div>
          <div style={{ fontSize: "28px", fontWeight: 700, color: "#ffffff", marginBottom: "8px" }}>基金篩選結果</div>
          <div style={{ fontSize: "13px", color: "#64748b", marginBottom: "28px" }}>
            以下為依據本次配置分析條件，從基金資料庫篩選出的商品，依近一年績效排序。
          </div>

          {fundGroups.map(group => (
            <div key={group.label} style={{ marginBottom: "24px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                <div style={{ width: "3px", height: "16px", backgroundColor: "#F5B700", borderRadius: "2px" }} />
                <div style={{ fontSize: "13px", fontWeight: 600, color: "#cbd5e1" }}>{group.label}</div>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ backgroundColor: "rgba(255,255,255,0.04)" }}>
                    <th style={{ padding: "8px 12px", textAlign: "left", fontSize: "11px", color: "#64748b", width: "64px" }}>公司</th>
                    <th style={{ padding: "8px 12px", textAlign: "left", fontSize: "11px", color: "#64748b" }}>基金名稱</th>
                    <th style={{ padding: "8px 12px", textAlign: "center", fontSize: "11px", color: "#64748b" }}>晨星</th>
                    <th style={{ padding: "8px 12px", textAlign: "right", fontSize: "11px", color: "#64748b" }}>年化配息</th>
                    <th style={{ padding: "8px 12px", textAlign: "right", fontSize: "11px", color: "#64748b" }}>近1年</th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((fund, i) => (
                    <tr key={fund.id} style={{ backgroundColor: i % 2 === 1 ? "rgba(255,255,255,0.02)" : "transparent", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                      <td style={{ padding: "8px 12px", fontSize: "12px", fontWeight: 700, color: "#ffffff" }}>{fund.company}</td>
                      <td style={{ padding: "8px 12px", fontSize: "11px", color: "#cbd5e1" }}>{fund.name.slice(0, 24)}</td>
                      <td style={{ padding: "8px 12px", fontSize: "12px", color: "#F5B700", textAlign: "center" }}>{"★".repeat(fund.morningstar)}</td>
                      <td style={{ padding: "8px 12px", fontSize: "12px", color: "#F5B700", textAlign: "right", fontWeight: 600 }}>
                        {fund.dividendYieldA > 0 ? `${fund.dividendYieldA.toFixed(1)}%` : "—"}
                      </td>
                      <td style={{ padding: "8px 12px", fontSize: "12px", textAlign: "right", color: fund.return1y >= 0 ? "#34d399" : "#f87171", fontWeight: 600 }}>
                        {fund.return1y >= 0 ? "+" : ""}{fund.return1y.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {/* ── 最後一頁：免責聲明 ───────────────────────────────────── */}
        <div style={{
          minHeight: "120mm", backgroundColor: "#020817", padding: "48px 40px",
        }}>
          <div style={{ fontSize: "11px", letterSpacing: "6px", color: "#F5B700", fontWeight: 700, marginBottom: "16px" }}>
            DISCLAIMER · 免責聲明
          </div>
          <div style={{
            backgroundColor: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: "12px", padding: "28px",
          }}>
            <p style={{ fontSize: "13px", color: "#64748b", lineHeight: "2.0", margin: 0 }}>
              本平台提供之資料、分析結果、篩選結果與研究工具，僅供資訊參考與研究用途，
              不構成任何投資建議、招攬、推介或保證獲利。
              投資人應自行判斷並承擔投資風險，並詳閱各商品公開說明書後謹慎決策。
              過去績效不代表未來表現。本平台不對任何投資損益負責。
            </p>
          </div>
          <div style={{ marginTop: "40px", textAlign: "center", fontSize: "12px", color: "#334155" }}>
            SmartMatch｜瑞宇智庫｜© {new Date().getFullYear()} All rights reserved.
          </div>
        </div>

      </div>{/* end pdfRef */}

      {/* ── 頁面上的報告內容（螢幕顯示版）──────────────────────── */}
      <div className="max-w-[860px] mx-auto mt-4">

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

        {/* 配置分析 */}
        <section className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-8 mb-10">
          <div className="text-[11px] tracking-[6px] text-[#F5B700] font-semibold mb-5">SECTION 2 · 配置分析</div>
          <h2 className="text-[22px] font-bold text-white mb-6">資產配置分析</h2>
          <div className="flex h-5 rounded-full overflow-hidden mb-6">
            {alloc.map(a => <div key={a.label} style={{ width: `${a.value}%`, backgroundColor: a.color }} />)}
          </div>
          <div className="grid grid-cols-3 gap-5">
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
        </section>

        {/* ETF 篩選結果 */}
        <section className="mb-10">
          <div className="text-[11px] tracking-[6px] text-[#F5B700] font-semibold mb-4">SECTION 3 · ETF 篩選結果</div>
          <h2 className="text-[22px] font-bold text-white mb-2">ETF 篩選結果</h2>
          <p className="text-[13px] text-slate-500 mb-6">依據本次配置分析條件，從 ETF 資料庫篩選出的商品，依近一年績效排序。</p>
          {etfGroups.map(group => (
            <div key={group.label} className="mb-6">
              <div className="text-[13px] font-semibold text-slate-300 mb-3 flex items-center gap-2">
                <span className="w-1 h-4 bg-[#F5B700] rounded-full inline-block" />{group.label}
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
                      <tr key={etf.code} className={`text-[13px] border-t border-white/[0.05] ${i % 2 === 1 ? "bg-white/[0.02]" : ""}`}>
                        <td className="px-4 py-2.5 font-bold text-[#F5B700]">{etf.code}</td>
                        <td className="px-4 py-2.5 text-slate-300 max-w-[240px] truncate">{etf.name}</td>
                        <td className="px-4 py-2.5 text-right text-slate-400">{etf.dividendYield > 0 ? `${etf.dividendYield.toFixed(1)}%` : "—"}</td>
                        <td className="px-4 py-2.5 text-right"><Pct v={etf.return1y} /></td>
                        <td className="px-4 py-2.5 text-right text-slate-400">{etf.volatility.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>

        {/* 基金篩選結果 */}
        <section className="mb-12">
          <div className="text-[11px] tracking-[6px] text-[#F5B700] font-semibold mb-4">SECTION 4 · 基金篩選結果</div>
          <h2 className="text-[22px] font-bold text-white mb-2">基金篩選結果</h2>
          <p className="text-[13px] text-slate-500 mb-6">依據本次配置分析條件，從基金資料庫篩選出的商品，依近一年績效排序。</p>
          {fundGroups.map(group => (
            <div key={group.label} className="mb-6">
              <div className="text-[13px] font-semibold text-slate-300 mb-3 flex items-center gap-2">
                <span className="w-1 h-4 bg-[#F5B700] rounded-full inline-block" />{group.label}
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
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((fund, i) => (
                      <tr key={fund.id} className={`text-[13px] border-t border-white/[0.05] ${i % 2 === 1 ? "bg-white/[0.02]" : ""}`}>
                        <td className="px-4 py-2.5 font-bold text-white text-[12px]">{fund.company}</td>
                        <td className="px-4 py-2.5 text-slate-300 max-w-[220px] truncate">{fund.name}</td>
                        <td className="px-4 py-2.5 text-center"><Stars n={fund.morningstar} /></td>
                        <td className="px-4 py-2.5 text-right text-[#F5B700] font-semibold">{fund.dividendYieldA > 0 ? `${fund.dividendYieldA.toFixed(1)}%` : "—"}</td>
                        <td className="px-4 py-2.5 text-right"><Pct v={fund.return1y} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>

        {/* 免責聲明 */}
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-6 mb-10">
          <div className="text-[12px] font-bold text-slate-400 mb-2">免責聲明</div>
          <p className="text-[12px] text-slate-600 leading-[1.9]">
            本平台提供之資料、分析結果、篩選結果與研究工具，僅供資訊參考與研究用途，
            不構成任何投資建議、招攬、推介或保證獲利。
            投資人應自行判斷並承擔投資風險，並詳閱各商品公開說明書後謹慎決策。
            過去績效不代表未來表現。
          </p>
        </div>

        {/* 按鈕 */}
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