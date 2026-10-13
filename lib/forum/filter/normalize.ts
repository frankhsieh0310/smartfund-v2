// Normalization pipeline for the forum content filter.
// Order matters: width -> whitespace/symbol stripping -> simplified->traditional -> homophones -> numerals.
// Each step is intentionally narrow in scope; the full rule-matching happens in rules.ts against the
// normalized output, never against the raw user input.

/** Full-width ASCII (digits, latin letters, common punctuation) -> half-width. */
export function fullWidthToHalfWidth(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCodePoint(code - 0xfee0);
    } else if (code === 0x3000) {
      out += " ";
    } else {
      out += ch;
    }
  }
  return out;
}

// Separators/symbols commonly inserted between digits or words to dodge naive substring matching,
// e.g. "0912-345-678", "0912．345．678", "私 訊 我", "LINE：abc123".
const SEPARATOR_PATTERN = /[\s\-_.．、,，。·:：|/\\]+/g;

/** Collapse inserted separators so split-up contact info (e.g. "0912 345 678") matches as one run. */
export function stripSeparators(text: string): string {
  return text.replace(SEPARATOR_PATTERN, "");
}

// Minimal Simplified -> Traditional map covering characters that actually appear in the categories
// we filter on (fraud/solicitation/messaging-app vocabulary). This is NOT a general-purpose OpenCC
// replacement — before production rollout, swap this for a proper conversion library (see spec section 5).
const SIMPLIFIED_TO_TRADITIONAL: Record<string, string> = {
  "导": "導", "链": "鏈", "赚": "賺", "证": "證", "顾": "顧", "问": "問",
  "买": "買", "卖": "賣", "进": "進", "单": "單", "带": "帶", "跟": "跟",
  "群": "群", "号": "號", "报": "報", "线": "線", "络": "絡", "财": "財",
  "务": "務", "骗": "騙", "诈": "詐", "联": "聯", "讯": "訊",
  "汇": "匯", "账": "帳", "银": "銀", "转": "轉", "贷": "貸", "资": "資",
};

export function simplifiedToTraditional(text: string): string {
  let out = "";
  for (const ch of text) {
    out += SIMPLIFIED_TO_TRADITIONAL[ch] ?? ch;
  }
  return out;
}

// Common phonetic/visual substitutions used to dodge exact-term matching.
const HOMOPHONE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/威信/g, "微信"],
  [/[vV][我信]/g, "微信"],
  [/加[vV]\b/g, "加微信"],
  [/賴(我|加)/g, "LINE$1"],
  [/私[我窩]/g, "私訊"],
  [/[pP][mM]我/g, "私訊我"],
  [/站內[信件]/g, "私訊"],
  [/ig私/g, "私訊"],
];

export function normalizeHomophones(text: string): string {
  let out = text;
  for (const [pattern, replacement] of HOMOPHONE_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Chinese numerals (incl. phone-code words like 洞=0, 幺=1 commonly used to evade digit filters).
const CHINESE_DIGIT_MAP: Record<string, string> = {
  "零": "0", "洞": "0", "〇": "0",
  "一": "1", "幺": "1", "壹": "1",
  "二": "2", "兩": "2", "貳": "2",
  "三": "3", "參": "3", "叁": "3",
  "四": "4", "肆": "4",
  "五": "5", "伍": "5",
  "六": "6", "陸": "6",
  "七": "7", "拐": "7", "柺": "7",
  "八": "8", "捌": "8",
  "九": "9", "勾": "9", "玖": "9",
};

/** Convert Chinese-numeral digit sequences (e.g. phone numbers spelled out) into ASCII digits. */
export function chineseNumeralsToDigits(text: string): string {
  let out = "";
  for (const ch of text) {
    out += CHINESE_DIGIT_MAP[ch] ?? ch;
  }
  return out;
}

/**
 * Aggressive normalization for term/phone/keyword matching: strips all separators so split-up
 * contact info and spaced-out keywords collapse into one matchable run. Do NOT use this for
 * URL/email detection — it also strips the dots and slashes those patterns depend on.
 */
export function normalizeText(raw: string): string {
  let text = raw;
  text = fullWidthToHalfWidth(text);
  text = chineseNumeralsToDigits(text);
  text = stripSeparators(text);
  text = simplifiedToTraditional(text);
  text = normalizeHomophones(text);
  return text.toLowerCase();
}

/**
 * Light normalization for URL/email detection: width + simplified/traditional only, whitespace
 * collapsed to single spaces. Dots, slashes and "@" are preserved since link/email patterns need them.
 */
export function normalizeForLinks(raw: string): string {
  let text = raw;
  text = fullWidthToHalfWidth(text);
  text = simplifiedToTraditional(text);
  text = text.replace(/\s+/g, " ");
  return text.toLowerCase();
}
