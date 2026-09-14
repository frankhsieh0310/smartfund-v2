// SmartMatch 共識雷達 — viewpoint flip detection (Phase 6). No AI. Deterministic DB compare.
//
// A flip = same person + same symbol + same relation_type, an earlier CLASSIFIED valid stance
// (BULLISH/BEARISH/NEUTRAL) changing to a DIFFERENT valid current stance, the two events <=
// MAX_FLIP_GAP_DAYS apart. UNCLEAR / MIXED / NO_VIEW are not "valid stances" and never take part.
// One original statement is one consensus_events row (canonical_event_key), so media re-syndication
// cannot manufacture or re-fire a flip.

export type QueryFn = <T = Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]>;

export const MAX_FLIP_GAP_DAYS = Number(process.env.CONSENSUS_MAX_FLIP_GAP_DAYS) || 90;
// A flip whose current event is older than this is recorded but NEVER pushed — so a 6-month
// backfill can't suddenly alert users about stale reversals. It still shows in-app as "歷史觀點翻轉".
export const ALERT_MAX_AGE_HOURS = Number(process.env.CONSENSUS_ALERT_MAX_AGE_HOURS) || 24;

export type FlipType =
  | "BEAR_TO_BULL" | "BULL_TO_BEAR" | "NEUTRAL_TO_BULL" | "NEUTRAL_TO_BEAR"
  | "BULL_TO_NEUTRAL" | "BEAR_TO_NEUTRAL";
export type Strength = "STRONG" | "MEDIUM" | "WEAK";

const VALID = new Set(["BULLISH", "BEARISH", "NEUTRAL"]);
// push by default only on the four "hard" direction changes; the two -> NEUTRAL are recorded only.
export const PUSH_TYPES = new Set<FlipType>(["BEAR_TO_BULL", "BULL_TO_BEAR", "NEUTRAL_TO_BULL", "NEUTRAL_TO_BEAR"]);

export function flipType(prev: string, curr: string): FlipType | null {
  const k = `${prev}->${curr}`;
  const m: Record<string, FlipType> = {
    "BEARISH->BULLISH": "BEAR_TO_BULL",
    "BULLISH->BEARISH": "BULL_TO_BEAR",
    "NEUTRAL->BULLISH": "NEUTRAL_TO_BULL",
    "NEUTRAL->BEARISH": "NEUTRAL_TO_BEAR",
    "BULLISH->NEUTRAL": "BULL_TO_NEUTRAL",
    "BEARISH->NEUTRAL": "BEAR_TO_NEUTRAL",
  };
  return m[k] ?? null;
}

const gradeWeight = (g: string | null) => (g === "A" ? 1 : g === "B" ? 0.85 : 0.5);

// deterministic — the LLM never sets alert importance.
export function flipStrength(input: {
  prevStrength: number; currStrength: number; currConfidence: number;
  currGrade: string | null; gapDays: number;
}): Strength {
  const conviction = Math.min(input.prevStrength, input.currStrength) * Math.max(0.5, input.currConfidence);
  const recency = input.gapDays <= 14 ? 1 : input.gapDays <= 30 ? 0.85 : input.gapDays <= 60 ? 0.65 : 0.45;
  const score = conviction * gradeWeight(input.currGrade) * recency;
  if (score >= 0.72 && gradeWeight(input.currGrade) >= 0.85 && input.gapDays <= 45) return "STRONG";
  if (score >= 0.5) return "MEDIUM";
  return "WEAK";
}

type LinkRow = {
  event_id: string; event_at: string; stance: string; stock_id: string | null;
  statement_strength: number | null; confidence: number | null; source_grade: string | null;
};

export type DetectResult = {
  tuplesScanned: number;
  detected: number;
  upserted: number;
  byType: Record<string, number>;
  direct: number;
  inferred: number;
  pushEligible: number;
};

