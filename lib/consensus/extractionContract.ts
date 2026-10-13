// SmartMatch 共識雷達 — AI extraction contract (Phase F / Phase 2 automation).
//
// Model access is via the **Vercel AI Gateway** using the deployment's OIDC token
// (VERCEL_OIDC_TOKEN, auto-injected on Vercel). NO explicit Anthropic/OpenAI key is required in
// production. In local dev an AI_GATEWAY_API_KEY may be set as a fallback.
//
// The model only CLASSIFIES one statement into the strict schema below. It never scores, never
// ranks, never invents a DIRECT stock mention that is not literally in the text. On invalid output
// we retry once, then fall back to NEEDS_REVIEW (raw evidence kept, no stance — never fake data).

import { createHash } from "node:crypto";
import { generateObject, gateway, NoObjectGeneratedError } from "ai";
import { z } from "zod";

export const EXTRACTION_VERSION = "v2";
export const DEFAULT_EXTRACTION_MODEL = process.env.CONSENSUS_EXTRACTION_MODEL || "openai/gpt-4o-mini";

export type Stance = "BULLISH" | "BEARISH" | "NEUTRAL" | "MIXED" | "UNCLEAR";

export type ExtractionInput = {
  personDisplayName: string;
  personRole: string | null;
  sourceName: string;
  sourceGrade: "A" | "B" | "C";
  sourceUrl: string;
  eventAt: string; // ISO
  title: string | null;
  rawText: string;
};

export type DirectMention = { company: string; symbol: string; evidence: string };
export type InferredRelation = { theme: string; symbol: string; reason: string; confidence: number };

export type ExtractionResult = {
  person: string;
  event_at: string;
  summary_zh: string;
  stance: Stance;
  confidence: number;
  statement_strength: number;
  sector: string | null;
  theme: string | null;
  direct_mentions: DirectMention[];
  inferred_relations: InferredRelation[];
};

export type ClassifyOutcome =
  | { status: "CLASSIFIED"; model: string; version: string; contentHash: string; result: ExtractionResult; usage?: { promptTokens?: number; completionTokens?: number }; cached?: boolean }
  | { status: "NEEDS_REVIEW"; reason: string; model: string; version: string; contentHash: string }
  | { status: "REJECTED"; reason: string; model: string; version: string; contentHash: string };

const extractionSchema = z.object({
  stance: z.enum(["BULLISH", "BEARISH", "NEUTRAL", "MIXED", "UNCLEAR"]),
  confidence: z.number().min(0.5).max(1),
  statement_strength: z.number().min(0.5).max(1),
  sector: z.string().nullable(),
  theme: z.string().nullable(),
  summary_zh: z.string().max(180),
  direct_mentions: z.array(z.object({ company: z.string(), symbol: z.string(), evidence: z.string() })).max(12),
  inferred_relations: z.array(z.object({ theme: z.string(), symbol: z.string(), reason: z.string(), confidence: z.number().min(0.2).max(1) })).max(12),
});

export const EXTRACTION_SYSTEM_PROMPT = [
  "You classify ONE public statement by a well-known person for a market consensus tracker.",
  "Return ONLY the structured object. No prose.",
  "",
  "STANCE (the statement's market view on its main subject):",
  "  BULLISH  = clearly positive / growth / adding / favourable / tailwind.",
  "  BEARISH  = clearly negative / risk / cutting / unfavourable / headwind.",
  "  NEUTRAL  = the subject is discussed but the speaker is explicitly balanced / non-committal.",
  "  MIXED    = the same view carries clear positives AND clear negatives at once.",
  "  UNCLEAR  = cannot be judged reliably, or no market-relevant view is expressed.",
  "",
  "direct_mentions: ONLY companies/brands/tickers/issuers named LITERALLY in the text. Put the",
  "  triggering phrase in 'evidence'. 'AI data-center capex is strong' must NOT yield NVDA unless",
  "  NVIDIA/NVDA is actually written.",
  "inferred_relations: sector/theme-derived tickers, confidence <= 0.7 for pure thematic inference.",
  "confidence = certainty of the stance. statement_strength = forcefulness (0.5 hedged .. 1.0 emphatic).",
  "summary_zh = one traditional-Chinese sentence, <= 60 characters, factual, no advice.",
].join("\n");

export function contentHashFor(input: { personDisplayName: string; rawText: string }): string {
  return createHash("sha256")
    .update(`${input.personDisplayName}\n${(input.rawText || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 8000)}`)
    .digest("hex")
    .slice(0, 40);
}

