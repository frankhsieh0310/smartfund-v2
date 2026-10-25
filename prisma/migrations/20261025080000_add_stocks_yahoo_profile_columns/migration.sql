-- 2026-10-25（使用者核准定案）: 選股反查基金持股比對——跨市場掛牌名稱歧義判斷需要Yahoo的
-- longName（公司全名，用來確認是不是同一家公司）跟assetProfile.country（總部國家，用來在
-- 同一家公司的多個掛牌裡選出對的那一檔）。只新增兩個可為空的欄位，不改動任何既有欄位，
-- 不設預設值。
ALTER TABLE stocks ADD COLUMN yahoo_long_name text;
ALTER TABLE stocks ADD COLUMN yahoo_hq_country text;