export async function detectConsensusFlips(
  query: QueryFn,
  opts: { sinceIso?: string | null } = {},
): Promise<DetectResult> {
  const res: DetectResult = { tuplesScanned: 0, detected: 0, upserted: 0, byType: {}, direct: 0, inferred: 0, pushEligible: 0 };

  // (person, symbol, relation) tuples with >= 2 classified valid-stance links; when a checkpoint is
  // given, only tuples that had an event created/updated since then.
  const tuples = (await query<{ person_id: string; symbol: string; relation_type: "DIRECT" | "INFERRED" }>(
    `select e.person_id, sl.symbol, sl.relation_type
       from consensus_stock_links sl
       join consensus_events e on e.id = sl.event_id
      where e.extraction_status = 'CLASSIFIED'
        and e.stance in ('BULLISH','BEARISH','NEUTRAL')
        ${opts.sinceIso ? "" : ""}
      group by e.person_id, sl.symbol, sl.relation_type
      having count(*) >= 2
         ${opts.sinceIso ? "and max(greatest(e.updated_at, e.created_at)) >= $1::timestamptz" : ""}`,
    opts.sinceIso ? [opts.sinceIso] : [],
  )) as Array<{ person_id: string; symbol: string; relation_type: "DIRECT" | "INFERRED" }>;
  res.tuplesScanned = tuples.length;

  for (const t of tuples) {
    const links = (await query<LinkRow>(
      `select sl.event_id, e.event_at, e.stance, sl.stock_id,
              e.statement_strength, e.confidence, s.source_grade
         from consensus_stock_links sl
         join consensus_events e on e.id = sl.event_id
         left join consensus_sources s on s.id = e.source_id
        where e.person_id = $1 and sl.symbol = $2 and sl.relation_type = $3
          and e.extraction_status = 'CLASSIFIED' and e.stance in ('BULLISH','BEARISH','NEUTRAL')
        order by e.event_at asc, e.created_at asc`,
      [t.person_id, t.symbol, t.relation_type],
    )) as LinkRow[];
    if (links.length < 2) continue;

    for (let i = 1; i < links.length; i++) {
      const prev = links[i - 1];
      const curr = links[i];
      if (!VALID.has(prev.stance) || !VALID.has(curr.stance) || prev.stance === curr.stance) continue;
      const gapDays = Math.round((Date.parse(curr.event_at) - Date.parse(prev.event_at)) / 86_400_000);
      if (gapDays > MAX_FLIP_GAP_DAYS) continue; // treat as a fresh stance, not a flip
      const ft = flipType(prev.stance, curr.stance);
      if (!ft) continue;
      res.detected++;

      const strength = flipStrength({
        prevStrength: Number(prev.statement_strength ?? 0.6),
        currStrength: Number(curr.statement_strength ?? 0.6),
        currConfidence: Number(curr.confidence ?? 0.6),
        currGrade: curr.source_grade,
        gapDays,
      });
      const ageHours = (Date.now() - Date.parse(curr.event_at)) / 3_600_000;
      const push = PUSH_TYPES.has(ft) && ageHours <= ALERT_MAX_AGE_HOURS;

      const up = await query<{ id: string }>(
        `insert into consensus_flip_signals
          (person_id, stock_id, symbol, relation_type, previous_event_id, current_event_id,
           previous_stance, current_stance, previous_event_at, current_event_at, gap_days,
           flip_type, strength, confidence, push_eligible, source_grade, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
         on conflict (person_id, symbol, previous_event_id, current_event_id) do update set
           current_stance = excluded.current_stance, flip_type = excluded.flip_type,
           strength = excluded.strength, confidence = excluded.confidence,
           push_eligible = excluded.push_eligible, source_grade = excluded.source_grade,
           stock_id = excluded.stock_id, updated_at = now()
         returning id`,
        [t.person_id, curr.stock_id, t.symbol, t.relation_type, prev.event_id, curr.event_id,
         prev.stance, curr.stance, prev.event_at, curr.event_at, gapDays,
         ft, strength, Number(curr.confidence ?? 0.6), push, curr.source_grade],
      );
      if (up[0]) {
        res.upserted++;
        res.byType[ft] = (res.byType[ft] ?? 0) + 1;
        if (t.relation_type === "DIRECT") res.direct++; else res.inferred++;
        if (push) res.pushEligible++;
      }
    }
  }
  return res;
}

// Build channel-agnostic alert candidates for STRONG + DIRECT + A/B-source push-eligible flips that
// don't have a candidate yet. Returns the number created.
export async function buildAlertCandidates(query: QueryFn): Promise<number> {
  const rows = (await query<{ c: number }>(
    `with created as (
       insert into consensus_alert_candidates (flip_signal_id, person_id, symbol, title, body, priority)
       select f.id, f.person_id, f.symbol,
              p.display_name || '：' || f.symbol || ' ' ||
                (case f.previous_stance when 'BULLISH' then '看多' when 'BEARISH' then '看空' else '中立' end) || ' → ' ||
                (case f.current_stance  when 'BULLISH' then '看多' when 'BEARISH' then '看空' else '中立' end) as title,
              coalesce(e.summary_zh, e.source_title, '觀點翻轉') as body,
              'HIGH' as priority
         from consensus_flip_signals f
         join consensus_people p on p.id = f.person_id
         join consensus_events e on e.id = f.current_event_id
    left join consensus_alert_candidates ac on ac.flip_signal_id = f.id
        where f.push_eligible and f.strength = 'STRONG' and f.relation_type = 'DIRECT'
          and coalesce(f.source_grade,'C') in ('A','B') and ac.id is null
       on conflict (flip_signal_id) do nothing
       returning 1
     )
     select count(*)::int c from created`,
    [],
  )) as Array<{ c: number }>;
  return Number(rows[0]?.c ?? 0);
}
