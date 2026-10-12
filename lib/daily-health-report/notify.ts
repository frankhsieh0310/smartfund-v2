// Notification channel for anomalies. Investigated both candidates the task named:
//   - "現有推播" (lib/consensus/push.ts, Expo push service): targets END-USER device tokens
//     (watchlistNotificationProfile, channelType='APP_PUSH') for consensus-flip alerts. There is no
//     "operator"/"admin" device registered through that table, so there is no real recipient for an
//     internal ops alert today -- reusing it would silently send to nobody.
//   - email (Resend/SendGrid/SMTP): no env var (RESEND_API_KEY, SENDGRID_API_KEY, SMTP_*) is set and
//     no send helper exists anywhere in the codebase.
// Conclusion (reported, not fixed here): neither channel is actually wired for this purpose yet. This
// function logs the anomaly loudly to the run's own `details` (already persisted via finishRun) and
// returns a structured result the caller can act on -- it does NOT silently pretend to have notified
// anyone. Wiring a real channel needs the user's decision (which recipient, which service).
export type NotifyResult = { attempted: boolean; channel: "NONE"; reason: string };

export async function notifyAnomaly(_summary: string): Promise<NotifyResult> {
  return {
    attempted: false,
    channel: "NONE",
    reason: "No operator-facing channel configured: push targets end-user devices only, no email service wired.",
  };
}
