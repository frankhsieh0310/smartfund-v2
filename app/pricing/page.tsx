"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AuthButton } from "@/components/auth/AuthButton";

const investmentItems = [
  { label: "股票" }, { label: "ETF", href: "/etf" }, { label: "基金", href: "/funds" },
  { label: "債券" }, { label: "REITs" }, { label: "指數" }, { label: "外匯" },
  { label: "商品" }, { label: "加密貨幣" }, { label: "期貨" },
];
const researchItems = [
  { label: "SmartMatch", href: "/quiz" }, { label: "篩選器", href: "/etf" },
  { label: "商品比較", href: "/compare" }, { label: "投資組合健檢", href: "/portfolio" },
  { label: "研究分析", href: "/report" },
];
const dataItems = [
  { label: "經濟數據" }, { label: "殖利率" }, { label: "經濟日曆" }, { label: "財報日曆" },
  { label: "配息日曆" }, { label: "IPO" }, { label: "公司行動" }, { label: "機構持股" },
];

const plans = [
  {
    name: "Free",
    price: "NT$0",
    description: "適合想快速掌握市場與探索投資商品的使用者。",
    features: ["全球市場總覽", "基本股票 / ETF / 基金資料", "基本排行榜", "SmartMatch 基本功能", "基本搜尋"],
    action: "免費開始",
  },
  {
    name: "Premium",
    price: "價格即將公布",
    description: "適合希望進一步比較、篩選與分析投資商品的投資人。",
    features: ["Free 全部功能", "完整全球商品資料", "Compare 商品比較", "進階 Screener", "進階排行榜", "Portfolio 分析", "進階歷史數據", "延伸市場資料", "優先資料更新"],
    action: "升級 Premium",
    popular: true,
  },
  {
    name: "Professional",
    price: "價格即將公布",
    description: "適合金融從業人員與高頻研究需求使用者。",
    features: ["Premium 全部功能", "更完整歷史資料", "專業研究工具", "進階 Portfolio Analytics", "研究報告輸出", "客戶管理 / Professional Workspace", "更高使用額度", "專業資料權限"],
    action: "了解 Professional",
  },
];

const comparisonRows = [
  ["全球市場資料", "有限", "✓", "✓"], ["股票", "有限", "✓", "✓"],
  ["ETF", "有限", "✓", "✓"], ["基金", "有限", "✓", "✓"],
  ["債券", "有限", "✓", "✓"], ["外匯", "有限", "✓", "✓"],
  ["商品", "有限", "✓", "✓"], ["Crypto", "有限", "✓", "✓"],
  ["歷史資料", "有限", "有限", "✓"], ["SmartMatch", "有限", "✓", "✓"],
  ["Compare", "—", "✓", "✓"], ["Screener", "—", "✓", "✓"],
  ["Ranking", "有限", "✓", "✓"], ["Portfolio", "—", "✓", "✓"],
  ["延伸資料", "—", "✓", "✓"], ["研究報告", "—", "—", "✓"],
  ["Professional Workspace", "—", "—", "✓"],
];

const faqs = [
  ["可以隨時升級嗎？", "可以。所有方案皆可在服務開放後依需求升級。"],
  ["Premium 與 Professional 差在哪裡？", "Premium 著重個人進階研究；Professional 預留專業研究、報告與工作空間能力。"],
  ["資料多久更新一次？", "更新頻率依資料來源與方案而異，正式規格將於資料服務完成後公布。"],
  ["未來支援哪些付款方式？", "預計支援台灣常用線上付款方式，包含藍新金流與綠界科技等整合選項。"],
];

