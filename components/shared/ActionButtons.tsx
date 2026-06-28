"use client";
// ============================================================
// components/shared/ActionButtons.tsx
// SmartMatch 共用收藏 / 觀察 / 比較按鈕組
// ETF頁、基金頁共用，禁止各頁面重複定義
// ============================================================

import { hasItem, type ListItem } from "@/lib/hooks/useWatchlist";

interface ActionButtonsProps {
  id: string;
  name: string;
  type: "etf" | "fund";
  favList: ListItem[];
  watchList: ListItem[];
  compareList: ListItem[];
  onFav: (item: ListItem) => void;
  onWatch: (item: ListItem) => void;
  onCompare: (item: ListItem) => void;
  size?: "sm" | "md";
}

export function ActionButtons({
  id, name, type,
  favList, watchList, compareList,
  onFav, onWatch, onCompare,
  size = "md",
}: ActionButtonsProps) {
  const isFav     = hasItem(favList, id);
  const isWatch   = hasItem(watchList, id);
  const isCompare = hasItem(compareList, id);
  const dim = size === "sm" ? "w-7 h-7 text-[13px]" : "w-8 h-8 text-[14px]";
  const item: ListItem = { id, type, name };

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => onFav(item)}
        title={isFav ? "取消收藏" : "加入收藏"}
        className={`${dim} rounded-lg flex items-center justify-center transition-all ${
          isFav
            ? "bg-[#F5B700]/20 text-[#F5B700]"
            : "bg-white/[0.04] text-slate-500 hover:bg-[#F5B700]/10 hover:text-[#F5B700]"
        }`}
      >
        ⭐
      </button>
      <button
        onClick={() => onWatch(item)}
        title={isWatch ? "從觀察移除" : "加入觀察名單"}
        className={`${dim} rounded-lg flex items-center justify-center transition-all ${
          isWatch
            ? "bg-blue-500/20 text-blue-400"
            : "bg-white/[0.04] text-slate-500 hover:bg-blue-500/10 hover:text-blue-400"
        }`}
      >
        👀
      </button>
      <button
        onClick={() => onCompare(item)}
        title={isCompare ? "從比較移除" : "加入比較"}
        className={`${dim} rounded-lg flex items-center justify-center transition-all ${
          isCompare
            ? "bg-emerald-500/20 text-emerald-400"
            : "bg-white/[0.04] text-slate-500 hover:bg-emerald-500/10 hover:text-emerald-400"
        }`}
      >
        📊
      </button>
    </div>
  );
}
