"use client";
// ============================================================
// components/shared/Toast.tsx
// SmartMatch 共用 Toast 通知元件
// 所有頁面共用，禁止各頁面重複定義
// ============================================================

import { useEffect } from "react";

interface ToastProps {
  msg: string;
  onClose: () => void;
}

export function Toast({ msg, onClose }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(onClose, 2000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[999] bg-[#1a2540] border border-white/20 text-white text-[14px] font-semibold px-6 py-3 rounded-full shadow-xl">
      {msg}
    </div>
  );
}
