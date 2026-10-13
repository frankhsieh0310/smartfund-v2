// SmartMatch 共識雷達 — push delivery (Phase 8). No AI. Objective copy only, never advice.
//
// Transport: Expo Push Service (https://exp.host/--/api/v2/push/send) — the right choice for a
// React Native / Expo build. A raw web build has no native token, so real deliveries only happen
// once a mobile build registers an ExponentPushToken. The in-app notification record is written
// regardless of push permission.

import { createHash } from "node:crypto";

export type QueryFn = <T = Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]>;

export const MAX_ALERTS_PER_RUN = Number(process.env.CONSENSUS_MAX_ALERTS_PER_RUN) || 100;
export const MAX_DELIVERIES_PER_RUN = Number(process.env.CONSENSUS_MAX_DELIVERIES_PER_RUN) || 500;

export const hashToken = (t: string | null | undefined) =>
  t ? createHash("sha256").update(t).digest("hex").slice(0, 16) : null;

const FLIP_ZH: Record<string, string> = {
  BEAR_TO_BULL: "由看空轉為看多", BULL_TO_BEAR: "由看多轉為看空",
  NEUTRAL_TO_BULL: "由中立轉為看多", NEUTRAL_TO_BEAR: "由中立轉為看空",
  BULL_TO_NEUTRAL: "由看多轉為中立", BEAR_TO_NEUTRAL: "由看空轉為中立",
};

export type PushMessage = {
  to: string; // ExponentPushToken[...]
  title: string;
  body: string;
  channelId?: string;
  data: {
    type: "CONSENSUS_FLIP" | "CONSENSUS_WARMING";
    symbol: string;
    person_id: string;
    flip_signal_id: string | null;
    alert_candidate_id: string;
    route: string;
    created_at: string;
  };
};

export function buildFlipCopy(input: { symbol: string; person: string; flipType: string }): { title: string; body: string } {
  return {
    title: `${input.symbol} 觀點翻轉`,
    body: `${input.person}近期公開觀點對 ${input.symbol} ${FLIP_ZH[input.flipType] ?? "有變化"}。（僅為公開發言彙整，非投資建議）`,
  };
}
export function buildWarmingCopy(input: { symbol: string }): { title: string; body: string } {
  return {
    title: `${input.symbol} 共識升溫`,
    body: `近期多位追蹤人物對 ${input.symbol} 的公開觀點轉強。（僅為公開發言彙整，非投資建議）`,
  };
}

type ExpoTicket = { status: "ok" | "error"; id?: string; message?: string; details?: { error?: string } };

export async function sendExpoPush(messages: PushMessage[]): Promise<ExpoTicket[]> {
  if (messages.length === 0) return [];
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (process.env.EXPO_ACCESS_TOKEN) headers.authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers,
    body: JSON.stringify(messages),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`expo push HTTP ${res.status}`);
  const body = (await res.json()) as { data?: ExpoTicket[]; errors?: unknown };
  return Array.isArray(body.data) ? body.data : messages.map(() => ({ status: "error", message: "no ticket" }));
}

export function ticketToStatus(t: ExpoTicket): "DELIVERED" | "INVALID_TOKEN" | "FAILED" {
  if (t.status === "ok") return "DELIVERED";
  const err = t.details?.error ?? t.message ?? "";
  if (/DeviceNotRegistered|InvalidCredentials|invalid.*token|not.*registered/i.test(err)) return "INVALID_TOKEN";
  return "FAILED";
}
