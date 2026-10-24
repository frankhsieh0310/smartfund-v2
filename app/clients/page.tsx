// 2026-10-24（使用者核准）: 這個頁面是完全不同的「理專/客戶管理 CRM」產品樣貌，跟目前
// 「SmartMatch 是投資條件管理平台」的方向直接矛盾（獨立驗收代理發現，同一個網域上出現多種
// 不一致的品牌/產品敘事）。原始程式碼保留在 _archived-page.tsx，沒有刪除，只是這個路由直接
// 導回首頁，不再對外顯示入口。
import { redirect } from "next/navigation";

export default function ClientsPage() {
  redirect("/");
}
