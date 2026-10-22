// Shared, hand-rolled presentational primitives for 大佬雷達 V1 — mobile-first (App 內頁面，非獨立桌機
//網站）。設計寬度基準 390~430px，單欄、無 hover 依賴、tap target 以 44px 為底線。深藍＋金色沿用既有
// SmartMatch 品牌色（與 components/movement-radar/MovementRadar.tsx 相同色值）。
import Link from "next/link";
import type { Direction, Person } from "./mockData";
import { DIRECTION_LABEL } from "./mockData";

// 外層最大寬度卡在手機尺寸（約 430px）並置中 — 在真機上會吃滿螢幕寬度，在桌機瀏覽器預覽時也會呈現成
// 一欄「手機畫面」而不是鋪滿整個桌機寬度，避免被誤判成桌機版型。
export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-[#061728] text-[#f7f3e8]">
      <div className="mx-auto max-w-[430px] px-4 py-5">{children}</div>
    </main>
  );
}

// 每則觀點的理由/方向全為虛構，但姓名/機構/職稱為真實公眾人物與機構 —
// 這行揭露必須在每一頁都看得到，避免被誤認為真實言論。
export function MockDisclaimer() {
  return (
    <p className="mt-2 text-[10.5px] leading-4 text-slate-600">
      本頁為 UI 示意用的模擬資料，人物與機構為真實公開身分，但觀點內容、方向與時間皆為虛構，非其本人或機構之實際言論。
    </p>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-[#e9be6e]">
      <span>◆</span>
      <span className="font-bold">{children}</span>
    </div>
  );
}

export function SectionTitle({ children, right, rightHref }: { children: React.ReactNode; right?: React.ReactNode; rightHref?: string }) {
  return (
    <div className="mb-2.5 mt-7 flex items-center justify-between">
      <h2 className="text-[15px] font-black tracking-wide">{children}</h2>
      {right ? (
        rightHref ? (
          <Link href={rightHref} className="min-h-[32px] px-1 py-1.5 text-[12px] font-bold text-slate-500 active:text-[#f2c66e]">
            {right}
          </Link>
        ) : (
          <span className="text-[12px] font-bold text-slate-600">{right}</span>
        )
      ) : null}
    </div>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-[14px] bg-[linear-gradient(145deg,rgba(22,40,57,.9),rgba(12,28,43,.94))] ${className}`}>
      {children}
    </div>
  );
}

// 整卡可點 — 手機以 active: 狀態取代 hover（按下時立即有視覺回饋），不依賴滑鼠 hover。
export function ClickableCard({ href, children, className = "" }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={`group block min-h-[44px] overflow-hidden rounded-[14px] border-l-2 border-transparent bg-[linear-gradient(145deg,rgba(22,40,57,.9),rgba(12,28,43,.94))] transition active:border-l-[#e9be6e] active:bg-[linear-gradient(145deg,rgba(28,48,67,.95),rgba(16,34,51,.97))] ${className}`}
    >
      {children}
    </Link>
  );
}

export function Row({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`min-h-[44px] border-b border-white/[0.05] px-3.5 py-3 text-[13px] last:border-b-0 ${className}`}>{children}</div>;
}

export function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border-l-[3px] border-[#e9be6e] bg-[#0e2438] px-3.5 py-3 text-[12px] leading-5 text-slate-300">
      {children}
    </p>
  );
}

// 方向標籤 — 刻意低調（小字＋小圓點），不能比人物身份更搶眼。
const DIRECTION_DOT: Record<Direction, string> = { BULLISH: "bg-emerald-400", NEUTRAL: "bg-slate-400", BEARISH: "bg-rose-400" };
const DIRECTION_TEXT: Record<Direction, string> = { BULLISH: "text-emerald-300", NEUTRAL: "text-slate-400", BEARISH: "text-rose-300" };
export function DirectionTag({ direction }: { direction: Direction }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[12px] font-semibold ${DIRECTION_TEXT[direction]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DIRECTION_DOT[direction]}`} />
      {DIRECTION_LABEL[direction]}
    </span>
  );
}

export function FlipTag() {
  return <span className="text-[11px] font-bold text-[#f2c66e]">⟲ 翻轉</span>;
}

// 人物／機構身份 — 姓名為主視覺，公司＋職稱為次要說明文字；英文名只在人物頁或該頁第一次出現時顯示小字。
// 從不使用照片或 Q 版頭像，純文字呈現。
export function PersonIdentity({
  person,
  showEnglish = false,
  href,
  size = "md",
}: {
  person: Person;
  showEnglish?: boolean;
  href?: string;
  size?: "md" | "lg";
}) {
  const nameClass = size === "lg" ? "text-[19px] font-black" : "text-[13.5px] font-bold";
  const content = (
    <span>
      <span className={`${nameClass} text-[#f7f3e8]`}>
        {person.nameZh}
        {showEnglish ? <span className="ml-1.5 text-[10.5px] font-normal text-slate-500">{person.nameEn}</span> : null}
      </span>
      <span className={`block text-[11px] text-slate-500 ${size === "lg" ? "mt-1" : "mt-0.5"}`}>
        {person.org}・{person.title}
      </span>
    </span>
  );
  if (href) {
    return (
      <Link href={href} className="block min-h-[44px] active:opacity-80">
        {content}
      </Link>
    );
  }
  return content;
}

// Ticker 降為次要資訊：公司中文名為主，代碼為灰階小字。
export function AssetChip({ code, nameZh, href }: { code: string; nameZh: string; href?: string }) {
  const inner = (
    <span className="inline-flex items-baseline gap-1 text-[13px]">
      <span className="font-semibold text-slate-200">{nameZh}</span>
      <span className="text-[11px] text-slate-500">{code}</span>
    </span>
  );
  if (href) {
    return (
      <Link href={href} className="inline-flex min-h-[32px] items-center active:text-[#f2c66e]">
        {inner}
      </Link>
    );
  }
  return inner;
}

export function relativeTimeZh(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return "1 小時內";
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  return `${days} 天前`;
}
