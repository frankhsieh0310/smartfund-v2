"use client";
// ============================================================
// components/home/CriteriaBuilderSection.tsx
// Sprint 1 重寫
// Task 2: Multi-select（同分類 OR，跨分類 AND）
// Task 3: Count Up Animation 大數字
// Task 4: 共用 ProductCard
// Task 6: 強化定位說明
// Task 7: 範例條件展開顯示
// Task 8: 轉換流程
// Task 9: 產品定位文案
// ============================================================

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { type FilterCondition, type SearchResultItem } from "@/lib/engines/filterEngine";
import { searchFromTags } from "@/lib/query/queryBuilder";
import { useWatchlist } from "@/lib/hooks/useWatchlist";
import { ProductCard } from "@/components/shared/ProductCard";

// ── Count Up Hook ─────────────────────────────────────────────
function useCountUp(target: number, duration = 600): number {
  const [count, setCount] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    if (target === prev.current) return;
    const start = prev.current;
    const diff = target - start;
    const startTime = performance.now();
    function frame(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.round(start + diff * eased));
      if (progress < 1) requestAnimationFrame(frame);
      else prev.current = target;
    }
    requestAnimationFrame(frame);
  }, [target, duration]);
  return count;
}

// ── 條件 label ────────────────────────────────────────────────
function conditionToLabel(c: FilterCondition): string {
  switch (c.type) {
    case "assetType":    return String(c.value);
    case "region":       return String(c.value);
    case "sector":       return String(c.value);
    case "category":     return String(c.value);
    case "distribution": return String(c.value);
    case "yield":        return `殖利率${c.operator}${c.value}%`;
    case "return":       return `近${(c as {period?:string}).period ?? "1y"}績效${c.operator}${c.value}%`;
    case "volatility":   return `波動${c.operator}${c.value}%`;
    case "morningstar":  return `晨星${c.operator}${c.value}星`;
    case "keyword":      return `含「${c.value}」`;
    default:             return String(c.value);
  }
}

// ── 條件分類 label ────────────────────────────────────────────
function typeLabel(type: FilterCondition["type"]): string {
  const map: Record<string, string> = {
    assetType: "類型", region: "區域", sector: "類型",
    category: "商品", distribution: "配息", yield: "殖利率",
    return: "績效", volatility: "波動", morningstar: "晨星",
  };
  return map[type] ?? "";
}

