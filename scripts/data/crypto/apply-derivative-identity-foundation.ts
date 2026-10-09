import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
const db=new PrismaClient({datasources:{db:{url:process.env.DATABASE_URL}}});
async function main(){const file=process.argv[2]??"prisma/migrations/20260816103000_crypto_derivative_cross_domain_identity/migration.sql";const sql=await readFile(file,"utf8");const statements=sql.split(";").map(x=>x.trim()).filter(Boolean);for(const statement of statements)await db.$executeRawUnsafe(statement);console.log(JSON.stringify({migration:file,status:"APPLIED",statements:statements.length}));}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());
