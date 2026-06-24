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
      <body className="min-h-screen bg-[#040a18]">
        {children}
      </body>
    </html>
  );
}