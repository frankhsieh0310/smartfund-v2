"use client";
// ============================================================
// components/shared/Pct.tsx
// SmartMatch 共用百分比顯示元件（漲跌顏色）
// ETF頁、基金頁、首頁共用，禁止各頁面重複定義
// ============================================================

interface PctProps {
  v: number;
}

export function Pct({ v }: PctProps) {
  return (
    <span className={`font-semibold ${v >= 0 ? "text-emerald-400" : "text-red-400"}`}>
      {v >= 0 ? "+" : ""}{v.toFixed(1)}%
    </span>
  );
}
