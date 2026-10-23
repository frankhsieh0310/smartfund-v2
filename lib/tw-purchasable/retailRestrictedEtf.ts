// 2026-10-23（使用者核准）: 一般投資人透過複委託買不到的美股ETF判定規則。依據：
// - 金管會2024-09-30公告：海外虛擬資產「現貨」ETF複委託只開放專業投資人（自然人財力門檻NT$3000
//   萬以上），一般投資人不可購買；虛擬資產「期貨」ETF同樣不在開放範圍內。
// - 元大證券《受託買賣外國有價證券業務作業手冊》（2026-01-07版）：非專業投資人複委託買賣具槓桿/
//   放空效果的ETF，限正向不超過2倍、反向不超過1倍。
// 分類依據Yahoo Finance的category欄位（fundProfile.categoryName，Morningstar標準分類），不是
// 名稱關鍵字猜測：
//   - category='Digital Assets' -> 現貨或期貨虛擬資產ETF，排除
//   - category='Equity Digital Assets' -> 投資區塊鏈/加密產業「股票」的一般股票型ETF，明確保留
//   - category LIKE 'Trading--Leveraged%' / 'Trading--Inverse%' -> 用名稱解析實際倍數（SEC/FINRA
//     規定這類商品的倍數必須出現在基金正式名稱裡，不是猜測），超過上限才排除
//   - 'Trading--Miscellaneous' 或解析不出倍數的 -> UNKNOWN，不排除（寧可少排不要錯排）

export type RetailRestrictedCheck = { excluded: boolean; reason: string | null };

function parseLeverageMultiple(name: string): { direction: "LONG" | "INVERSE"; multiple: number } | null {
  const n = name;
  if (/UltraPro Short|UltraPro Inverse/i.test(n)) return { direction: "INVERSE", multiple: 3 };
  if (/UltraShort/i.test(n)) return { direction: "INVERSE", multiple: 2 };
  if (/\bShort\b/i.test(n) && !/Short Duration|Short Term|Short-Term/i.test(n)) return { direction: "INVERSE", multiple: 1 };
  if (/UltraPro\b/i.test(n)) return { direction: "LONG", multiple: 3 };
  if (/\bUltra\b/i.test(n)) return { direction: "LONG", multiple: 2 };
  const explicitX = n.match(/(-?\d)\s*[xX]\b/);
  if (explicitX) {
    const v = parseInt(explicitX[1], 10);
    return v < 0 ? { direction: "INVERSE", multiple: Math.abs(v) } : { direction: "LONG", multiple: v };
  }
  if (/\bBear\b/i.test(n)) return { direction: "INVERSE", multiple: 1 };
  if (/\bBull\b/i.test(n)) return { direction: "LONG", multiple: 1 };
  return null;
}

export function checkRetailRestricted(name: string, category: string | null): RetailRestrictedCheck {
  const cat = category ?? "";
  if (cat === "Equity Digital Assets") return { excluded: false, reason: null };
  if (cat === "Digital Assets") return { excluded: true, reason: "DIGITAL_ASSETS_SPOT_OR_FUTURES" };
  if (cat.startsWith("Trading--Leveraged") || cat.startsWith("Trading--Inverse")) {
    const lev = parseLeverageMultiple(name);
    if (!lev) return { excluded: false, reason: null }; // UNKNOWN -- conservative, don't exclude
    if (lev.direction === "LONG" && lev.multiple > 2) return { excluded: true, reason: `LEVERAGE_LONG_${lev.multiple}X_OVER_2X_LIMIT` };
    if (lev.direction === "INVERSE" && lev.multiple > 1) return { excluded: true, reason: `LEVERAGE_INVERSE_${lev.multiple}X_OVER_1X_LIMIT` };
    return { excluded: false, reason: null };
  }
  return { excluded: false, reason: null };
}
