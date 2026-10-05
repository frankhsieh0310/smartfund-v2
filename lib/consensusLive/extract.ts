// Per-item QUALIFY + extract. Uses the Vercel AI Gateway directly (same `gateway()` helper the
// existing pipeline uses — this is the one piece of infrastructure genuinely shared, since there is
// no other way to turn free-text Chinese financial wire copy into structured fields). Everything
// else (fetch, merge, DTO, API route) is new and independent of lib/consensus/*.
import { generateObject, gateway } from "ai";
import { z } from "zod";
import type { ExtractedOpinion, RawFeedItem } from "./types";
import { toTaiwanTraditional } from "./taiwanLocalization";

const MODEL = process.env.CONSENSUS_EXTRACTION_MODEL || "openai/gpt-4o-mini";

const schema = z.object({
  qualifies: z.boolean(),
  speaker_name: z.string().nullable(),
  organization: z.string().nullable(),
  role: z.string().nullable(),
  topic_type: z.enum(["STOCK", "INDUSTRY", "COMMODITY", "MACRO", "OTHER"]).nullable(),
  topic_name: z.string().nullable(),
  ticker: z.string().nullable(),
  stance: z.enum(["POSITIVE", "NEUTRAL", "NEGATIVE", "UNCLEAR"]).nullable(),
  summary_zh: z.string().nullable(),
  reason_zh: z.string().nullable(),
  view_changed: z.boolean(),
});

const SYSTEM_PROMPT = [
  "你在為台灣投資人篩選華爾街見聞快訊，只挑出「有明確人物或機構發表市場/產業/商品/總經觀點」的內容。",
  "",
  "QUALIFY（qualifies=true）只有在：文中有明確的人物或機構，且該人物/機構對某個標的/產業/商品/總經主題",
  "表達了具體看法。純粹的行情價格變動、純事件新聞、匿名傳聞（如「據報道」「消息人士稱」且無具名機構表態）、",
  "單純公司公告（無觀點）一律 qualifies=false，其餘欄位可為 null。",
  "",
  "身份（speaker_name / organization / role）：只能照原文literal寫出。原文沒有提到個人姓名時，",
  "絕對不要用你自己的知識去補上真實姓名 —— 例如原文只寫「沙特阿美CEO」，speaker_name 就填",
  "「沙特阿美執行長」，organization 填「沙特阿美」，不可以自己填入執行長的真實姓名。",
  "",
  "topic_name 必須是一個「使用者能立刻判斷 POSITIVE/NEGATIVE 方向」的具體市場標的，例如：",
  "個股（例如「台積電」）、產業（例如「半導體產業」）、商品價格（例如「原油價格」「黃金價格」，",
  "不要只寫「原油」「黃金」）、利率（例如「美國利率」）、匯率（例如「美元兌日圓」）、股市（例如「美股」",
  "「台股」）、經濟成長（例如「美國經濟成長」）等。",
  "",
  "topic_name 絕對不能是「供應」「市場」「供應鏈」「產業情勢」這種本身沒有方向性、只是描述狀態或現象的詞 ——",
  "這些詞本身無法判斷 POSITIVE 還是 NEGATIVE。你要往後推一步，找出這個狀態「會影響什麼可交易的標的」，",
  "把那個標的當作 topic_name。例如原文在談「原油供應減少」，topic_name 要寫「原油價格」而不是「原油供應」；",
  "原文在談「升息預期提高」且核心是在談利率本身，topic_name 要寫「美國利率」；只有原文明確另外談到",
  "股市受影響時，才需要把股市也當作一個獨立的觀點看待，不要把利率的方向硬套在股市上。",
  "",
  "stance 的定義是「這段話對 topic_name 這個標的的市場影響方向」，不是這篇報導的情緒、也不是這個人說話時的語氣。",
  "例如：原油供應減少 -> topic_name=原油價格, stance=POSITIVE；原油供應能力大增 -> topic_name=原油價格,",
  "stance=NEGATIVE。先確定一個有方向性的 topic_name，再判斷 stance，不要反過來。",
  "看不出明確方向就是 UNCLEAR，不要勉強判斷成 POSITIVE 或 NEGATIVE，但也不要因為 topic_name 選得太抽象",
  "（例如選了「供應」而不是「原油價格」）而被迫判成 UNCLEAR —— 先把 topic_name 選對，方向通常就會清楚。",
  "",
  "summary_zh：40~80字繁體中文白話摘要，台灣投資人用語，只整理原文實際講的內容，不要加入原文沒有明確",
  "寫出來的推論、動機、心理狀態 —— 例如原文沒有說「展現信心」，就不能寫「顯示對未來供應有信心」這種揣測。",
  "reason_zh：一句話講出這個觀點背後最核心的理由，同樣只能根據原文，不能自己延伸推論。",
  "",
  "view_changed 只有在原文明確寫出「改口」「上調」「下調」「轉多」「轉空」「調整目標價」等字樣時才能是 true，",
  "絕對不能自己用其他歷史資料去推論這個人是否改變了看法 —— 沒有明確寫出來就一律 false。",
  "",
  "輸出一律使用台灣繁體中文與台灣金融市場慣用詞彙（summary_zh / reason_zh / topic_name / organization /",
  "role / speaker_name 等欄位），即使原文是簡體中文或使用中國大陸用語 —— 例如「特朗普」要寫成「川普」、",
  "「美联储」要寫成「美國聯準會」、「加息」要寫成「升息」、「通胀」要寫成「通膨」。",
  "這只是第一層把關，之後還會有 deterministic 的台灣用語校正，所以你仍必須盡力自己先寫對。",
  "不要給投資建議，不要加上你自己推測的市場影響。",
].join("\n");