// ── 條件選單定義 ──────────────────────────────────────────────
const CONDITION_MENU: {
  group: string;
  items: { label: string; condition: FilterCondition }[];
}[] = [
  { group: "資產類型", items: [
    { label: "ETF",  condition: { type: "assetType", operator: "==", value: "ETF" } },
    { label: "基金", condition: { type: "assetType", operator: "==", value: "基金" } },
  ]},
  { group: "投資區域", items: [
    { label: "台灣",    condition: { type: "region", operator: "==", value: "台灣" } },
    { label: "美國",    condition: { type: "region", operator: "==", value: "美國" } },
    { label: "全球",    condition: { type: "region", operator: "==", value: "全球" } },
    { label: "亞洲",    condition: { type: "region", operator: "==", value: "亞洲" } },
    { label: "中國",    condition: { type: "region", operator: "==", value: "中國" } },
    { label: "新興市場",condition: { type: "region", operator: "==", value: "新興市場" } },
  ]},
  { group: "商品類型", items: [
    { label: "股票型", condition: { type: "category", operator: "==", value: "股票型" } },
    { label: "債券型", condition: { type: "category", operator: "==", value: "債券型" } },
    { label: "平衡型", condition: { type: "category", operator: "==", value: "平衡型" } },
    { label: "高股息", condition: { type: "sector",   operator: "==", value: "高股息" } },
    { label: "科技",   condition: { type: "sector",   operator: "==", value: "科技"   } },
    { label: "半導體", condition: { type: "sector",   operator: "==", value: "半導體" } },
  ]},
  { group: "配息頻率", items: [
    { label: "月配息", condition: { type: "distribution", operator: "==", value: "月配" } },
    { label: "季配息", condition: { type: "distribution", operator: "==", value: "季配" } },
    { label: "年配",   condition: { type: "distribution", operator: "==", value: "年配" } },
  ]},
  { group: "殖利率", items: [
    { label: "殖利率 > 3%", condition: { type: "yield", operator: ">=", value: 3 } },
    { label: "殖利率 > 5%", condition: { type: "yield", operator: ">=", value: 5 } },
    { label: "殖利率 > 7%", condition: { type: "yield", operator: ">=", value: 7 } },
    { label: "殖利率 > 9%", condition: { type: "yield", operator: ">=", value: 9 } },
  ]},
  { group: "近一年績效", items: [
    { label: "近1年 > 5%",  condition: { type: "return", operator: ">=", value: 5,  period: "1y" } },
    { label: "近1年 > 10%", condition: { type: "return", operator: ">=", value: 10, period: "1y" } },
    { label: "近1年 > 15%", condition: { type: "return", operator: ">=", value: 15, period: "1y" } },
    { label: "近1年 > 20%", condition: { type: "return", operator: ">=", value: 20, period: "1y" } },
  ]},
  { group: "近三年績效", items: [
    { label: "近3年 > 20%", condition: { type: "return", operator: ">=", value: 20, period: "3y" } },
    { label: "近3年 > 30%", condition: { type: "return", operator: ">=", value: 30, period: "3y" } },
    { label: "近3年 > 50%", condition: { type: "return", operator: ">=", value: 50, period: "3y" } },
  ]},
  { group: "年化波動度", items: [
    { label: "波動 < 10%", condition: { type: "volatility", operator: "<=", value: 10 } },
    { label: "波動 < 15%", condition: { type: "volatility", operator: "<=", value: 15 } },
    { label: "波動 < 20%", condition: { type: "volatility", operator: "<=", value: 20 } },
  ]},
];

// ── Task 7：範例條件（含條件清單，禁用推薦/建議/適合）────────
interface ExampleSet {
  name: string;
  icon: string;
  tags: string[];
  conditions: FilterCondition[];
}

const EXAMPLE_SETS: ExampleSet[] = [
  {
    name: "退休現金流",
    icon: "💰",
    tags: ["月配息", "配息率 > 6%", "波動度較低"],
    conditions: [
      { type: "distribution", operator: "==", value: "月配" },
      { type: "yield",        operator: ">=", value: 6 },
      { type: "volatility",   operator: "<=", value: 15 },
    ],
  },
  {
    name: "科技成長",
    icon: "🚀",
    tags: ["美國", "股票型", "科技"],
    conditions: [
      { type: "region",   operator: "==", value: "美國" },
      { type: "category", operator: "==", value: "股票型" },
      { type: "sector",   operator: "==", value: "科技" },
    ],
  },
  {
    name: "亞洲收益",
    icon: "🌏",
    tags: ["亞洲", "月配息", "股票型"],
    conditions: [
      { type: "region",       operator: "==", value: "亞洲" },
      { type: "distribution", operator: "==", value: "月配" },
      { type: "category",     operator: "==", value: "股票型" },
    ],
  },
  {
    name: "低波動債券",
    icon: "🛡️",
    tags: ["債券型", "波動 < 10%", "月配息"],
    conditions: [
      { type: "category",     operator: "==", value: "債券型" },
      { type: "volatility",   operator: "<=", value: 10 },
      { type: "distribution", operator: "==", value: "月配" },
    ],
  },
  {
    name: "台灣高股息",
    icon: "🏆",
    tags: ["台灣", "高股息", "配息率 > 5%"],
    conditions: [
      { type: "region",  operator: "==", value: "台灣" },
      { type: "sector",  operator: "==", value: "高股息" },
      { type: "yield",   operator: ">=", value: 5 },
    ],
  },
];

const FREE_LIMIT = 3;

