import { prisma } from "@/lib/prisma";

export async function isForumAdmin(userId: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ user_id: string }>>(
    `SELECT user_id FROM forum_admins WHERE user_id = $1`,
    userId,
  );
  return rows.length > 0;
}