function localizeOpinionFields<T extends { speakerName: string | null; organization: string | null; role: string | null; topicName: string | null; summaryZh: string | null; reasonZh: string | null }>(o: T): T {
  return {
    ...o,
    speakerName: toTaiwanTraditional(o.speakerName),
    organization: toTaiwanTraditional(o.organization),
    role: toTaiwanTraditional(o.role),
    topicName: toTaiwanTraditional(o.topicName),
    summaryZh: toTaiwanTraditional(o.summaryZh),
    reasonZh: toTaiwanTraditional(o.reasonZh),
  };
}

export async function extractOpinion(item: RawFeedItem): Promise<ExtractedOpinion> {
  const text = `${item.title ? item.title + "\n" : ""}${item.content_text}`.slice(0, 4000);
  try {
    const { object } = await generateObject({
      model: gateway(MODEL),
      schema,
      schemaName: "consensus_live_extraction",
      temperature: 0.1,
      maxOutputTokens: 500,
      system: SYSTEM_PROMPT,
      prompt: JSON.stringify({ published_at: new Date(item.display_time * 1000).toISOString(), text }),
    });
    return localizeOpinionFields({
      qualifies: object.qualifies,
      sourceItem: item,
      speakerName: object.speaker_name,
      organization: object.organization,
      role: object.role,
      topicType: object.topic_type,
      topicName: object.topic_name,
      ticker: object.ticker,
      stance: object.stance,
      summaryZh: object.summary_zh,
      reasonZh: object.reason_zh,
      viewChanged: object.view_changed,
    });
  } catch {
    // Extraction failure -> treat as not-qualifying rather than fabricate a guess. Never a fake card.
    return {
      qualifies: false, sourceItem: item, speakerName: null, organization: null, role: null,
      topicType: null, topicName: null, ticker: null, stance: null, summaryZh: null, reasonZh: null,
      viewChanged: false,
    };
  }
}

const mergeSchema = z.object({
  topic_name: z.string(),
  stance: z.enum(["POSITIVE", "NEUTRAL", "NEGATIVE", "UNCLEAR"]),
  summary_zh: z.string(),
  reason_zh: z.string(),
});

export type MergedCardFields = { topicName: string; stance: ExtractedOpinion["stance"]; summaryZh: string; reasonZh: string };

// Synthesizes ONE consolidated card for a same-event group (never a naive concatenation, and never
// just the latest member's own fields). Only called when a group has 2+ members. The merged stance
// is judged fresh from ALL members' stances/summaries together — if the group's content is genuinely
// mixed/contradictory on the merged topic, the model is instructed to return UNCLEAR rather than let
// whichever member happens to be most recent silently decide the card's stance.
export async function synthesizeMergedCard(members: ExtractedOpinion[]): Promise<MergedCardFields> {
  const bulletins = members
    .slice()
    .sort((a, b) => a.sourceItem.display_time - b.sourceItem.display_time)
    .map((m) => `- 主題:${m.topicName} / 方向:${m.stance} / 摘要:${m.summaryZh} / 理由:${m.reasonZh}`)
    .join("\n");
  try {
    const { object } = await generateObject({
      model: gateway(MODEL),
      schema: mergeSchema,
      schemaName: "consensus_live_merge_card",
      temperature: 0.1,
      maxOutputTokens: 350,
      system: [
        "以下是同一個人物/機構同一場談話（或同一事件）被拆成多則快訊、各自判斷後的結果列表。",
        "請把它們整合成「一張」觀點卡：",
        "",
        "topic_name：必須是一個「使用者能立刻判斷 POSITIVE/NEGATIVE 方向」的具體市場標的（個股/產業/",
        "商品價格/利率/匯率/股市/經濟成長等），不能是「供應」「市場」「產業情勢」這種本身沒有方向性的詞。",
        "例如這幾則都在談原油供需，topic_name 要寫「原油價格」，不要只複製某一則的 topic_name，也不要",
        "寫成「原油供應」這種無方向性的詞。",
        "",
        "stance：代表「整場談話對這個 topic_name 標的」的整體方向（POSITIVE/NEUTRAL/NEGATIVE/UNCLEAR），",
        "不是直接採用最新一則的方向。你必須綜合看完全部列出的方向與摘要後再判斷：",
        "如果各則方向一致，就用該方向；如果內容本身正反混合、看不出整體傾向，一定要回傳 UNCLEAR，",
        "不可以為了給出明確答案而勉強選邊，但也不要因為 topic_name 選得太抽象而被迫判成 UNCLEAR。",
        "",
        "summary_zh：40~80字繁體中文白話摘要，台灣投資人用語，整合全部重點，不要逐條拼接，只整理",
        "原文實際講的內容，不要加入原文沒有明確寫出來的推論、動機、心理狀態（例如不能寫「顯示對未來",
        "供應有信心」這種揣測）。",
        "reason_zh：一句話講出整體最核心的理由，同樣只能根據原文，不能自己延伸推論。",
      ].join("\n"),
      prompt: bulletins,
    });
    return {
      topicName: toTaiwanTraditional(object.topic_name),
      stance: object.stance,
      summaryZh: toTaiwanTraditional(object.summary_zh),
      reasonZh: toTaiwanTraditional(object.reason_zh),
    };
  } catch {
    // Fallback: the single most recent member's own fields (already localized by extractOpinion
    // above — still real data, never fabricated) — only used if the merge AI call itself fails, not
    // as a stance-selection strategy.
    const latest = members.slice().sort((a, b) => b.sourceItem.display_time - a.sourceItem.display_time)[0];
    return { topicName: latest.topicName ?? "", stance: latest.stance, summaryZh: latest.summaryZh ?? "", reasonZh: latest.reasonZh ?? "" };
  }
}
