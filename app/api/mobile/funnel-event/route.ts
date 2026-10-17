// 2026-10-18 固定範圍第 1+5 項: ingests one usage-funnel event from the App. Write-only, no read
// endpoint here (reporting is app/api/admin/funnel-report, internal-only). Never records a
// "download" -- FIRST_OPEN is the earliest event this table can ever hold.
import { prisma } from "@/lib/prisma";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const EVENT_TYPES = ["FIRST_OPEN", "COMPLETED_OVERLAP", "SAVED_PORTFOLIO", "TRIAL_STARTED", "FIRST_PAYMENT", "SECOND_PAYMENT_MONTHLY"] as const;
const SOURCE_TYPES = ["INVITE_CODE", "AD_CHANNEL", "ORGANIC", "UNKNOWN"] as const;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "POST, OPTIONS" } });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "INVALID_JSON" }, { status: 400, headers });
  }
  const b = body as Record<string, unknown>;
  const deviceId = typeof b.deviceId === "string" ? b.deviceId.trim() : "";
  const eventType = typeof b.eventType === "string" ? b.eventType : "";
  const sourceType = typeof b.sourceType === "string" && (SOURCE_TYPES as readonly string[]).includes(b.sourceType) ? b.sourceType : "UNKNOWN";
  if (!deviceId || deviceId.length > 200) return Response.json({ ok: false, error: "INVALID_DEVICE_ID" }, { status: 400, headers });
  if (!(EVENT_TYPES as readonly string[]).includes(eventType)) return Response.json({ ok: false, error: "INVALID_EVENT_TYPE" }, { status: 400, headers });

  const userId = typeof b.userId === "string" && /^[0-9a-f-]{36}$/i.test(b.userId) ? b.userId : null;
  const sourceDetail = typeof b.sourceDetail === "string" ? b.sourceDetail.slice(0, 200) : null;
  const platform = typeof b.platform === "string" ? b.platform.slice(0, 20) : null;
  const appVersion = typeof b.appVersion === "string" ? b.appVersion.slice(0, 20) : null;
  const metadata = b.metadata && typeof b.metadata === "object" ? b.metadata : null;

  await prisma.$executeRawUnsafe(
    `INSERT INTO usage_funnel_events (device_id, user_id, event_type, source_type, source_detail, platform, app_version, metadata)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb)`,
    deviceId, userId, eventType, sourceType, sourceDetail, platform, appVersion, metadata ? JSON.stringify(metadata) : null,
  );
  return Response.json({ ok: true }, { headers });
}
