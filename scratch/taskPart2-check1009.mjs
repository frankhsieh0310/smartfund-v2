import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 8000`);
const rows = await prisma.$queryRawUnsafe(`
  SELECT sh.stock_id, s.ticker, to_char(sh.date,'YYYY-MM-DD') d, sh.close, to_char(sh.created_at,'YYYY-MM-DD HH24:MI:SS') created
  FROM stock_history sh JOIN stocks s ON s.id = sh.stock_id
  WHERE sh.date = '2026-10-09' LIMIT 15
`);
console.log(JSON.stringify(rows, null, 1));
// compare with 10/8 and 10/12 for same stocks
const ids = rows.map(r=>r.stock_id);
const compare = await prisma.$queryRawUnsafe(`
  SELECT stock_id, to_char(date,'YYYY-MM-DD') d, close FROM stock_history WHERE stock_id = ANY($1) AND date IN ('2026-10-08','2026-10-09','2026-10-12') ORDER BY stock_id, date
`, ids);
console.log(JSON.stringify(compare, null, 1));
await prisma.$disconnect();
