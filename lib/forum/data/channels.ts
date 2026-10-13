import { getForumPool } from "../pgPool.ts";

export interface ForumChannel {
  id: string;
  slug: string;
  name: string;
  description: string;
  officialOnly: boolean;
}

export async function listChannels(): Promise<ForumChannel[]> {
  const result = await getForumPool().query<{
    id: string;
    slug: string;
    name: string;
    description: string;
    official_only: boolean;
  }>(`SELECT id, slug, name, description, official_only FROM forum.channels ORDER BY sort_order, name`);

  return result.rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    officialOnly: row.official_only,
  }));
}

export async function getChannelById(channelId: string): Promise<ForumChannel | null> {
  const result = await getForumPool().query<{
    id: string;
    slug: string;
    name: string;
    description: string;
    official_only: boolean;
  }>(`SELECT id, slug, name, description, official_only FROM forum.channels WHERE id = $1`, [channelId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    officialOnly: row.official_only,
  };
}