// ── 即時符合數量 + Count Up ───────────────────────────────────
function LiveCount({ etf, fund, total }: { etf: number; fund: number; total: number }) {
  const animEtf   = useCountUp(etf);
  const animFund  = useCountUp(fund);
  const animTotal = useCountUp(total);

  return (
    <div className="flex items-center gap-6 bg-white border border-slate-200 rounded-2xl px-6 py-4 shadow-sm">
      <div className="text-center">
        <div className="text-[40px] font-black text-blue-600 leading-none tabular-nums">{animEtf}</div>
        <div className="text-[12px] text-slate-400 mt-1 font-semibold">檔 ETF</div>
      </div>
      <div className="text-slate-200 text-[24px] font-light">+</div>
      <div className="text-center">
        <div className="text-[40px] font-black text-amber-500 leading-none tabular-nums">{animFund}</div>
        <div className="text-[12px] text-slate-400 mt-1 font-semibold">檔基金</div>
      </div>
      <div className="text-slate-200 text-[24px] font-light">=</div>
      <div className="text-center">
        <div className="text-[40px] font-black text-[#0a1628] leading-none tabular-nums">{animTotal}</div>
        <div className="text-[12px] text-slate-400 mt-1 font-semibold">符合條件</div>
      </div>
    </div>
  );
}

