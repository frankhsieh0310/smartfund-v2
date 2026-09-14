// SmartMatch 共識雷達 — deterministic event dedup (Phase E).
//
// One original Trump speech re-syndicated by Reuters + CNBC + Bloomberg + 15 blogs must count as
// ONE consensus event (with many source references), not 18 votes. The canonical key is built from
// the ORIGINAL statement, not the syndicating article:
//   person + coarse time bucket + normalized-quote hash + topic.

import { createHash } from "node:crypto";

const scrub = (s: string) =>
  s.normalize("NFKC").toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

// The canonical key must survive re-syndication: Reuters / CNBC / a blog all wrap the SAME original
// quote in different prose. So when the text contains quoted spans, hash ONLY the quoted words
// (that is the original statement); otherwise fall back to the whole normalized text.
export function normalizeQuote(text: string): string {
  const raw = (text || "").replace(/[‘’]/g, "'").replace(/[“”„«»]/g, '"');
  const quoted = [...raw.matchAll(/"([^"]{25,}?)"/g)].map((m) => m[1]);
  const basis = quoted.length ? quoted.join(" ") : raw;
  return scrub(basis).slice(0, 600);
}

// 6-hour bucket: the same interview quoted across a news cycle still collapses; two genuinely
// separate remarks a day apart do not.
export function eventTimeBucket(iso: string, hours = 6): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "na";
  return String(Math.floor(t / (hours * 3600 * 1000)));
}

export function canonicalEventKey(input: {
  personSlug: string;
  eventAt: string;
  quote: string;
  topic?: string | null;
}): string {
  const quoteHash = createHash("sha256").update(normalizeQuote(input.quote)).digest("hex").slice(0, 16);
  const topic = (input.topic ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return ["ce", input.personSlug, eventTimeBucket(input.eventAt), topic || "na", quoteHash].join(":");
}

// Loose near-duplicate check for two candidate events already keyed to the same person + bucket:
// if the normalized quotes share most of their tokens, treat as the same original statement.
export function quotesAreSameStatement(a: string, b: string, threshold = 0.72): boolean {
  const ta = new Set(normalizeQuote(a).split(" ").filter((w) => w.length > 3));
  const tb = new Set(normalizeQuote(b).split(" ").filter((w) => w.length > 3));
  if (ta.size === 0 || tb.size === 0) return false;
  let overlap = 0;
  for (const w of ta) if (tb.has(w)) overlap++;
  return overlap / Math.min(ta.size, tb.size) >= threshold;
}
