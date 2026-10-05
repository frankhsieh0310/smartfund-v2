// Per-item QUALIFY + extract. Uses the Vercel AI Gateway directly (same `gateway()` helper the
// existing pipeline uses — this is the one piece of infrastructure genuinely shared, since there is
// no other way to turn free-text Chinese financial wire copy into structured fields). Everything
// else (fetch, merge, DTO, API route) is new and independent of lib/consensus/*.
import { generateObject, gateway } from "ai";
import { z } from "zod";
import type { ExtractedOpinion, RawFeedItem } from "./types";

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
  "topic_name 必須具體到能解釋 stance 的方向性，例如「布倫特原油價格」「AI產業」「半導體」「美國利率」「美股」，",
  "不要只寫「原油」「科技」這種太籠統的詞。",
  "",
  "stance 的定義是「這段話對 topic_name 這個主題的市場影響方向」，不是這篇報導的情緒、也不是這個人說話時的語氣。",
  "例如：原油供應減少 -> 對原油價格是 POSITIVE；原油供應能力大增 -> 對原油價格是 NEGATIVE；",
  "看不出明確方向就是 UNCLEAR，不要勉強判斷成 POSITIVE 或 NEGATIVE。",
  "",
  "summary_zh：40~80字繁體中文白話摘要，讓台灣一般投資人幾秒內看懂重點，不要用艱澀詞彙。",
  "reason_zh：一句話講出這個觀點背後最核心的理由。",
  "",
  "view_changed 只有在原文明確寫出「改口」「上調」「下調」「轉多」「轉空」「調整目標價」等字樣時才能是 true，",
  "絕對不能自己用其他歷史資料去推論這個人是否改變了看法 —— 沒有明確寫出來就一律 false。",
  "",
  "輸出一律使用繁體中文（summary_zh / reason_zh / topic_name / organization / role / speaker_name 等欄位），",
  "即使原文是簡體中文。不要給投資建議，不要加上你自己推測的市場影響。",
].join("\n");

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
    return {
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
    };
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
        "topic_name：寫出能涵蓋這幾則內容共同主題的名稱（例如都在談原油，就寫「原油」或更具體的",
        "「布倫特原油」），不要只複製某一則的 topic_name。",
        "",
        "stance：代表「整場談話對這個整合後主題」的整體方向（POSITIVE/NEUTRAL/NEGATIVE/UNCLEAR），",
        "不是直接採用最新一則的方向。你必須綜合看完全部列出的方向與摘要後再判斷：",
        "如果各則方向一致，就用該方向；如果內容本身正反混合、看不出整體傾向，一定要回傳 UNCLEAR，",
        "不可以為了給出明確答案而勉強選邊。",
        "",
        "summary_zh：40~80字繁體中文白話摘要，整合全部重點，不要逐條拼接。",
        "reason_zh：一句話講出整體最核心的理由。",
      ].join("\n"),
      prompt: bulletins,
    });
    return { topicName: object.topic_name, stance: object.stance, summaryZh: object.summary_zh, reasonZh: object.reason_zh };
  } catch {
    // Fallback: the single most recent member's own fields (still real data, never fabricated) —
    // only used if the merge AI call itself fails, not as a stance-selection strategy.
    const latest = members.slice().sort((a, b) => b.sourceItem.display_time - a.sourceItem.display_time)[0];
    return { topicName: latest.topicName ?? "", stance: latest.stance, summaryZh: latest.summaryZh ?? "", reasonZh: latest.reasonZh ?? "" };
  }
}
