// Deterministic Taiwan financial-Chinese normalization layer. This is NOT simplified->traditional
// character conversion (that alone leaves mainland word choices like 特朗普/加息/通脹 untouched —
// those are vocabulary differences, not character-set differences). Pipeline:
//
//   AI extraction -> opencc-js (s2twp: simplified chars + common Taiwan phrase table)
//                 -> canonical person/org + finance-term dictionary (this module)
//                 -> LiveOpinionCard DTO
//
// Applied only to user-facing free text (speakerName/organization/role/topicName/summaryZh/reasonZh).
// Never touches ticker, source URLs, enum values (topicType/stance), or numbers/prices.
import { Converter } from "opencc-js";

const s2twp = Converter({ from: "cn", to: "twp" });

// Longer keys MUST be checked before their shorter substrings (e.g. "特朗普總統" before "特朗普"),
// so the dictionary is applied as one single-pass longest-match replacement, not naive sequential
// string.replace calls (which would risk a long form being partially consumed by a shorter rule).
// Keys are written in the form opencc's s2twp pass actually produces (confirmed by direct testing),
// so this dictionary is a deterministic correction layer on TOP of opencc's own Taiwan phrase table,
// not a S2T converter itself.
const CANONICAL_DICTIONARY: ReadonlyArray<readonly [string, string]> = [
  // 人物 — longer compound forms first
  ["特朗普總統", "美國總統川普"],
  ["特朗普", "川普"],
  ["鮑威爾", "鮑爾"],
  ["蘇姿豐", "蘇姿丰"],
  // 機構/公司
  ["美聯儲", "美國聯準會"],
  ["超威", "超微"], // mainland term for AMD -> Taiwan term. English "AMD" itself is left untouched.
  // 金融用語
  ["美債收益率", "美國公債殖利率"], // compound checked before the two shorter rules below
  ["美國國債", "美國公債"],
  ["美債", "美國公債"],
  ["收益率", "殖利率"],
  ["通脹", "通膨"],
  ["加息", "升息"],
  ["經濟增長", "經濟成長"],
  ["風險資產", "風險性資產"],
];

// Sort by key length descending so the alternation regex naturally prefers the longest match at
// each position (classic longest-match tokenization) — a single pass over the ORIGINAL string, so
// text already substituted in this pass is never re-scanned/mangled by a later rule.
const SORTED_DICT = [...CANONICAL_DICTIONARY].sort((a, b) => b[0].length - a[0].length);
const DICT_MAP = new Map(SORTED_DICT);
const DICT_PATTERN = new RegExp(SORTED_DICT.map(([k]) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");

function applyCanonicalDictionary(text: string): string {
  if (!DICT_PATTERN.test(text)) return text; // fast path, no match
  DICT_PATTERN.lastIndex = 0;
  return text.replace(DICT_PATTERN, (matched) => DICT_MAP.get(matched) ?? matched);
}

export function toTaiwanTraditional<T extends string | null>(text: T): T {
  if (text == null || text === "") return text;
  const traditional = s2twp(text);
  return applyCanonicalDictionary(traditional) as T;
}
