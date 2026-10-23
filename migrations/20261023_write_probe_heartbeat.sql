-- 2026-10-23（使用者核准）: 連線池唯讀事故（03:04-05:25 UTC）發生時，沒有任何東西主動告警，
-- 一直到健康報告隔天00:30才會發現，中間超過2小時所有寫入排程全部默默失敗。這張表讓一支每15
-- 分鐘的探測route直接用正式App的DATABASE_URL做一次真實UPDATE，失敗就立刻透過Telegram通知，
-- 不用等到隔天的健康報告。
CREATE TABLE IF NOT EXISTS write_probe_heartbeat (
  id text PRIMARY KEY,
  last_write_at timestamptz NOT NULL DEFAULT now(),
  counter bigint NOT NULL DEFAULT 0
);

ALTER TABLE write_probe_heartbeat ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON write_probe_heartbeat FROM anon, authenticated;

INSERT INTO write_probe_heartbeat (id, counter)
VALUES ('singleton', 0)
ON CONFLICT (id) DO NOTHING;
