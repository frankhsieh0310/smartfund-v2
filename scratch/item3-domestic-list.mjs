import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);

// pick 10 domestic (non-yahoo/SEC) funds with a recent fund_distribution_observations row, including
// 野村/元大/國泰, preferring monthly-paying (月配) names
const rows = await prisma.$queryRawUnsafe(`
  SELECT f.id, f.code, f.name, f.company, fd.ex_date, fd.distribution_amount
  FROM funds f
  JOIN LATERAL (
    SELECT ex_date, distribution_amount FROM fund_distribution_observations
    WHERE fund_id = f.id ORDER BY ex_date DESC LIMIT 1
  ) fd ON true
  WHERE f.company IN ('野村證券投資信託股份有限公司','元大證券投資信託股份有限公司','國泰證券投資信託股份有限公司')
    AND f.name ~ '月配'
  ORDER BY f.company, fd.ex_date DESC
  LIMIT 15
`);
console.log(JSON.stringify(rows, null, 1));
await prisma.$disconnect();
