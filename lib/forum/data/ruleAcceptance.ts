import { getForumPool } from "../pgPool.ts";

export async function hasAcceptedRuleVersion(profileId: string, ruleVersion: string): Promise<boolean> {
  const result = await getForumPool().query(
    `SELECT 1 FROM forum.rule_acceptance WHERE profile_id = $1 AND rule_version = $2 LIMIT 1`,
    [profileId, ruleVersion],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function acceptRuleVersion(profileId: string, ruleVersion: string): Promise<void> {
  await getForumPool().query(
    `INSERT INTO forum.rule_acceptance (profile_id, rule_version) VALUES ($1, $2)
     ON CONFLICT (profile_id, rule_version) DO NOTHING`,
    [profileId, ruleVersion],
  );
}
