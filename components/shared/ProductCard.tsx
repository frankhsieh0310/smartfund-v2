"use client";
// ============================================================
// components/shared/ProductCard.tsx
// SmartMatch 共用商品卡片
// 首頁搜尋結果、ETF頁、基金頁 全部共用
// 禁止各頁面另外寫 Card
// ============================================================

import { type SearchResultItem } from "@/lib/engines/filterEngine";
import { type ListItem } from "@/lib/hooks/useWatchlist";

interface ProductCardProps {
  item: SearchResultItem;
  favList: ListItem[];
  watchList: ListItem[];
  compareList: ListItem[];
  onFav: (item: SearchResultItem) => void;
  onWatch: (item: SearchResultItem) => void;
  onCompare: (item: SearchResultItem) => void;
}

export function ProductCard({
  item, favList, watchList, compareList,
  onFav, onWatch, onCompare,
}: ProductCardProps) {
  const isEtf   = item.type === "ETF";
  const isFav   = favList.some(i => i.id === (isEtf ? item.code : item.id));
  const isWatch = watchList.some(i => i.id === (isEtf ? item.code : item.id));
  const isCmp   = compareList.some(i => i.id === (isEtf ? item.code : item.id));

  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-5 hover:shadow-md hover:border-[#F5B700]/30 transition-all">
      {/* 頂部：類型 + 晨星 + 近1年績效 */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
              isEtf ? "bg-blue-50 text-blue-600" : "bg-amber-50 text-amber-700"
            }`}>
              {item.type}
            </span>
            {item.morningstar && (
              <span className="text-[12px] text-[#b38600]">{"★".repeat(item.morningstar)}</span>
            )}
          </div>
          <div className="text-[15px] font-bold text-[#0a1628]">
            {isEtf ? item.code : item.company}
          </div>
          <div className="text-[13px] text-slate-500 mt-0.5 line-clamp-1">{item.name}</div>
        </div>
        <div className="text-right shrink-0 ml-3">
          <div className={`text-[20px] font-black ${item.return1y >= 0 ? "text-emerald-600" : "text-red-500"}`}>
            {item.return1y >= 0 ? "+" : ""}{item.return1y.toFixed(1)}%
          </div>
          <div className="text-[11px] text-slate-400">近1年</div>
        </div>
      </div>

      {/* 中部：配息率 + 近1月 + 波動度 */}
      <div className="grid grid-cols-3 gap-2 pt-3 border-t border-slate-50 mb-3">
        <div className="text-center">
          <div className="text-[14px] font-semibold text-[#b38600]">
            {item.dividendYield > 0 ? `${item.dividendYield.toFixed(1)}%` : "—"}
          </div>
          <div className="text-[11px] text-slate-400">配息率</div>
        </div>
        <div className="text-center">
          <div className={`text-[14px] font-semibold ${item.return1m >= 0 ? "text-emerald-600" : "text-red-500"}`}>
            {item.return1m >= 0 ? "+" : ""}{item.return1m.toFixed(1)}%
          </div>
          <div className="text-[11px] text-slate-400">近1月</div>
        </div>
        <div className="text-center">
          <div className="text-[14px] font-semibold text-slate-600">{item.volatility.toFixed(1)}%</div>
          <div className="text-[11px] text-slate-400">波動度</div>
        </div>
      </div>

      {/* 底部：操作按鈕 */}
      <div className="flex items-center gap-1.5 pt-2 border-t border-slate-50">
        <button
          onClick={() => onFav(item)}
          title={isFav ? "取消收藏" : "加入收藏"}
          className={`flex-1 py-1.5 rounded-lg text-[12px] font-semibold transition-all flex items-center justify-center gap-1 ${
            isFav
              ? "bg-[#F5B700]/10 text-[#b38600]"
              : "bg-slate-50 text-slate-400 hover:bg-[#F5B700]/10 hover:text-[#b38600]"
          }`}
        >
          ⭐ {isFav ? "已收藏" : "收藏"}
        </button>
        <button
          onClick={() => onWatch(item)}
          title={isWatch ? "移除觀察" : "加入觀察"}
          className={`flex-1 py-1.5 rounded-lg text-[12px] font-semibold transition-all flex items-center justify-center gap-1 ${
            isWatch
              ? "bg-blue-50 text-blue-600"
              : "bg-slate-50 text-slate-400 hover:bg-blue-50 hover:text-blue-600"
          }`}
        >
          👀 {isWatch ? "觀察中" : "觀察"}
        </button>
        <button
          onClick={() => onCompare(item)}
          title={isCmp ? "移除比較" : "加入比較"}
          className={`flex-1 py-1.5 rounded-lg text-[12px] font-semibold transition-all flex items-center justify-center gap-1 ${
            isCmp
              ? "bg-emerald-50 text-emerald-600"
              : "bg-slate-50 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600"
          }`}
        >
          📊 {isCmp ? "比較中" : "比較"}
        </button>
      </div>
    </div>
  );
}