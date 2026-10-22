"use client";

import { useEffect } from "react";

const STORAGE_KEY = "smartmatch-language";
const languages = ["台灣繁體中文", "English", "日本語", "한국어"] as const;

export function HomeLanguageSelector() {
  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) localStorage.setItem(STORAGE_KEY, "zh-TW");
  }, []);

  return (
    <details className="relative">
      <summary className="cursor-pointer list-none whitespace-nowrap">◎ 台灣繁體中文⌄</summary>
      <div className="absolute right-0 top-8 z-50 w-48 rounded-lg border border-[#36536b] bg-[#0b2135] p-2 shadow-xl">
        {languages.map((language, index) => (
          <button
            key={language}
            type="button"
            disabled={index !== 0}
            onClick={() => localStorage.setItem(STORAGE_KEY, "zh-TW")}
            className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-[13px] ${index === 0 ? "text-[#f0bf65] hover:bg-white/5" : "cursor-not-allowed text-slate-500"}`}
          >
            <span>{language}</span>
            <small>{index === 0 ? "使用中" : "即將推出"}</small>
          </button>
        ))}
      </div>
    </details>
  );
}
