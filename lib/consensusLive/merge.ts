// Same-event merge (P0). Groups qualifying extracted items by speaker + organization (exact), then
// within each speaker/org group, clusters chronologically: a new item joins the running cluster only
// when it is within MERGE_WINDOW_MINUTES of the cluster's last member AND its topic genuinely
// overlaps the cluster's topic (checked via a generic longest-common-substring test on the
// normalized topic_name, not a keyword dictionary) AND its topicType matches — topicType is only an
// auxiliary check here, never the primary grouping key, so "原油" vs "黃金" from the same speaker in
// the same hour never merge just because both happen to be COMMODITY.
import type { ExtractedOpinion, LiveOpinionCard, Stance } from "./types";
import { synthesizeMergedCard } from "./extract";

const MERGE_WINDOW_MINUTES = 60;
const MIN_TOPIC_OVERLAP_LEN = 2;

function normalizeIdentity(s: string | null): string {
  return (s ?? "").trim().toLowerCase();
}

function normalizeTopicName(s: string | null): string {
  return (s ?? "").trim().toLowerCase().replace(/[\s,，。.、/／:：;；()（）"'「」]/g, "");
}

// Generic longest-common-contiguous-substring length — no commodity/topic keyword list needed.
// "布倫特原油價格" / "原油供應能力" / "原油商業庫存" / "原油供應鏈運費" all share "原油" (len 2);
// "原油" and "黃金" share nothing >= 2, so they never match.
function longestCommonSubstringLen(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
      if (dp[j] > best) best = dp[j];
      prev = temp;
    }
  }
  return best;
}

function topicsOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return longestCommonSubstringLen(a, b) >= MIN_TOPIC_OVERLAP_LEN;
}

type Qualified = ExtractedOpinion & {
  speakerName: string; organization: string; topicType: NonNullable<ExtractedOpinion["topicType"]>;
  topicName: string; stance: Stance; summaryZh: string; reasonZh: string;
};

export async function mergeIntoCards(opinions: ExtractedOpinion[]): Promise<LiveOpinionCard[]> {
  const qualified = opinions.filter(
    (o): o is Qualified =>
      o.qualifies && !!o.speakerName && !!o.organization && !!o.topicType && !!o.topicName && !!o.stance && !!o.summaryZh && !!o.reasonZh,
  );

  const byIdentity = new Map<string, Qualified[]>();
  for (const o of qualified) {
    const key = `${normalizeIdentity(o.speakerName)}|${normalizeIdentity(o.organization)}`;
    const arr = byIdentity.get(key) ?? [];
    arr.push(o);
    byIdentity.set(key, arr);
  }

  const clusters: Qualified[][] = [];
  for (const members of byIdentity.values()) {
    const sorted = members.slice().sort((a, b) => a.sourceItem.display_time - b.sourceItem.display_time);
    // Each open cluster carries a representative (its first member) for topic-overlap checks.
    const openClusters: { representative: Qualified; items: Qualified[] }[] = [];
    for (const m of sorted) {
      const mTopic = normalizeTopicName(m.topicName);
      let attached = false;
      for (const cluster of openClusters) {
        const last = cluster.items[cluster.items.length - 1];
        const gapMinutes = (m.sourceItem.display_time - last.sourceItem.display_time) / 60;
        const repTopic = normalizeTopicName(cluster.representative.topicName);
        if (gapMinutes <= MERGE_WINDOW_MINUTES && m.topicType === cluster.representative.topicType && topicsOverlap(mTopic, repTopic)) {
          cluster.items.push(m);
          attached = true;
          break;
        }
      }
      if (!attached) openClusters.push({ representative: m, items: [m] });
    }
    for (const c of openClusters) clusters.push(c.items);
  }

  const cards: LiveOpinionCard[] = [];
  for (const cluster of clusters) {
    const latest = cluster.slice().sort((a, b) => b.sourceItem.display_time - a.sourceItem.display_time)[0];
    const fields = cluster.length > 1
      ? await synthesizeMergedCard(cluster)
      : { topicName: latest.topicName, stance: latest.stance, summaryZh: latest.summaryZh, reasonZh: latest.reasonZh };
    cards.push({
      id: `live-${latest.sourceItem.id}`,
      speakerName: latest.speakerName,
      organization: latest.organization,
      role: latest.role,
      topicType: latest.topicType,
      topicName: fields.topicName || latest.topicName,
      ticker: latest.ticker,
      stance: fields.stance ?? "UNCLEAR",
      summaryZh: fields.summaryZh,
      reasonZh: fields.reasonZh,
      viewChanged: cluster.some((m) => m.viewChanged),
      publishedAt: new Date(latest.sourceItem.display_time * 1000).toISOString(),
      sourceLabel: "華爾街見聞",
      sourceUrls: cluster.map((m) => m.sourceItem.uri),
      sourceItemCount: cluster.length,
    });
  }

  return cards.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}
