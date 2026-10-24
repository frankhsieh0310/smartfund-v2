// 2026-10-24: 全頁都是未接線的佔位畫面（假篩選條件、「資料尚未接線」、「DATA PENDING」），
// 違反「沒有假資料或佔位數字」規則；原始碼保留在 _archived-page.tsx，不刪除。
import { redirect } from "next/navigation";

export default function ScreenerPage() {
  redirect("/");
}
