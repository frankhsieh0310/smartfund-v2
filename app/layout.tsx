import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SmartMatch｜建立你的投資條件，找出符合的 ETF 與基金",
  description: "建立、保存、管理、重複使用你自己的投資條件。SmartMatch 是投資條件管理平台，不是 ETF 網站，不是基金網站。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-TW">
      <body className="min-h-screen" style={{ backgroundColor: "#020817" }}>

        {/* ── GlobalBackground：全站統一金融商辦大樓背景 ── */}
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 0,
            pointerEvents: "none",
          }}
        >
          {/* 底圖：brightness(0.72) → 大樓清楚可辨識，Task 1 */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage:
                "url('https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=2600')",
              backgroundSize: "cover",
              backgroundPosition: "center",
              filter: "brightness(0.72)",
            }}
          />
          {/* 深藍遮罩：降低至 0.30，讓大樓更清晰透出 */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "linear-gradient(180deg, rgba(2,8,23,0.30) 0%, rgba(2,8,23,0.40) 100%)",
            }}
          />
        </div>

        {/* 所有頁面內容在 z-10，永遠在背景上層 */}
        <div style={{ position: "relative", zIndex: 10 }}>
          {children}
        </div>

      </body>
    </html>
  );
}