// ── Main Export ────────────────────────────────────────────────
export function CriteriaBuilderSection() {
  const { favList, watchList, compareList, toggleFav, toggleWatch, toggleCompare, toast: wlToast } = useWatchlist();
  const [conditions, setConditions] = useState<FilterCondition[]>([]);
  const [results, setResults]       = useState<SearchResultItem[] | null>(null);
  const [showMenu, setShowMenu]     = useState(false);
  const [showPremium, setShowPremium] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 點擊外部關閉 menu
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // 即時計算（Task 2：multi-select 由 searchFromTags 的 OR/AND 邏輯處理）
  const liveCount = React.useMemo((): { etf: number; fund: number; total: number } => {
    if (conditions.length === 0) return { etf: 0, fund: 0, total: 0 };
    const r = searchFromTags(conditions, 300);
    return { etf: r.etfCount, fund: r.fundCount, total: r.total };
  }, [conditions]);

  // Task 2：Multi-select — 同分類 OR（允許同 type 多個）
  function addCondition(cond: FilterCondition) {
    const isSelected = conditions.some(c => c.type === cond.type && c.value === cond.value);
    if (isSelected) {
      // 取消選取
      setConditions(conditions.filter(c => !(c.type === cond.type && c.value === cond.value)));
      setResults(null);
      return;
    }
    if (conditions.length >= FREE_LIMIT) {
      setShowPremium(true);
      return;
    }
    // 同分類允許多選（OR within type）
    setConditions([...conditions, cond]);
    setResults(null);
  }

  function removeCondition(idx: number) {
    setConditions(conditions.filter((_, i) => i !== idx));
    setResults(null);
  }

  function applyExample(example: ExampleSet) {
    setConditions(example.conditions.slice(0, FREE_LIMIT));
    setResults(null);
    setShowResults(false);
    setShowMenu(false);
  }

  function doSearch() {
    if (conditions.length === 0) return;
    const qr = searchFromTags(conditions, 40);
    setResults(qr.items);
    setShowResults(true);
  }

  function clearAll() {
    setConditions([]);
    setResults(null);
    setShowPremium(false);
    setShowResults(false);
  }

  const etfResults  = results?.filter(r => r.type === "ETF")  ?? [];
  const fundResults = results?.filter(r => r.type === "基金") ?? [];

  return (
    <section className="relative z-10 py-24" style={{ backgroundColor: "#ffffff" }}>
      <div className="max-w-[1400px] mx-auto px-10">

        {/* ── Task 8+9：Section Header — 定位清楚 ── */}
        <div className="text-center mb-14">
          <div className="text-[13px] tracking-[10px] text-[#F5B700] font-semibold mb-4">
            INVESTMENT CRITERIA BUILDER
          </div>
          <h2 className="text-[40px] font-black text-[#0a1628] mb-4 leading-tight">
            建立屬於你的投資條件
          </h2>
          <p className="text-[18px] text-slate-500 max-w-[600px] mx-auto leading-relaxed">
            這不是一般篩選器。你建立的每一組條件，可以保存、隨時重新執行，
            讓市場幫你找出今天符合條件的 ETF 與基金。
          </p>
          {/* Task 9：三步驟流程提示 */}
          <div className="flex items-center justify-center gap-4 mt-8 text-[14px] text-slate-400">
            <span className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-[#F5B700] text-[#020817] text-[11px] font-black flex items-center justify-center">1</span>
              設定你的條件
            </span>
            <span className="text-slate-200">→</span>
            <span className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-[#F5B700] text-[#020817] text-[11px] font-black flex items-center justify-center">2</span>
              立即看到符合商品數
            </span>
            <span className="text-slate-200">→</span>
            <span className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-[#F5B700] text-[#020817] text-[11px] font-black flex items-center justify-center">3</span>
              保存條件，隨時重新執行
            </span>
          </div>
        </div>

        <div className="max-w-[960px] mx-auto">

          {/* ── Task 7：常用條件範例（上方，先給範例降低門檻）── */}
          {!showResults && (
            <div className="mb-8">
              <div className="text-[13px] text-slate-400 font-semibold tracking-wider mb-4 uppercase">
                條件範例 <span className="text-[11px] font-normal normal-case ml-1">點擊套用，再自行調整</span>
              </div>
              <div className="grid grid-cols-5 gap-3">
                {EXAMPLE_SETS.map((ex, i) => (
                  <button
                    key={i}
                    onClick={() => applyExample(ex)}
                    className="group bg-white border border-slate-200 text-left p-4 rounded-2xl hover:border-[#F5B700] hover:shadow-md transition-all"
                  >
                    <div className="text-[22px] mb-2">{ex.icon}</div>
                    <div className="text-[14px] font-bold text-[#0a1628] mb-2 leading-tight">{ex.name}</div>
                    <div className="space-y-1">
                      {ex.tags.map((tag) => (
                        <div key={tag} className="flex items-center gap-1.5 text-[11px] text-slate-500">
                          <span className="text-emerald-500 font-bold shrink-0">✓</span>
                          <span>{tag}</span>
                        </div>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
              <div className="mt-3 text-[11px] text-slate-400">
                以上為條件設定範例，非投資建議。請依自身需求自由調整。
              </div>
            </div>
          )}

          {/* ── 條件建立區 ── */}
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6 mb-6">

            {/* 已選條件 Tags */}
            <div className="flex flex-wrap gap-2 mb-5 min-h-[44px] items-center">
              {conditions.length === 0 && (
                <span className="text-[15px] text-slate-400">
                  從上方範例套用，或點「＋ 新增條件」開始建立你的條件...
                </span>
              )}
              {conditions.map((c: FilterCondition, i: number) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-2 bg-[#0a1628] text-white text-[13px] font-semibold px-3.5 py-1.5 rounded-full border border-white/10 hover:border-[#F5B700]/40 transition-all"
                >
                  <span className="text-[10px] text-white/40 uppercase tracking-wider">{typeLabel(c.type)}</span>
                  <span>{conditionToLabel(c)}</span>
                  <button
                    onClick={() => removeCondition(i)}
                    className="w-4 h-4 rounded-full bg-white/10 hover:bg-red-500/30 hover:text-red-300 flex items-center justify-center text-[11px] leading-none transition-all ml-0.5"
                  >×</button>
                </span>
              ))}
              {conditions.length >= FREE_LIMIT && (
                <span className="text-[12px] text-amber-600 font-semibold bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-full">
                  免費版最多 {FREE_LIMIT} 個條件
                </span>
              )}
            </div>

            {/* 操作列 */}
            <div className="flex items-center gap-3 flex-wrap">

              {/* 新增條件按鈕 + Dropdown */}
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setShowMenu(!showMenu)}
                  className="flex items-center gap-2 bg-white border border-slate-200 text-[#0a1628] text-[15px] font-semibold px-5 py-2.5 rounded-xl hover:border-[#F5B700] hover:shadow-sm transition-all"
                >
                  <span className="text-[18px] text-[#F5B700]">＋</span> 新增條件
                </button>

                {showMenu && (
                  <div className="absolute top-full left-0 mt-2 w-[340px] bg-white border border-slate-100 rounded-2xl shadow-2xl z-50 max-h-[480px] overflow-y-auto">
                    {/* Task 2：多選提示 */}
                    <div className="px-4 pt-3 pb-2 border-b border-slate-50">
                      <div className="text-[11px] text-slate-400">
                        同一分類可多選（OR）・不同分類自動 AND
                      </div>
                    </div>
                    {CONDITION_MENU.map(group => (
                      <div key={group.group}>
                        <div className="px-4 py-2 text-[11px] font-bold text-slate-400 tracking-[3px] bg-slate-50 border-b border-slate-100">
                          {group.group}
                        </div>
                        <div className="p-2 flex flex-wrap gap-1.5">
                          {group.items.map(item => {
                            const isActive = conditions.some(c =>
                              c.type === item.condition.type && c.value === item.condition.value
                            );
                            return (
                              <button
                                key={item.label}
                                onClick={() => addCondition(item.condition)}
                                className={`text-[13px] px-3 py-1.5 rounded-lg font-semibold transition-colors ${
                                  isActive
                                    ? "bg-[#0a1628] text-white"
                                    : "bg-slate-100 text-slate-700 hover:bg-[#F5B700]/10 hover:text-[#b38600]"
                                }`}
                              >
                                {isActive ? "✓ " : ""}{item.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    <div className="p-3 border-t border-slate-100 text-center">
                      <button onClick={() => setShowMenu(false)} className="text-[13px] text-slate-400 hover:text-slate-600">關閉</button>
                    </div>
                  </div>
                )}
              </div>

              {conditions.length > 0 && (
                <button
                  onClick={clearAll}
                  className="text-[14px] text-slate-400 hover:text-slate-600 transition-colors"
                >
                  清除全部
                </button>
              )}

              <div className="flex-1" />

              {/* Task 3：Count Up 大數字 */}
              {conditions.length > 0 && (
                <LiveCount etf={liveCount.etf} fund={liveCount.fund} total={liveCount.total} />
              )}

              <button
                onClick={doSearch}
                disabled={conditions.length === 0}
                className="bg-[#F5B700] hover:bg-[#e0a800] disabled:bg-slate-200 disabled:text-slate-400 text-[#020817] px-8 py-3 rounded-xl font-black text-[16px] transition-colors shadow-sm"
              >
                查看符合商品
              </button>
            </div>
          </div>

          {/* Premium 提示 */}
          {showPremium && (
            <div className="mb-6 bg-amber-50 border border-amber-200 rounded-2xl p-5 flex items-center justify-between">
              <div>
                <div className="text-[15px] font-bold text-amber-800 mb-1">
                  🔒 已達免費版條件上限（{FREE_LIMIT} 個）
                </div>
                <div className="text-[14px] text-amber-700">
                  升級 Premium 可使用最多 20 個條件，並儲存不限組數的投資條件。
                </div>
              </div>
              <Link
                href="/pricing"
                className="ml-4 bg-[#F5B700] hover:bg-[#e0a800] text-[#020817] px-5 py-2 rounded-xl font-bold text-[14px] transition-colors shrink-0"
              >
                查看方案
              </Link>
            </div>
          )}
        </div>

        {/* ── Task 4：搜尋結果（共用 ProductCard）── */}
        {showResults && results !== null && (
          <div className="mt-10 max-w-[1400px]">
            <div className="flex items-center justify-between mb-8">
              <div>
                <div className="text-[20px] font-bold text-[#0a1628]">
                  符合你的條件
                  <span className="mx-2 text-[#b38600] font-black text-[28px]">{results.length}</span>
                  <span className="text-[17px] text-slate-500">筆商品</span>
                </div>
                <div className="text-[13px] text-slate-400 mt-1">
                  條件：{conditions.map(conditionToLabel).join(" ＋ ")}
                </div>
              </div>
              <button
                onClick={clearAll}
                className="text-[14px] text-slate-500 border border-slate-200 px-4 py-2 rounded-lg hover:border-slate-400 transition-colors"
              >
                重新設定
              </button>
            </div>

            {results.length === 0 && (
              <div className="text-center py-16 text-slate-400">
                <div className="text-[48px] mb-4">🔍</div>
                <div className="text-[18px] font-semibold mb-2">找不到符合條件的商品</div>
                <div className="text-[15px]">請嘗試放寬條件，例如降低殖利率門檻或移除部分條件</div>
              </div>
            )}

            {etfResults.length > 0 && (
              <div className="mb-12">
                <div className="flex items-center gap-3 mb-5">
                  <div className="text-[18px] font-bold text-[#0a1628]">ETF</div>
                  <div className="text-[14px] text-slate-400 bg-slate-100 px-2.5 py-0.5 rounded-full">{etfResults.length} 檔</div>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {etfResults.slice(0, 8).map(item => (
                    <ProductCard
                      key={item.id}
                      item={item}
                      favList={favList}
                      watchList={watchList}
                      compareList={compareList}
                      onFav={(i: SearchResultItem) => toggleFav({ id: i.code || i.id, type: "etf", name: i.name })}
                      onWatch={(i: SearchResultItem) => toggleWatch({ id: i.code || i.id, type: "etf", name: i.name })}
                      onCompare={(i: SearchResultItem) => toggleCompare({ id: i.code || i.id, type: "etf", name: i.name })}
                    />
                  ))}
                </div>
                {etfResults.length > 8 && (
                  <div className="mt-5 text-center">
                    <Link href="/etf" className="text-[14px] text-[#b38600] hover:underline font-semibold">
                      查看全部 {etfResults.length} 檔 ETF →
                    </Link>
                  </div>
                )}
              </div>
            )}

            {fundResults.length > 0 && (
              <div className="mb-6">
                <div className="flex items-center gap-3 mb-5">
                  <div className="text-[18px] font-bold text-[#0a1628]">基金</div>
                  <div className="text-[14px] text-slate-400 bg-slate-100 px-2.5 py-0.5 rounded-full">{fundResults.length} 檔</div>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {fundResults.slice(0, 8).map(item => (
                    <ProductCard
                      key={item.id}
                      item={item}
                      favList={favList}
                      watchList={watchList}
                      compareList={compareList}
                      onFav={(i: SearchResultItem) => toggleFav({ id: i.code || i.id, type: "fund", name: i.name })}
                      onWatch={(i: SearchResultItem) => toggleWatch({ id: i.code || i.id, type: "fund", name: i.name })}
                      onCompare={(i: SearchResultItem) => toggleCompare({ id: i.code || i.id, type: "fund", name: i.name })}
                    />
                  ))}
                </div>
                {fundResults.length > 8 && (
                  <div className="mt-5 text-center">
                    <Link href="/funds" className="text-[14px] text-[#b38600] hover:underline font-semibold">
                      查看全部 {fundResults.length} 檔基金 →
                    </Link>
                  </div>
                )}
              </div>
            )}

            {/* Task 8：轉換流程 CTA — 保存條件 */}
            {results.length > 0 && (
              <div className="mt-10 border border-[#F5B700]/30 bg-amber-50/50 rounded-2xl p-7 flex items-center justify-between">
                <div>
                  <div className="text-[17px] font-bold text-[#0a1628] mb-1">
                    想保存這組條件，下次一鍵重新執行？
                  </div>
                  <div className="text-[14px] text-slate-500">
                    建立帳號後，你的投資條件永久保存。市場更新，條件不用重設。
                  </div>
                </div>
                <Link
                  href="/quiz"
                  className="ml-6 shrink-0 bg-[#F5B700] hover:bg-[#e0a800] text-[#020817] px-7 py-3 rounded-xl font-black text-[15px] transition-colors"
                >
                  建立帳號，保存條件 →
                </Link>
              </div>
            )}

            <div className="text-[12px] text-slate-400 border-t border-slate-100 pt-5 mt-6">
              以上為依您設定條件篩選出的商品，非投資建議。過去績效不代表未來表現，請自行評估風險。
            </div>
          </div>
        )}
      </div>

      {wlToast && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[999] bg-[#1a2540] text-white text-[14px] font-semibold px-6 py-3 rounded-full shadow-xl">
          {wlToast}
        </div>
      )}
    </section>
  );
}