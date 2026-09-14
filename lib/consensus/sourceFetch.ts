// SmartMatch 共識雷達 — whitelisted source fetch (Phase C/D + Phase 2).
//
// NO unrestricted crawler. Each source is read only by its declared method, only for the
// incremental window, only if it permits automated access. RSS/Atom feeds are parsed generically;
// a candidate's body is hydrated from the article page (bounded) so attribution + classification
// have real text. HTML-only sources without a feed yield zero candidates until a parser is written
// (never guess). This module never classifies and never writes.

export type SourceRow = {
  id: string;
  slug: string;
  source_type: string;
  source_name: string;
  source_grade: "A" | "B" | "C";
  canonical_url: string | null;
  person_id: string | null;
  is_official?: boolean;
  fetch_method: string; // RSS | HTML | API | MANUAL | SKIP_NO_ACCESS
};

export type Candidate = {
  url: string;
  title: string | null;
  text: string;
  publishedAt: string | null; // ISO
};

export type FetchOutcome = {
  slug: string;
  attempted: boolean;
  ok: boolean;
  skippedReason: string | null;
  error: string | null;
  candidates: Candidate[];
  newestPublishedAt: string | null;
};

const UA = "SmartMatchConsensusBot/1.0 (+https://smartfund-v2.vercel.app)";
// Decode the handful of entities that carry meaning for attribution (quotation marks + apostrophes
// + spaces) BEFORE stripping the rest — a press release's `&#8220;…&#8221; said Jensen Huang` must
// keep its quote marks or Rule A/B can never see a first-person quotation.
export const decodeEntities = (s: string) =>
  s
    .replace(/&(?:quot|ldquo|rdquo|#34|#x22|#8220|#8221|#822[01]);/gi, '"')
    .replace(/&(?:apos|lsquo|rsquo|#39|#x27|#8216|#8217|#821[67]);/gi, "'")
    .replace(/&(?:nbsp|#160|#xa0);/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&(?:mdash|#8212|#x2014);/gi, "—")
    .replace(/&(?:ndash|#8211|#x2013);/gi, "–");
const stripTags = (s: string) => decodeEntities(s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

function parseFeed(xml: string, sinceMs: number): Candidate[] {
  const chunks = xml.split(/<(?:item|entry)[\s>]/i).slice(1);
  const out: Candidate[] = [];
  for (const chunk of chunks.slice(0, 60)) {
    const tag = (t: string) => {
      const m = chunk.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i"));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
    };
    let link = "";
    const lm = chunk.match(/<link[^>]*href=["']([^"']+)["']/i);
    if (lm) link = lm[1];
    else link = tag("link").replace(/<[^>]+>/g, "").trim() || tag("guid").replace(/<[^>]+>/g, "").trim();
    const dateStr = tag("pubDate") || tag("published") || tag("updated") || tag("dc:date");
    const ts = dateStr ? Date.parse(dateStr) : NaN;
    if (Number.isFinite(ts) && ts < sinceMs) continue;
    const title = stripTags(tag("title"));
    const body = stripTags([tag("content:encoded"), tag("content"), tag("description"), tag("summary")].filter(Boolean).join(" ")).slice(0, 8000);
    if (!link) continue;
    out.push({ url: link.trim(), title: title || null, text: body || title, publishedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : null });
  }
  return out;
}

// SEC EDGAR — structured, public, bounded. canonical_url carries the CIK:
//   "sec:0001045810"  (or a full data.sec.gov submissions URL). Yields recent 8-K / 8-K/A / 6-K /
//   DEF 14A filings in the window; for each, the earnings-release exhibit (EX-99.x) is preferred
//   over the cover page so a CEO's prepared quote is available for attribution.
const SEC_FORMS = new Set(["8-K", "8-K/A", "6-K", "6-K/A", "DEF 14A"]);
const SEC_UA = "SmartMatchConsensusBot/1.0 (+https://smartfund-v2.vercel.app)";

async function fetchSecEdgar(canonical: string, sinceMs: number): Promise<Candidate[]> {
  const cik = (canonical.match(/(\d{4,10})/)?.[1] ?? "").padStart(10, "0");
  if (!cik || cik === "0000000000") return [];
  const subRes = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { "user-agent": SEC_UA, accept: "application/json" }, signal: AbortSignal.timeout(20_000),
  });
  if (!subRes.ok) throw new Error(`SEC submissions HTTP ${subRes.status}`);
  const sub = (await subRes.json()) as {
    name?: string;
    filings?: { recent?: { form?: string[]; filingDate?: string[]; accessionNumber?: string[]; primaryDocument?: string[]; primaryDocDescription?: string[] } };
  };
  const r = sub.filings?.recent;
  if (!r?.form) return [];
  const cikInt = String(parseInt(cik, 10));
  const out: Candidate[] = [];
  for (let i = 0; i < r.form.length && out.length < 8; i++) {
    if (!SEC_FORMS.has(r.form[i])) continue;
    const dateIso = new Date(`${r.filingDate![i]}T13:00:00Z`).toISOString();
    if (Date.parse(dateIso) < sinceMs) continue;
    const acc = (r.accessionNumber![i] ?? "").replace(/-/g, "");
    if (!acc) continue;
    const base = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${acc}/`;
    let docName = r.primaryDocument![i] ?? "";
    try {
      const idxRes = await fetch(`${base}index.json`, { headers: { "user-agent": SEC_UA, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (idxRes.ok) {
        const idx = (await idxRes.json()) as { directory?: { item?: Array<{ name: string; size?: string }> } };
        const items = idx.directory?.item ?? [];
        const ex = items
          .filter((it) => /\.htm?$/i.test(it.name) && it.name.toLowerCase() !== docName.toLowerCase())
          .sort((a, b) => {
            const score = (n: string) => (/ex-?99|press|earnings|release/i.test(n) ? 2 : /\.htm/i.test(n) ? 1 : 0);
            return score(b.name) - score(a.name) || Number(b.size ?? 0) - Number(a.size ?? 0);
          })[0];
        if (ex && /ex-?99|press|earnings|release/i.test(ex.name)) docName = ex.name;
      }
    } catch { /* fall back to primary document */ }
    const docUrl = `${base}${docName}`;
    let text = (await hydrateBody(docUrl, SEC_UA)) ?? "";
    // derive a human title from the exhibit's first real heading/sentence when it isn't the cover page
    const headLine = text.replace(/\s+/g, " ").trim().slice(0, 140);
    const isExhibit = /ex-?99|press|earnings|release/i.test(docName);
    const title = isExhibit && headLine.length > 25
      ? `${headLine} (${sub.name ?? "issuer"})`
      : `${r.form[i]} — ${r.primaryDocDescription?.[i] || "filing"} (${sub.name ?? "issuer"})`;
    if (!text || text.length < 120) text = title;
    out.push({ url: docUrl, title, text: text.slice(0, 9000), publishedAt: dateIso });
  }
  return out;
}

// Bounded article-body hydration: fetch the page, take the largest readable text block.
export async function hydrateBody(url: string, ua = UA): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": ua, accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const html = await res.text();
    const bodyOnly = html.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? html;
    const article = bodyOnly.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? bodyOnly.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? bodyOnly;
    // prefer block text (<p>, then <div>/<td> for filings / press releases that don't use <p>)
    let blocks = [...article.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripTags(m[1])).filter((t) => t.length > 40);
    if (blocks.length < 3)
      blocks = [...article.matchAll(/<(?:div|td|span|li)[^>]*>([\s\S]*?)<\/(?:div|td|span|li)>/gi)].map((m) => stripTags(m[1])).filter((t) => t.length > 40);
    const text = (blocks.length ? [...new Set(blocks)].join("\n") : stripTags(article)).slice(0, 9000);
    return text.length > 120 ? text : null;
  } catch {
    return null;
  }
}

export async function fetchSourceCandidates(source: SourceRow, sinceIso: string): Promise<FetchOutcome> {
  const sinceMs = Date.parse(sinceIso) || 0;
  const base = { slug: source.slug, candidates: [] as Candidate[], newestPublishedAt: null as string | null };
  if (source.fetch_method === "SKIP_NO_ACCESS")
    return { ...base, attempted: false, ok: true, skippedReason: "source disallows automated access", error: null };
  if (source.fetch_method === "MANUAL")
    return { ...base, attempted: false, ok: true, skippedReason: "manual source", error: null };
  if (!source.canonical_url)
    return { ...base, attempted: false, ok: true, skippedReason: "no canonical_url", error: null };

  try {
    if (source.fetch_method === "SEC_EDGAR") {
      const candidates = await fetchSecEdgar(source.canonical_url, sinceMs);
      const newest = candidates.map((c) => c.publishedAt).filter(Boolean).sort().at(-1) ?? null;
      return { ...base, attempted: true, ok: true, skippedReason: null, error: null, candidates, newestPublishedAt: newest };
    }
    if (source.fetch_method === "RSS" || source.fetch_method === "API") {
      const res = await fetch(source.canonical_url, {
        headers: { "user-agent": UA, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ...base, attempted: true, ok: false, skippedReason: null, error: `HTTP ${res.status}` };
      const body = await res.text();
      const candidates = source.fetch_method === "RSS" ? parseFeed(body, sinceMs) : [];
      const newest = candidates.map((c) => c.publishedAt).filter(Boolean).sort().at(-1) ?? null;
      return { ...base, attempted: true, ok: true, skippedReason: source.fetch_method === "API" ? "API parser not implemented for this source" : null, error: null, candidates, newestPublishedAt: newest };
    }
    // HTML without a bespoke parser -> zero candidates (never guess).
    return { ...base, attempted: true, ok: true, skippedReason: `no structured parser for ${source.slug} (HTML)`, error: null };
  } catch (e) {
    return { ...base, attempted: true, ok: false, skippedReason: null, error: `fetch error: ${(e as Error).message}` };
  }
}
