-- Additive new table + RLS + REVOKE only, same pattern/approval as the other tables added this
-- session (tw_purchasable_classification, external_number_audit_log).
--
-- 2026-10-18 固定範圍第 1+5 項 (下載與首次開啟分開 / 使用統計漏斗): one event log for the whole
-- funnel -- 首次開啟 -> 完成組合穿透 -> 儲存組合 -> 開始試用 -> 首次付款 -> 第二次付款(僅月繳) --
-- segmented by acquisition source and cohort (join) week. Written only via this app's own backend
-- API (service-role Prisma connection), never directly from the client, so no anon/authenticated
-- grant is needed -- same architecture as every other mobile-facing table in this project.
-- Deliberately does NOT store a "download count" -- that number only exists in App Store
-- Connect/Google Play Console and is entered/reported separately, never derived from this table
-- (a first_open event is not a download; a device can download without ever opening, and store
-- download counts are not queryable via any API this project has access to).
CREATE TABLE IF NOT EXISTS usage_funnel_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     text NOT NULL,
  user_id       uuid,
  event_type    text NOT NULL CHECK (event_type IN (
                  'FIRST_OPEN', 'COMPLETED_OVERLAP', 'SAVED_PORTFOLIO',
                  'TRIAL_STARTED', 'FIRST_PAYMENT', 'SECOND_PAYMENT_MONTHLY'
                )),
  source_type   text NOT NULL DEFAULT 'UNKNOWN' CHECK (source_type IN (
                  'INVITE_CODE', 'AD_CHANNEL', 'ORGANIC', 'UNKNOWN'
                )),
  source_detail text,
  platform      text,
  app_version   text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_funnel_events_device_idx ON usage_funnel_events (device_id, event_type);
CREATE INDEX IF NOT EXISTS usage_funnel_events_type_time_idx ON usage_funnel_events (event_type, occurred_at);
CREATE INDEX IF NOT EXISTS usage_funnel_events_source_idx ON usage_funnel_events (source_type, occurred_at);

ALTER TABLE usage_funnel_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON usage_funnel_events FROM anon, authenticated;