function toResult(input: ExtractionInput, obj: z.infer<typeof extractionSchema>): ExtractionResult {
  const text = (input.rawText || "").toLowerCase();
  // structural DIRECT guard: keep a DIRECT mention only if its evidence phrase (or the ticker/company)
  // actually appears in the raw text. Anything that fails becomes an INFERRED relation instead.
  const direct: DirectMention[] = [];
  const demoted: InferredRelation[] = [];
  for (const d of obj.direct_mentions) {
    const ev = (d.evidence || "").toLowerCase().slice(0, 60);
    const named = text.includes((d.company || "").toLowerCase()) || text.includes((d.symbol || "").toLowerCase());
    if ((ev && text.includes(ev)) || named) direct.push({ company: d.company, symbol: d.symbol.toUpperCase(), evidence: d.evidence });
    else demoted.push({ theme: obj.theme ?? "", symbol: d.symbol.toUpperCase(), reason: `model marked DIRECT but not found verbatim: ${d.evidence}`, confidence: 0.4 });
  }
  const inferred = [
    ...obj.inferred_relations.map((r) => ({ theme: r.theme, symbol: r.symbol.toUpperCase(), reason: r.reason, confidence: Math.min(0.7, r.confidence) })),
    ...demoted,
  ];
  return {
    person: input.personDisplayName,
    event_at: input.eventAt,
    summary_zh: obj.summary_zh.slice(0, 180),
    stance: obj.stance,
    confidence: obj.confidence,
    statement_strength: obj.statement_strength,
    sector: obj.sector,
    theme: obj.theme,
    direct_mentions: direct,
    inferred_relations: inferred,
  };
}

async function callModel(model: string, input: ExtractionInput) {
  return generateObject({
    model: gateway(model),
    schema: extractionSchema,
    schemaName: "consensus_extraction",
    temperature: 0.1,
    maxOutputTokens: 900,
    system: EXTRACTION_SYSTEM_PROMPT,
    prompt: JSON.stringify({
      person: input.personDisplayName,
      person_role: input.personRole,
      source: input.sourceName,
      source_grade: input.sourceGrade,
      source_url: input.sourceUrl,
      event_at: input.eventAt,
      title: input.title,
      text: input.rawText.slice(0, 8000),
    }),
  });
}

export type CachePort = {
  get(key: { contentHash: string; version: string; model: string }): Promise<ClassifyOutcome | null>;
  put(value: ClassifyOutcome): Promise<void>;
};

// Classify with cache + one retry. `cache` is optional (ingest passes a DB-backed port).
export async function classifyConsensusEvent(input: ExtractionInput, cache?: CachePort): Promise<ClassifyOutcome> {
  const model = DEFAULT_EXTRACTION_MODEL;
  const version = EXTRACTION_VERSION;
  const contentHash = contentHashFor(input);
  const base = { model, version, contentHash };

  if (cache) {
    const hit = await cache.get({ contentHash, version, model });
    if (hit) return { ...hit, cached: true } as ClassifyOutcome;
  }

  if (!process.env.VERCEL_OIDC_TOKEN && !process.env.AI_GATEWAY_API_KEY) {
    return { status: "NEEDS_REVIEW", reason: "no AI Gateway credential (VERCEL_OIDC_TOKEN / AI_GATEWAY_API_KEY)", ...base };
  }

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { object, usage } = await callModel(model, input);
      const parsed = extractionSchema.safeParse(object);
      if (!parsed.success) { lastErr = `schema: ${parsed.error.issues[0]?.message ?? "invalid"}`; continue; }
      const outcome: ClassifyOutcome = {
        status: "CLASSIFIED", ...base,
        result: toResult(input, parsed.data),
        usage: { promptTokens: usage?.inputTokens, completionTokens: usage?.outputTokens },
      };
      if (cache) await cache.put(outcome);
      return outcome;
    } catch (e) {
      if (NoObjectGeneratedError.isInstance(e)) { lastErr = "model produced no valid object"; continue; }
      const msg = (e as Error).message || String(e);
      // billing / auth problems are not retryable and not the statement's fault
      if (/credit card|customer_verification|unauthorized|forbidden|quota|insufficient/i.test(msg)) {
        const out: ClassifyOutcome = { status: "NEEDS_REVIEW", reason: `gateway: ${msg.slice(0, 200)}`, ...base };
        return out;
      }
      lastErr = msg.slice(0, 200);
    }
  }
  const out: ClassifyOutcome = { status: "NEEDS_REVIEW", reason: lastErr || "classification failed", ...base };
  if (cache) await cache.put(out); // cache NEEDS_REVIEW too so we don't hammer a bad item every run
  return out;
}