function HeaderDropdown({ label, items, open, onToggle, onClose }: {
  label: string;
  items: ReadonlyArray<{ label: string; href?: string }>;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  return (
    <details className="group relative" open={open}>
      <summary onClick={(event) => { event.preventDefault(); onToggle(); }} className="flex cursor-pointer list-none items-center gap-1 whitespace-nowrap py-7 transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
        {label}<span className="text-[10px] text-slate-500 transition-transform group-open:rotate-180">▼</span>
      </summary>
      <div className="absolute left-1/2 top-[68px] w-48 -translate-x-1/2 rounded-xl border border-white/[0.12] bg-[#07111f]/[0.98] p-2 shadow-[0_18px_55px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        {items.map((item) => item.href ? (
          <Link key={item.label} href={item.href} onClick={onClose} className="block rounded-lg px-3 py-2.5 text-[14px] font-medium text-slate-300 transition-colors hover:bg-white/[0.07] hover:text-white">{item.label}</Link>
        ) : (
          <span key={item.label} onClick={onClose} className="block rounded-lg px-3 py-2.5 text-[14px] font-medium text-slate-500">{item.label}</span>
        ))}
      </div>
    </details>
  );
}

export default function PricingPage() {
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const closeOutside = (event: MouseEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setActiveDropdown(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveDropdown(null);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <main className="min-h-screen bg-[#07111f] text-white">
      <header ref={headerRef} className="fixed left-0 top-0 z-50 w-full border-b border-white/[0.08] bg-[#040a18]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-20 max-w-[1600px] items-center justify-between px-6 sm:px-10">
          <Link href="/">
            <div className="text-[28px] font-black leading-none text-white sm:text-[32px]">Smart<span className="text-[#F5B700]">Fund</span></div>
            <div className="mt-0.5 text-[11px] text-slate-400 sm:text-[12px]">全球投資研究平台</div>
          </Link>
          <nav className="hidden items-center gap-5 text-[15px] font-semibold text-slate-300 lg:flex">
            <Link href="/markets" className="whitespace-nowrap py-7 transition-colors hover:text-white">市場總覽</Link>
            <HeaderDropdown label="投資商品" items={investmentItems} open={activeDropdown === "investment"} onToggle={() => setActiveDropdown((value) => value === "investment" ? null : "investment")} onClose={() => setActiveDropdown(null)} />
            <HeaderDropdown label="研究工具" items={researchItems} open={activeDropdown === "research"} onToggle={() => setActiveDropdown((value) => value === "research" ? null : "research")} onClose={() => setActiveDropdown(null)} />
            <Link href="/rankings" className="whitespace-nowrap py-7 transition-colors hover:text-white">排行榜</Link>
            <Link href="/portfolio" className="whitespace-nowrap py-7 transition-colors hover:text-white">投資組合</Link>
            <HeaderDropdown label="資料中心" items={dataItems} open={activeDropdown === "data"} onToggle={() => setActiveDropdown((value) => value === "data" ? null : "data")} onClose={() => setActiveDropdown(null)} />
            <Link href="/pricing" className="whitespace-nowrap py-7 text-[#F5B700]">會員專區</Link>
          </nav>
          <div className="flex items-center gap-2 sm:gap-4">
            <AuthButton className="hidden rounded-lg border border-white/30 px-5 py-2.5 text-[15px] font-semibold text-slate-300 transition-colors hover:bg-white/10 sm:block" />
            <Link href="/quiz" className="rounded-lg bg-[#F5B700] px-4 py-2.5 text-[14px] font-bold text-[#0B1220] transition-colors hover:bg-[#e0a800] sm:px-6 sm:text-[15px]">開始建立</Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1450px] px-6 pb-20 pt-32 sm:px-8 md:px-10">
        <section className="mx-auto max-w-3xl text-center">
          <div className="text-[12px] font-semibold tracking-[0.3em] text-[#F5B700]">MEMBERSHIP PLANS</div>
          <h1 className="mt-4 text-[40px] font-black tracking-[-0.03em] md:text-[52px]">選擇適合你的 SmartMatch</h1>
          <p className="mt-5 text-[17px] leading-8 text-slate-400">從全球市場資料到進階研究工具，<br className="hidden sm:block" />依照你的投資需求選擇適合的方案。</p>
          <p className="mt-3 text-[13px] text-slate-600">所有方案皆可隨時升級。</p>
        </section>

        <section className="mt-12 grid gap-5 lg:grid-cols-3">
          {plans.map((plan) => (
            <article key={plan.name} className={`relative flex min-h-[570px] flex-col rounded-2xl border p-7 md:p-8 ${plan.popular ? "border-[#F5B700]/45 bg-[#F5B700]/[0.055] shadow-[0_20px_70px_rgba(0,0,0,0.18)]" : "border-white/[0.1] bg-white/[0.035]"}`}>
              {plan.popular && <div className="absolute right-6 top-6 rounded-full border border-[#F5B700]/25 bg-[#F5B700]/10 px-3 py-1 text-[9px] font-bold tracking-[0.14em] text-[#F5B700]">MOST POPULAR</div>}
              <h2 className="text-[25px] font-black">{plan.name}</h2>
              <div className={`mt-7 font-black ${plan.price === "NT$0" ? "text-[34px]" : "text-[22px]"}`}>{plan.price}</div>
              <p className="mt-5 min-h-[84px] text-[14px] leading-7 text-slate-400">{plan.description}</p>
              <div className="mt-6 border-t border-white/[0.08] pt-6">
                <ul className="space-y-3.5">
                  {plan.features.map((feature) => <li key={feature} className="flex gap-3 text-[13px] leading-6 text-slate-300"><span className="text-[#F5B700]">✓</span>{feature}</li>)}
                </ul>
              </div>
              <button type="button" className={`mt-auto w-full rounded-xl px-5 py-3.5 text-[14px] font-bold transition-colors ${plan.popular ? "bg-[#F5B700] text-[#07111f] hover:bg-[#ffd04a]" : "border border-white/15 text-white hover:bg-white/[0.07]"}`}>{plan.action}</button>
            </article>
          ))}
        </section>

        <section className="mt-16">
          <div className="mb-6"><div className="text-[11px] font-semibold tracking-[0.22em] text-[#F5B700]">FEATURES</div><h2 className="mt-3 text-[28px] font-black">功能比較表</h2></div>
          <div className="overflow-x-auto rounded-2xl border border-white/[0.09] bg-white/[0.03]">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead className="border-b border-white/[0.08] text-left"><tr><th className="px-6 py-5 text-slate-500">核心功能</th>{["Free", "Premium", "Professional"].map((name) => <th key={name} className="px-6 py-5 text-center font-bold">{name}</th>)}</tr></thead>
              <tbody>{comparisonRows.map(([feature, ...values]) => <tr key={feature} className="border-b border-white/[0.055] last:border-0"><td className="px-6 py-3.5 font-medium text-slate-300">{feature}</td>{values.map((value, index) => <td key={`${feature}-${index}`} className={`px-6 py-3.5 text-center ${value === "✓" ? "text-[#F5B700]" : "text-slate-500"}`}>{value}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </section>

        <section className="mt-16 grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
          <div data-payment-integration="reserved" className="rounded-2xl border border-white/[0.09] bg-white/[0.03] p-7 md:p-8">
            <div className="text-[10px] font-bold tracking-[0.2em] text-slate-500">FUTURE PAYMENT INTEGRATION</div>
            <h2 className="mt-4 text-[24px] font-black">安全付款</h2>
            <p className="mt-4 text-[14px] leading-7 text-slate-400">未來將支援台灣常用線上付款方式。</p>
            <div className="mt-7 flex flex-wrap gap-3"><span className="rounded-lg border border-white/[0.1] px-4 py-2 text-[12px] text-slate-400">藍新金流</span><span className="rounded-lg border border-white/[0.1] px-4 py-2 text-[12px] text-slate-400">綠界科技</span></div>
          </div>
          <div className="rounded-2xl border border-white/[0.09] bg-white/[0.03] p-7 md:p-8">
            <div className="text-[10px] font-bold tracking-[0.2em] text-slate-500">FAQ</div>
            <h2 className="mt-4 text-[24px] font-black">常見問題</h2>
            <div className="mt-6 divide-y divide-white/[0.07]">{faqs.map(([question, answer]) => <details key={question} className="group py-4"><summary className="flex cursor-pointer list-none items-center justify-between gap-5 text-[14px] font-semibold [&::-webkit-details-marker]:hidden">{question}<span className="text-slate-500 transition-transform group-open:rotate-45">＋</span></summary><p className="mt-3 pr-8 text-[13px] leading-6 text-slate-500">{answer}</p></details>)}</div>
          </div>
        </section>
      </div>
    </main>
  );
}
