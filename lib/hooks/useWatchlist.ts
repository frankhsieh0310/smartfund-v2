// ============================================================
// lib/hooks/useWatchlist.ts
// SmartMatch 共用收藏 / 觀察 / 比較 Hook
//
// 規格：
//   localStorage keys: "favorites" | "watchlist" | "compareList"
//   首頁 / ETF頁 / 基金頁 全部共用同一套
//   任何地方操作，全部同步
// ============================================================

"use client";

import { useState, useEffect, useCallback } from "react";

// ── 型別 ──────────────────────────────────────────────────────
export type ItemType = "etf" | "fund";

export interface ListItem {
  id:   string;        // ETF code 或 fund id
  type: ItemType;
  name: string;
}

// ── localStorage keys（全域唯一，禁止在其他地方重新定義）────
export const KEY_FAV     = "favorites";
export const KEY_WATCH   = "watchlist";
export const KEY_COMPARE = "compareList";
export const MAX_COMPARE = 5;

// ── 底層讀寫 ─────────────────────────────────────────────────
export function loadList(key: string): ListItem[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; }
}

export function saveList(key: string, list: ListItem[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, JSON.stringify(list));
}

export function hasItem(list: ListItem[], id: string): boolean {
  return list.some(i => i.id === id);
}

export function toggleItem(list: ListItem[], item: ListItem): ListItem[] {
  return hasItem(list, item.id)
    ? list.filter(i => i.id !== item.id)
    : [...list, item];
}

// ── 主 Hook ───────────────────────────────────────────────────
export function useWatchlist(filterType?: ItemType) {
  const [favList,     setFavList]     = useState<ListItem[]>([]);
  const [watchList,   setWatchList]   = useState<ListItem[]>([]);
  const [compareList, setCompareList] = useState<ListItem[]>([]);
  const [toast,       setToast]       = useState<string | null>(null);

  // 初始載入
  useEffect(() => {
    const fav  = loadList(KEY_FAV);
    const watch = loadList(KEY_WATCH);
    const cmp   = loadList(KEY_COMPARE);
    setFavList(filterType ? fav.filter(i => i.type === filterType) : fav);
    setWatchList(filterType ? watch.filter(i => i.type === filterType) : watch);
    setCompareList(cmp);
  }, [filterType]);

  // 同步其他 tab 的 storage 變更（跨頁同步）
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === KEY_FAV)     setFavList(filterType ? loadList(KEY_FAV).filter(i => i.type === filterType) : loadList(KEY_FAV));
      if (e.key === KEY_WATCH)   setWatchList(filterType ? loadList(KEY_WATCH).filter(i => i.type === filterType) : loadList(KEY_WATCH));
      if (e.key === KEY_COMPARE) setCompareList(loadList(KEY_COMPARE));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [filterType]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }, []);

  // ── 收藏 ────────────────────────────────────────────────────
  const toggleFav = useCallback((item: ListItem) => {
    const all  = loadList(KEY_FAV);
    const next = toggleItem(all, item);
    saveList(KEY_FAV, next);
    setFavList(filterType ? next.filter(i => i.type === filterType) : next);
    showToast(hasItem(all, item.id) ? "已移除收藏" : "已加入收藏 ⭐");
  }, [filterType, showToast]);

  // ── 觀察 ────────────────────────────────────────────────────
  const toggleWatch = useCallback((item: ListItem) => {
    const all  = loadList(KEY_WATCH);
    const next = toggleItem(all, item);
    saveList(KEY_WATCH, next);
    setWatchList(filterType ? next.filter(i => i.type === filterType) : next);
    showToast(hasItem(all, item.id) ? "已移除觀察名單" : "已加入觀察名單 👀");
  }, [filterType, showToast]);

  // ── 比較 ────────────────────────────────────────────────────
  const toggleCompare = useCallback((item: ListItem) => {
    const all = loadList(KEY_COMPARE);
    if (hasItem(all, item.id)) {
      const next = all.filter(i => i.id !== item.id);
      saveList(KEY_COMPARE, next);
      setCompareList(next);
      showToast("已移除比較");
    } else {
      if (all.length >= MAX_COMPARE) {
        showToast(`比較最多 ${MAX_COMPARE} 檔`);
        return;
      }
      const next = [...all, item];
      saveList(KEY_COMPARE, next);
      setCompareList(next);
      showToast("已加入比較 📊");
    }
  }, [showToast]);

  const clearCompare = useCallback(() => {
    saveList(KEY_COMPARE, []);
    setCompareList([]);
  }, []);

  return {
    favList, watchList, compareList,
    toggleFav, toggleWatch, toggleCompare, clearCompare,
    toast, showToast,
    hasItem,
  };
}