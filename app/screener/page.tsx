"use client";

import Link from "next/link";
import { AuthButton } from "@/components/auth/AuthButton";
import { useEffect, useRef, useState } from "react";

const assetTabs = ["股票", "ETF", "基金", "債券", "REITs", "Crypto"] as const;
type AssetTab = (typeof assetTabs)[number];

const filterFields: Record<AssetTab, string[]> = {
  股票: ["市場", "國家", "產業", "市值", "PE", "PB", "ROE", "殖利率", "1Y 報酬", "波動度"],
  ETF: ["資產類別", "區域", "AUM", "費用率", "殖利率", "1Y 報酬", "波動度"],
  基金: ["基金類型", "區域", "幣別", "AUM", "1Y", "3Y", "5Y", "Sharpe"],
  債券: ["國家", "幣別", "信用評等", "殖利率", "到期日", "存續期間"],
  REITs: ["國家", "產業", "殖利率", "市值", "1Y 報酬"],
  Crypto: ["市值", "成交量", "1Y 報酬", "波動度"],
};

const investmentItems = [
  { label: "股票" }, { label: "ETF", href: "/etf" }, { label: "基金", href: "/funds" },
  { label: "債券" }, { label: "REITs" }, { label: "指數" }, { label: "外匯" },
  { label: "商品" }, { label: "加密貨幣" }, { label: "期貨" },
];
const researchItems = [
  { label: "SmartMatch", href: "/quiz" }, { label: "篩選器", href: "/screener" },
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
          <Link key={item.label} href={item.href} onClick={onClose} className={`block rounded-lg px-3 py-2.5 text-[14px] font-medium transition-colors hover:bg-white/[0.07] hover:text-white ${item.href === "/screener" ? "text-white" : "text-slate-300"}`}>{item.label}</Link>
        ) : (
          <span key={item.label} onClick={onClose} className="block rounded-lg px-3 py-2.5 text-[14px] font-medium text-slate-500">{item.label}</span>
        ))}
      </div>
    </details>
  );
}

export default function ScreenerPage() {
  const [activeAsset, setActiveAsset] = useState<AssetTab>("股票");
  const [filtersOpen, setFiltersOpen] = useState(false);
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
            <Link href="/pricing" className="whitespace-nowrap py-7 transition-colors hover:text-[#F5B700]">會員專區</Link>
          </nav>
          <div className="flex items-center gap-2 sm:gap-4">
            <AuthButton className="hidden rounded-lg border border-white/30 px-5 py-2.5 text-[15px] font-semibold text-slate-300 transition-colors hover:bg-white/10 sm:block" />
            <Link href="/quiz" className="rounded-lg bg-[#F5B700] px-4 py-2.5 text-[14px] font-bold text-[#0B1220] transition-colors hover:bg-[#e0a800] sm:px-6 sm:text-[15px]">開始建立</Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] px-6 pb-20 pt-32 sm:px-8 md:px-10">
        <section className="border-b border-white/[0.08] pb-9">
          <div className="text-[12px] font-semibold tracking-[0.3em] text-[#F5B700]">GLOBAL SCREENER</div>
          <h1 className="mt-4 text-[42px] font-black tracking-[-0.03em] md:text-[52px]">全球投資篩選器</h1>
          <p className="mt-4 text-[17px] leading-8 text-slate-400">利用市場、資產類別與關鍵數據，<br className="hidden sm:block" />快速縮小你的研究範圍。</p>
        </section>

        <section className="mt-7 overflow-x-auto border-b border-white/[0.08] pb-5">
          <div className="flex min-w-max gap-2">
            {assetTabs.map((asset) => <button key={asset} type="button" onClick={() => setActiveAsset(asset)} className={`rounded-lg px-5 py-2.5 text-[14px] font-bold transition-colors ${activeAsset === asset ? "bg-[#F5B700] text-[#07111f]" : "border border-white/[0.08] text-slate-400 hover:bg-white/[0.05] hover:text-white"}`}>{asset}</button>)}
          </div>
        </section>

        <button type="button" onClick={() => setFiltersOpen((value) => !value)} className="mt-6 flex w-full items-center justify-between rounded-xl border border-white/[0.1] bg-white/[0.04] px-5 py-4 text-[14px] font-bold lg:hidden">篩選條件<span className="text-slate-500">{filtersOpen ? "收合" : "展開"}</span></button>

        <div className="mt-6 grid gap-6 lg:grid-cols-[300px_1fr]">
          <aside className={`${filtersOpen ? "block" : "hidden"} rounded-2xl border border-white/[0.09] bg-white/[0.035] p-5 lg:block`}>
            <div className="flex items-center justify-between"><h2 className="text-[18px] font-black">篩選條件</h2><span className="rounded-full border border-[#F5B700]/20 bg-[#F5B700]/10 px-2.5 py-1 text-[9px] font-bold tracking-[0.12em] text-[#F5B700]">PREMIUM</span></div>
            <div className="mt-5 space-y-3">
              {filterFields[activeAsset].map((field) => <button key={field} type="button" className="flex w-full items-center justify-between rounded-xl border border-white/[0.08] bg-black/[0.08] px-4 py-3 text-left text-[13px] text-slate-300 transition-colors hover:border-white/[0.14]"><span>{field}</span><span className="text-[11px] text-slate-600">選擇 ▼</span></button>)}
            </div>
            <div className="mt-6 grid grid-cols-2 gap-2"><button type="button" className="rounded-lg border border-white/[0.1] px-3 py-2.5 text-[12px] font-semibold text-slate-400">清除條件</button><button type="button" className="rounded-lg bg-[#F5B700] px-3 py-2.5 text-[12px] font-bold text-[#07111f]">套用篩選</button></div>
          </aside>

          <section className="overflow-hidden rounded-2xl border border-white/[0.09] bg-white/[0.035]">
            <div className="flex flex-col justify-between gap-4 border-b border-white/[0.08] px-5 py-5 sm:flex-row sm:items-center">
              <div><h2 className="text-[19px] font-black">篩選結果</h2><p className="mt-1 text-[12px] text-slate-600">{activeAsset}・資料尚未接線</p></div>
              <button type="button" className="rounded-lg border border-white/[0.12] px-4 py-2.5 text-[12px] font-semibold text-slate-300 transition-colors hover:bg-white/[0.05]">儲存篩選</button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[940px] text-left text-[13px]">
                <thead className="border-b border-white/[0.08] text-slate-500"><tr>{["名稱", "代碼", "市場", "類型", "最新值", "1Y 報酬", "風險", "操作"].map((heading) => <th key={heading} className="px-5 py-4 font-semibold">{heading}</th>)}</tr></thead>
                <tbody><tr><td colSpan={8} className="px-6 py-24 text-center"><div className="text-[11px] font-bold tracking-[0.2em] text-[#F5B700]/70">DATA PENDING</div><div className="mt-4 text-[18px] font-bold text-slate-300">篩選資料準備中</div><div className="mt-2 text-[13px] text-slate-600">資料完成後將顯示符合條件的投資商品。</div><div className="mt-6 flex justify-center gap-2"><button type="button" disabled className="rounded-lg border border-white/[0.08] px-4 py-2 text-[12px] text-slate-700">查看</button><button type="button" disabled className="rounded-lg border border-white/[0.08] px-4 py-2 text-[12px] text-slate-700">比較</button></div></td></tr></tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
