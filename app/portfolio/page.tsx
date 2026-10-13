"use client";

import Link from "next/link";
import { AuthButton } from "@/components/auth/AuthButton";
import { useEffect, useRef, useState } from "react";

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

function HeaderDropdown({ label, items, open, onToggle, onClose }: { label: string; items: ReadonlyArray<{ label: string; href?: string }>; open: boolean; onToggle: () => void; onClose: () => void }) {
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

const summaryItems = ["總資產", "累積報酬", "今日損益", "投資商品數"];
const riskItems = ["波動度", "最大回撤", "資產集中度", "區域集中度"];
const allocationItems = ["股票", "ETF", "基金", "債券", "現金", "其他"];
const periods = ["1M", "3M", "YTD", "1Y", "3Y", "ALL"];

export default function PortfolioPage() {
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
        <div className="mx-auto flex h-20 max-w-[1600px] items-center justify-between px-10">
          <Link href="/">
            <div className="text-[32px] font-black leading-none text-white">Smart<span className="text-[#F5B700]">Fund</span></div>
            <div className="mt-0.5 text-[12px] text-slate-400">全球投資研究平台</div>
          </Link>
          <nav className="hidden items-center gap-5 text-[15px] font-semibold text-slate-300 lg:flex">
            <Link href="/markets" className="whitespace-nowrap py-7 transition-colors hover:text-white">市場總覽</Link>
            <HeaderDropdown label="投資商品" items={investmentItems} open={activeDropdown === "investment"} onToggle={() => setActiveDropdown((current) => current === "investment" ? null : "investment")} onClose={() => setActiveDropdown(null)} />
            <HeaderDropdown label="研究工具" items={researchItems} open={activeDropdown === "research"} onToggle={() => setActiveDropdown((current) => current === "research" ? null : "research")} onClose={() => setActiveDropdown(null)} />
            <Link href="/rankings" className="whitespace-nowrap py-7 transition-colors hover:text-white">排行榜</Link>
            <Link href="/portfolio" className="whitespace-nowrap py-7 text-white">投資組合</Link>
            <HeaderDropdown label="資料中心" items={dataItems} open={activeDropdown === "data"} onToggle={() => setActiveDropdown((current) => current === "data" ? null : "data")} onClose={() => setActiveDropdown(null)} />
            <Link href="/pricing" className="whitespace-nowrap py-7 transition-colors hover:text-[#F5B700]">會員專區</Link>
          </nav>
          <div className="flex items-center gap-4">
            <AuthButton className="rounded-lg border border-white/30 px-5 py-2.5 text-[16px] font-semibold text-slate-300 transition-colors hover:bg-white/10" />
            <Link href="/quiz" className="rounded-lg bg-[#F5B700] px-6 py-2.5 text-[16px] font-bold text-[#0B1220] transition-colors hover:bg-[#e0a800]">開始建立</Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] px-6 pb-20 pt-32 sm:px-8 md:px-10">
        <section className="flex flex-col justify-between gap-7 border-b border-white/[0.08] pb-10 md:flex-row md:items-end">
          <div>
            <div className="text-[12px] font-semibold tracking-[0.3em] text-[#F5B700]">PORTFOLIO</div>
            <h1 className="mt-4 text-[42px] font-black tracking-[-0.03em] md:text-[52px]">投資組合</h1>
            <p className="mt-4 text-[17px] leading-8 text-slate-400">集中管理你的投資配置，<br className="sm:hidden" />掌握資產分布、績效與風險。</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="rounded-xl bg-[#F5B700] px-6 py-3 text-[15px] font-bold text-[#07111f] transition-colors hover:bg-[#ffd04a]">＋ 新增投資組合</button>
            <button type="button" className="rounded-xl border border-white/15 bg-white/[0.04] px-6 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-white/[0.07]">匯入持倉</button>
          </div>
        </section>

        <section className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {summaryItems.map((item) => (
            <article key={item} className="rounded-2xl border border-white/[0.09] bg-white/[0.04] p-5 md:p-6">
              <div className="text-[13px] font-semibold text-slate-400">{item}</div>
              <div className="mt-5 text-[32px] font-black">—</div>
              <div className="mt-3 text-[11px] text-slate-600">建立投資組合後顯示</div>
            </article>
          ))}
        </section>

        <div className="mt-8 grid gap-6 xl:grid-cols-2">
          <section className="rounded-2xl border border-white/[0.09] bg-white/[0.035] p-6 md:p-7">
            <h2 className="text-[22px] font-black">資產配置</h2>
            <div className="mt-8 flex min-h-[280px] flex-col items-center justify-center gap-8 sm:flex-row">
              <div className="flex h-40 w-40 items-center justify-center rounded-full border-[18px] border-dashed border-white/[0.08] text-center text-[12px] text-slate-600">尚無投資<br />組合資料</div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                {allocationItems.map((item) => <div key={item} className="flex items-center gap-2 text-[13px] text-slate-500"><span className="h-2 w-2 rounded-full bg-white/10" />{item}</div>)}
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-white/[0.09] bg-white/[0.035] p-6 md:p-7">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 className="text-[22px] font-black">績效走勢</h2>
              <div className="flex gap-1.5">{periods.map((period) => <button key={period} type="button" className="rounded-md px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-white/[0.05] hover:text-white">{period}</button>)}</div>
            </div>
            <div className="mt-8 flex min-h-[280px] items-center justify-center rounded-xl border border-dashed border-white/[0.09] text-[13px] text-slate-600">尚無績效資料</div>
          </section>
        </div>

        <section className="mt-8 rounded-2xl border border-white/[0.09] bg-white/[0.035] p-6 md:p-7">
          <div className="flex items-center justify-between gap-4"><h2 className="text-[22px] font-black">持倉明細</h2><button type="button" className="text-[13px] font-semibold text-[#F5B700]">新增第一筆持倉</button></div>
          <div className="mt-6 overflow-x-auto">
            <table className="min-w-[820px] w-full text-left text-[13px]">
              <thead className="border-b border-white/[0.08] text-slate-500"><tr>{["商品", "類型", "市場", "數量", "成本", "市值", "報酬"].map((heading) => <th key={heading} className="px-4 py-3 font-semibold">{heading}</th>)}</tr></thead>
              <tbody><tr><td colSpan={7} className="px-4 py-14 text-center text-slate-600">尚未加入任何持倉</td></tr></tbody>
            </table>
          </div>
        </section>

        <section className="mt-8">
          <h2 className="text-[22px] font-black">風險概覽</h2>
          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {riskItems.map((item) => (
              <article key={item} className="rounded-2xl border border-white/[0.09] bg-white/[0.035] p-5">
                <div className="text-[13px] font-semibold text-slate-400">{item}</div><div className="mt-5 text-[30px] font-black">—</div><div className="mt-3 text-[11px] text-slate-600">資料建立後顯示</div>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-10 flex flex-col justify-between gap-7 rounded-2xl border border-[#F5B700]/20 bg-[#F5B700]/[0.055] p-7 md:flex-row md:items-center md:p-9">
          <div><div className="inline-flex rounded-full border border-[#F5B700]/25 bg-[#F5B700]/10 px-3 py-1 text-[9px] font-bold tracking-[0.14em] text-[#F5B700]">PREMIUM</div><h2 className="mt-4 text-[24px] font-black">進階投資組合分析</h2><p className="mt-3 max-w-3xl text-[13px] leading-7 text-slate-400">未來可支援風險分析、資產相關性、區域與產業曝險、歷史情境分析與投資組合比較。</p></div>
          <Link href="/pricing" className="shrink-0 rounded-xl border border-[#F5B700]/35 px-6 py-3 text-center text-[14px] font-bold text-[#F5B700] transition-colors hover:bg-[#F5B700]/10">查看 Premium</Link>
        </section>
      </div>
    </main>
  );
}
