import type { Metadata } from "next";
import Link from "next/link";
import { H1, H2, Mail, P, UL } from "@/components/twpuzzle/LegalUi";

export const metadata: Metadata = {
  title: "刪除帳號申請｜SmartMatch App｜瑞宇智庫有限公司",
  description: "如何刪除「SmartMatch」App 的會員帳號與資料，包含未安裝 App 時的申請方式。",
};

// 2026-11-13：Google Play 資料安全規定要求的「帳號刪除」公開網頁（即使主要刪除入口在 App 內，
// 也要有一個不需要安裝 App 就能看到、申請刪除的網址）。內容跟隱私權政策第六點的事實一致，
// 只是獨立成一頁、把Google要求的幾項都講清楚：刪什麼、怎麼刪、要多久、保留什麼。
export default function SmartMatchAppDeleteAccountPage() {
  return (
    <article>
      <H1>刪除帳號申請</H1>
      <P>
        「SmartMatch」App 與我們的「台股拼圖」App 共用同一套登入帳號（Google／Apple／Email
        驗證碼登入）。<strong>刪除這個帳號會同時刪除兩個 App 的帳號與底下所有資料，無法復原</strong>
        ——包含投資組合、提醒規則、自選清單同步資料、推播裝置、訂閱對應紀錄、討論區發文等。
      </P>

      <H2>刪除前請先確認</H2>
      <UL>
        <li>
          <strong>刪除帳號不會自動取消訂閱。</strong>
          請先到 iPhone「設定 › Apple ID › 訂閱」或 Android「Google Play › 付款與訂閱 › 訂閱」
          取消訂閱，再刪除帳號；否則訂閱可能仍會繼續扣款。
        </li>
        <li>
          自選清單、投資組合、現金流記帳、比較草稿是存在<strong>裝置本機</strong>的資料，刪除帳號
          不會清除它們，需要另外在 App 內清除，或刪除／重新安裝 App。
        </li>
        <li>刪除後無法復原，也無法用同一個信箱找回原本的資料。</li>
      </UL>

      <H2>方法一：在 App 內刪除（建議）</H2>
      <P>
        打開「SmartMatch」App（或「台股拼圖」App）→「登入 / 會員」頁 → 按「刪除帳號」→
        確認。系統會立即刪除您的登入身份與資料庫中的會員資料。
      </P>

      <H2>方法二：沒有安裝 App，或無法登入時申請</H2>
      <P>
        請寄信到 <Mail />，主旨註明「刪除帳號申請」，信件內容請包含：
      </P>
      <UL>
        <li>您註冊時使用的登入方式（Google／Apple／Email）與對應的帳號或信箱</li>
        <li>您使用的 App（SmartMatch 或台股拼圖）</li>
      </UL>
      <P>
        我們會先核對您是否為帳號本人，核對後將在 <strong>14 個工作日內</strong>
        完成刪除，並回信通知您。
      </P>

      <H2>刪除會處理哪些資料</H2>
      <UL>
        <li>登入身份（Google／Apple／Email 驗證碼對應的帳號識別碼）</li>
        <li>會員資料：提醒規則、推播裝置、訂閱對應紀錄</li>
        <li>討論區發文、檢舉、封鎖等互動紀錄</li>
        <li>伺服器端記錄的投資組合、問卷等（若您曾在任一裝置登入後同步使用過）</li>
      </UL>
      <P>
        依法令要求必須保留的紀錄（例如交易爭議處理、法律義務所需的最低限度資料）會依法定期限保留，
        期限屆滿後刪除；不會用於其他用途。
      </P>

      <H2>相關文件</H2>
      <UL>
        <li>
          <Link href="/smartmatch-app/privacy" className="text-sky-300 underline underline-offset-4">
            隱私權政策
          </Link>
        </li>
        <li>
          <Link href="/smartmatch-app/terms" className="text-sky-300 underline underline-offset-4">
            使用條款
          </Link>
        </li>
        <li>
          <Link href="/smartmatch-app/support" className="text-sky-300 underline underline-offset-4">
            支援與聯絡
          </Link>
        </li>
      </UL>
      <P>瑞宇智庫有限公司 RUI YU THINK TANK LIMITED</P>
    </article>
  );
}
