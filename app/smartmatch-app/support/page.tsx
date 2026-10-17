import type { Metadata } from "next";
import Link from "next/link";
import { H1, H2, Mail, P, UL } from "@/components/twpuzzle/LegalUi";

export const metadata: Metadata = {
  title: "SmartMatch App 支援與聯絡｜瑞宇智庫有限公司",
  description: "「SmartMatch」App 的使用支援、帳號與訂閱管理、聯絡方式。",
};

// 2026-10-17：App Store／Google Play 的「支援網址」。
export default function SmartMatchAppSupportPage() {
  return (
    <article>
      <H1>「SmartMatch」支援與聯絡</H1>
      <P>「SmartMatch」整理股票、ETF、基金的公開市場資料，提供反查、比較、投資組合穿透、排行與配息資訊等功能，與 smartmatchpilot.com 網站共用同一套會員帳號。本 App 僅提供資訊整理與試算，不構成任何投資建議。</P>

      <H2>聯絡我們</H2>
      <P>電子郵件：<Mail /></P>
      <P>來信時請寫上手機型號、系統版本、App 版本，以及發生問題的畫面，我們會盡快回覆。</P>

      <H2>常見問題</H2>
      <UL>
        <li><strong>一定要登入嗎？</strong>瀏覽市場資料不需要登入；提醒通知、訂閱等功能需要用 Google 或 Apple 帳戶登入。</li>
        <li><strong>我的自選清單／投資組合會不會同步到別的裝置？</strong>目前自選清單、投資組合、現金流記帳、比較草稿只存在單一裝置本機，換裝置或重新安裝 App 不會自動帶過去。</li>
        <li><strong>資料多久更新？</strong>各頁面都會標示資料日期或時間；市場行情、持股、配息等各自依交易所、集保結算所、投信投顧公會、各投信公司公布的時間更新。</li>
        <li><strong>怎麼訂閱或取消？</strong>在 App 內的訂閱頁面購買；取消方式：iPhone 在「設定 › Apple ID › 訂閱」，Android 在 Google Play「付款與訂閱 › 訂閱」。</li>
        <li><strong>換手機後訂閱不見了？</strong>用同一個會員帳號（Google 或 Apple）登入，訂閱狀態會重新對應回來；如仍異常請聯絡我們。</li>
        <li><strong>收不到通知？</strong>確認 App 的通知設定與手機系統設定都已開啟本 App 的通知。</li>
        <li><strong>想刪除帳號或個人資料？</strong>在 App「登入 / 會員」頁按「刪除帳號」，或參見<Link href="/smartmatch-app/privacy" className="text-sky-300 underline underline-offset-4">隱私權政策</Link>第六點。</li>
      </UL>

      <H2>相關文件</H2>
      <UL>
        <li><Link href="/smartmatch-app/privacy" className="text-sky-300 underline underline-offset-4">隱私權政策</Link></li>
        <li><Link href="/smartmatch-app/terms" className="text-sky-300 underline underline-offset-4">使用條款</Link></li>
      </UL>
      <P>瑞宇智庫有限公司 RUI YU THINK TANK LIMITED</P>
    </article>
  );
}
