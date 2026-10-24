// 2026-10-24（使用者核准）: 這個頁面是多層訂閱方案（免費/Lite/Pro/Advisor/Team）的理專CRM
// 定價頁，跟目前「付費機制只做在App」的決定直接矛盾，內容也像未完成的原型文案（獨立驗收代理
// 發現）。原始程式碼保留在 _archived-page.tsx，沒有刪除，只是這個路由直接導回首頁，不再對外
// 顯示入口。
import { redirect } from "next/navigation";

export default function PricingPage() {
  redirect("/");
}
