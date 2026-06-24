import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SmartMatch｜ETF & 基金資產配置分析平台",
  description: "投資人格分析、ETF篩選、基金篩選、資產配置規劃，一站完成。",
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
          {/* 底圖：brightness(0.55) → 大樓清楚可辨識 */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage:
                "url('https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=2600')",
              backgroundSize: "cover",
              backgroundPosition: "center",
              filter: "brightness(0.55)",
            }}
          />
          {/* 深藍遮罩：從 0.68 降到 0.45，讓大樓透出來 */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "linear-gradient(180deg, rgba(2,8,23,0.45) 0%, rgba(2,8,23,0.55) 100%)",
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