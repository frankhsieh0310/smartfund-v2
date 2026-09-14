"use client";

import Link from "next/link";
import { AuthButton } from "@/components/auth/AuthButton";
import { useEffect, useRef, useState } from "react";

const assetTabs = ["股票", "ETF", "基金", "債券", "REITs", "Crypto"];
const rankingFilters = ["熱門", "漲幅", "跌幅", "成交活躍", "近期表現"];
const tableHeadings = ["排名", "名稱", "代碼", "市場", "最新值", "漲跌", "漲跌幅", "近期報酬", "操作"];

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

export default function RankingsPage() {
  const [activeAsset, setActiveAsset] = useState("股票");
  const [activeFilter, setActiveFilter] = useState("熱門");
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
            <Link href="/rankings" className="whitespace-nowrap py-7 text-white">排行榜</Link>
            <Link href="/portfolio" className="whitespace-nowrap py-7 transition-colors hover:text-white">投資組合</Link>
            <HeaderDropdown label="資料中心" items={dataItems} open={activeDropdown === "data"} onToggle={() => setActiveDropdown((value) => value === "data" ? null : "data")} onClose={() => setActiveDropdown(null)} />
            <Link href="/pricing" className="whitespace-nowrap py-7 transition-colors hover:text-[#F5B700]">會員專區</Link>
          </nav>
          <div className="flex items-center gap-2 sm:gap-4">
            <AuthButton className="hidden rounded-lg border border-white/30 px-5 py-2.5 text-[15px] font-semibold text-slate-300 transition-colors hover:bg-white/10 sm:block" />
            <Link href="/quiz" className="rounded-lg bg-[#F5B700] px-4 py-2.5 text-[14px] font-bold text-[#0B1220] transition-colors hover:bg-[#e0a800] sm:px-6 sm:text-[15px]">開始建立</Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] px-6 pb-20 pt-32 sm:px-8 md:px-10">
        <section className="flex flex-col justify-between gap-7 border-b border-white/[0.08] pb-9 md:flex-row md:items-end">
          <div>
            <div className="text-[12px] font-semibold tracking-[0.3em] text-[#F5B700]">GLOBAL RANKINGS</div>
            <h1 className="mt-4 text-[42px] font-black tracking-[-0.03em] md:text-[52px]">全球排行榜</h1>
            <p className="mt-4 text-[17px] leading-8 text-slate-400">快速探索不同市場與投資商品的表現排行。</p>
          </div>
          <div className="text-[13px] text-slate-500">資料更新時間：—</div>
        </section>

        <section className="mt-8 overflow-hidden rounded-2xl border border-white/[0.09] bg-white/[0.035]">
          <div className="overflow-x-auto border-b border-white/[0.08] px-5">
            <div className="flex min-w-max gap-2 py-4">
              {assetTabs.map((asset) => (
                <button key={asset} type="button" onClick={() => setActiveAsset(asset)} className={`rounded-lg px-5 py-2.5 text-[14px] font-bold transition-colors ${activeAsset === asset ? "bg-[#F5B700] text-[#07111f]" : "text-slate-400 hover:bg-white/[0.06] hover:text-white"}`}>{asset}</button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto border-b border-white/[0.08] px-5">
            <div className="flex min-w-max gap-2 py-4">
              {rankingFilters.map((filter) => (
                <button key={filter} type="button" onClick={() => setActiveFilter(filter)} className={`rounded-lg border px-4 py-2 text-[13px] font-semibold transition-colors ${activeFilter === filter ? "border-white/20 bg-white/[0.09] text-white" : "border-transparent text-slate-500 hover:text-slate-300"}`}>{filter}</button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-left text-[13px]">
              <thead className="border-b border-white/[0.08] text-slate-500">
                <tr>{tableHeadings.map((heading) => <th key={heading} className="px-5 py-4 font-semibold">{heading}</th>)}</tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={9} className="px-6 py-20 text-center">
                    <div className="text-[11px] font-bold tracking-[0.2em] text-[#F5B700]/70">DATA PENDING</div>
                    <div className="mt-4 text-[18px] font-bold text-slate-300">排行榜資料準備中</div>
                    <div className="mt-2 text-[13px] text-slate-600">資料完成後將顯示全球市場最新排行。</div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-10 flex flex-col justify-between gap-7 rounded-2xl border border-[#F5B700]/20 bg-[#F5B700]/[0.055] p-7 md:flex-row md:items-center md:p-9">
          <div>
            <div className="inline-flex rounded-full border border-[#F5B700]/25 bg-[#F5B700]/10 px-3 py-1 text-[9px] font-bold tracking-[0.14em] text-[#F5B700]">PREMIUM</div>
            <h2 className="mt-4 text-[24px] font-black">進階排行榜</h2>
            <p className="mt-3 max-w-3xl text-[13px] leading-7 text-slate-400">未來可支援多期間、風險調整後、資產類別、區域與自訂條件排行。</p>
          </div>
          <Link href="/pricing" className="shrink-0 rounded-xl border border-[#F5B700]/35 px-6 py-3 text-center text-[14px] font-bold text-[#F5B700] transition-colors hover:bg-[#F5B700]/10">查看 Premium</Link>
        </section>
      </div>
    </main>
  );
}
