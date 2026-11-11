// 會員討論區不當字詞過濾（2026-11-11 使用者核准）。保守的關鍵字黑名單：命中就擋掉整篇不給發布
// （不是審核後才下架），作者看到明確錯誤訊息。這是基本過濾，不是完整的內容審核系統——嚴重違規
// 內容仍需靠檢舉+管理員刪文機制處理。
const BLOCKED_PATTERNS: RegExp[] = [
  // 中文常見髒話/人身攻擊字詞（刻意保守收錄，避免過度誤判一般金融討論用語）
  /幹你/, /你媽/, /白痴/, /智障/, /腦殘/, /去死/, /垃圾東西/, /畜生/,
  // 英文常見髒話——只鎖開頭字界（\b字尾），讓fucking/shitty這類常見字尾變化也會命中；
  // asshole保留完整字界，避免跟assessment/asset/class等正常詞彙的"ass"子字串誤判。
  /\bfuck/i, /\bshit/i, /\bbitch/i, /\basshole\b/i, /\bcunt/i,
  // 常見詐騙/非法招攬關鍵字（討論區容易被利用來招攬，不是單純髒話，但同樣要擋）
  /加line|加微信|私訊我.*賺|保證獲利|穩賺不賠/,
];

export function containsProfanity(text: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(text));
}

export function assertNoProfanity(text: string): void {
  if (containsProfanity(text)) {
    throw new Error("CONTAINS_BLOCKED_WORDS");
  }
}
