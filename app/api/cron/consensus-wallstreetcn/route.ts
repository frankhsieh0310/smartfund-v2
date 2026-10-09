// Function 3 (大佬觀點・共識雷達) — WallStreetCN 7x24 live-feed ingestion.
//
// Real, confirmed contract (2026-09-27, one live GET against the public endpoint):
//   GET https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=<channel>&client=pc&limit=<n>
//   -> { code, message, data: { items: [{ id, title, content_text, display_time (unix s),
//        score, channels[], symbols[], uri, ... }] } }
// `score` is WallStreetCN's OWN importance marking (observed 1/2/3 in a live sample) — we only ever
// filter on it (score >= 2), never compute our own "importance".
//
// Person attribution reuses the EXISTING curated PEOPLE map (lib/consensus/displayLocalization.ts,
// already used by the web 大佬動向雷達 page) — a Chinese-name substring match against title+content,
// not a new/second person registry. No match -> IMPORTANT_EVENT. relatedTickers come straight from
// WallStreetCN's own `symbols` field; relatedCompanies only filled when that ticker is already in the
// existing COMPANIES map. No stance is ever set here — see consensus_feed_items.stance comment.
//
// Trigger: GitHub Actions schedule -> GET with `Authorization: Bearer <CRON_SECRET>`.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { PEOPLE, COMPANIES } from "@/lib/consensus/displayLocalization";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const WSCN_BASE = "https://api-one-wscn.awtmt.com/apiv1/content/lives";
const SCORE_THRESHOLD = 2;

type WscnItem = {
  id: number; title: string; content_text: string; display_time: number;
  score: number; channels: string[]; symbols: string[]; uri: string;
};

async function fetchLiveFeed(channel: string, limit: number): Promise<WscnItem[]> {
  const url = `${WSCN_BASE}?channel=${encodeURIComponent(channel)}&client=pc&limit=${limit}`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`WSCN_HTTP_${r.status}`);
  const j = await r.json();
  if (j.code !== 20000) throw new Error(`WSCN_API_ERROR_${j.code}_${j.message}`);
  return j.data.items ?? [];
}

// PEOPLE's Chinese names are Traditional-script, Taiwan-convention transliterations. WallStreetCN
// publishes in Simplified Chinese, often with mainland-convention transliterations that differ from
// Taiwan's even after script conversion (e.g. Trump: 川普 vs 特朗普; Powell: 鮑爾 vs 鲍威尔) — so a bare
// substring match against PEOPLE.name alone misses almost everyone. This adds the standard mainland
// Simplified transliteration actually used by financial media, as a second match key per person —
// still a real, standard name, never a guess at content.
const SIMPLIFIED_ALIASES: Record<string, string> = {
  "Donald Trump": "特朗普", "Jerome Powell": "鲍威尔", "Scott Bessent": "贝森特",
  "Howard Lutnick": "卢特尼克", "Jamieson Greer": "格里尔", "John C. Williams": "威廉姆斯",
  "Christopher Waller": "沃勒", "Michelle Bowman": "鲍曼", "Jensen Huang": "黄仁勋",
  "Lisa Su": "苏姿丰", "Satya Nadella": "纳德拉", "Mark Zuckerberg": "扎克伯格",
  "Tim Cook": "库克", "Andy Jassy": "贾西", "Elon Musk": "马斯克", "Hock Tan": "陈福阳",
  "Lip-Bu Tan": "陈立武", "Cristiano Amon": "安蒙", "Bill Ackman": "阿克曼", "Ray Dalio": "达利欧",
  "Howard Marks": "马克斯",
};

// A bare name mention is not the same as that person's OWN statement — most WallStreetCN items
// mentioning a name are reporting on an EVENT they're involved in, not quoting them (e.g. "習近平和
// 彭麗媛同美國總統特朗普夫婦茶敘" mentions Trump but isn't his viewpoint). PERSON_VIEWPOINT requires the
// name to be immediately followed by a real Chinese reported-speech verb — a standard, well-known
// pattern in Chinese news writing ("特朗普表示…", "鮑威爾稱…"), not a guess at the item's meaning.
const SPEECH_VERB_PATTERN = "(表示|說|称|稱|指出|強調|强调|警告|認為|认为|談及|谈及|回應|回应|宣布|重申)";
function hasOwnStatement(text: string, name: string): boolean {
  return new RegExp(`${name}[^。！？，,\\n]{0,8}${SPEECH_VERB_PATTERN}`).test(text);
}

function matchPerson(text: string): { englishKey: string; zhName: string } | null {
  for (const [englishKey, display] of Object.entries(PEOPLE)) {
    if (text.includes(display.name) && hasOwnStatement(text, display.name)) return { englishKey, zhName: display.name };
    const alias = SIMPLIFIED_ALIASES[englishKey];
    if (alias && text.includes(alias) && hasOwnStatement(text, alias)) return { englishKey, zhName: display.name };
  }
  return null;
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const url = new URL(request.url);
  const channel = url.searchParams.get("channel") ?? "global-channel";
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));

  const items = await fetchLiveFeed(channel, limit);
  const important = items.filter((i) => i.score >= SCORE_THRESHOLD);

  let personViewpointCount = 0;
  let importantEventCount = 0;
  let upserted = 0;
  const errors: Array<{ id: number; error: string }> = [];

  for (const item of important) {
    try {
      const hay = `${item.title} ${item.content_text}`;
      const person = matchPerson(hay);
      const itemType = person ? "PERSON_VIEWPOINT" : "IMPORTANT_EVENT";
      if (person) personViewpointCount++; else importantEventCount++;

      const relatedTickers = item.symbols ?? [];
      // Positionally aligned with relatedTickers (null where no mapped company name exists) — the
      // read API's consensus aggregation relies on this alignment to look up a ticker's display name.
      const relatedCompanies = relatedTickers.map((t) => COMPANIES[t.toUpperCase()] ?? null);

      await prisma.$executeRawUnsafe(
        `INSERT INTO consensus_feed_items
           (source, external_id, published_at, title, content, score, channel, source_url,
            item_type, person_slug, person_display_name, related_tickers, related_companies, related_industries, stance)
         VALUES ('WALLSTREETCN', $1, to_timestamp($2), $3, $4, $5, $6::text[], $7, $8, $9, $10, $11::text[], $12::text[], '{}', NULL)
         ON CONFLICT (source, external_id) DO UPDATE SET
           published_at = EXCLUDED.published_at, title = EXCLUDED.title, content = EXCLUDED.content,
           score = EXCLUDED.score, channel = EXCLUDED.channel, source_url = EXCLUDED.source_url,
           item_type = EXCLUDED.item_type, person_slug = EXCLUDED.person_slug,
           person_display_name = EXCLUDED.person_display_name, related_tickers = EXCLUDED.related_tickers,
           related_companies = EXCLUDED.related_companies`,
        String(item.id), item.display_time, item.title, item.content_text, item.score, item.channels,
        item.uri, itemType, person?.englishKey ?? null, person?.zhName ?? null, relatedTickers, relatedCompanies,
      );
      upserted++;
    } catch (e) {
      errors.push({ id: item.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return Response.json({
    ok: true, channel, fetched: items.length, importantFound: important.length,
    personViewpointCount, importantEventCount, upserted, errors,
  });
}
