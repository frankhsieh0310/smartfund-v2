import type { Metadata } from "next";
import Link from "next/link";
import { H1, H2, Mail, P, UL } from "@/components/twpuzzle/LegalUi";

export const metadata: Metadata = {
  title: "台股拼圖 支援與聯絡｜瑞宇智庫有限公司",
  description: "「台股拼圖」App 的使用支援、訂閱管理與聯絡方式。",
};

// 2026-10-16：App Store／Google Play 的「支援網址」。
export default function TwPuzzleSupportPage() {
  return (
    <article>
      <H1>「台股拼圖」支援與聯絡</H1>
      <P>「台股拼圖」整理台灣 ETF 持股、配息與公開資訊，讓你查出哪些 ETF 持有一檔股票、持股怎麼變化，以及除息日與最後買進日。本 App 僅提供資訊，不構成任何投資建議。</P>

      <H2>聯絡我們</H2>
      <P>電子郵件：<Mail /></P>
      <P>來信時請寫上手機型號、系統版本、App 版本，以及發生問題的畫面，我們會盡快回覆。</P>

      <H2>常見問題</H2>
      <UL>
        <li><strong>需要註冊嗎？</strong>不需要，所有功能都不用登入。自選、持股穿透與記帳只存在你的手機上。</li>
        <li><strong>資料多久更新？</strong>各頁面都會標示資料日期。ETF 持股以投信公布為準，收盤行情以交易所與櫃買中心公布為準。</li>
        <li><strong>怎麼訂閱或取消 Pro？</strong>在 App「升級 Pro」頁訂閱。取消：iPhone 在「設定 › Apple ID › 訂閱」，Android 在 Google Play「付款與訂閱 › 訂閱」。</li>
        <li><strong>換手機後 Pro 不見了？</strong>用同一個 Apple ID 或 Google 帳號登入商店，在 App「升級 Pro」頁或「我的 › 會員方案」按「恢復購買」。</li>
        <li><strong>收不到通知？</strong>確認 App「通知設定」與手機系統設定都已開啟本 App 的通知。</li>
        <li><strong>想刪除伺服器上的資料？</strong>請見<Link href="/twpuzzle/privacy" className="text-sky-300 underline underline-offset-4">隱私權政策</Link>第六點。</li>
      </UL>

      <H2>相關文件</H2>
      <UL>
        <li><Link href="/twpuzzle/privacy" className="text-sky-300 underline underline-offset-4">隱私權政策</Link></li>
        <li><Link href="/twpuzzle/terms" className="text-sky-300 underline underline-offset-4">使用條款</Link></li>
      </UL>
      <P>瑞宇智庫有限公司 RUI YU THINK TANK LIMITED</P>
    </article>
  );
}
