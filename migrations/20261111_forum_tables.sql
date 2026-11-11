-- 2026-11-11（使用者核准，會員討論區）: 會員之間發文回覆、無私訊；需要檢舉/封鎖/管理員刪文/
-- 使用條款同意。新建6張獨立表，不碰public.users既有結構（跟這次任務一直在用的同一個模式：
-- 寧可新表，不對既有大表做ALTER）。forum_admins刻意留空——不自己指定誰是管理員，使用者自行
-- 決定後再INSERT。已套用到正式環境（三道保護：先確認都不存在→交易建表→commit後重查
-- information_schema驗證欄位，見本次任務紀錄）。

CREATE TABLE forum_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_user_id text NOT NULL REFERENCES public.users(id),
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by_admin boolean NOT NULL DEFAULT false,
  reply_count int NOT NULL DEFAULT 0
);

CREATE TABLE forum_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES forum_posts(id),
  author_user_id text NOT NULL REFERENCES public.users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by_admin boolean NOT NULL DEFAULT false
);

CREATE TABLE forum_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('POST','REPLY')),
  target_id uuid NOT NULL,
  reporter_user_id text NOT NULL REFERENCES public.users(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_action text CHECK (resolved_action IN ('DISMISSED','CONTENT_DELETED'))
);

CREATE TABLE forum_blocks (
  blocker_user_id text NOT NULL REFERENCES public.users(id),
  blocked_user_id text NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);

CREATE TABLE forum_tos_acceptances (
  user_id text PRIMARY KEY REFERENCES public.users(id),
  tos_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE forum_admins (
  user_id text PRIMARY KEY REFERENCES public.users(id),
  granted_at timestamptz NOT NULL DEFAULT now()
);
