import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { prisma } from '../../../lib/prisma.ts'

const root=resolve(import.meta.dirname,'..','..','..')
const suffix=process.argv.includes('--freeze')?'-freeze':''
const output=resolve(root,'runtime','migration-reconciliation',`phase1-v2${suffix}-snapshot.json`)
const manifest=resolve(root,'runtime','migration-reconciliation',`phase1-v2${suffix}-checksum-manifest.json`)
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex')
try{
  const ledger=await prisma.$queryRaw<Array<Record<string,unknown>>>`SELECT migration_name,checksum,started_at,finished_at,rolled_back_at,logs,applied_steps_count FROM _prisma_migrations ORDER BY started_at,id`
  const migrationRoot=resolve(root,'prisma','migrations');const migrations=[]
  for(const entry of (await readdir(migrationRoot,{withFileTypes:true})).filter(x=>x.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name))){try{const bytes=await readFile(resolve(migrationRoot,entry.name,'migration.sql'));migrations.push({name:entry.name,checksum:sha(bytes),bytes:bytes.length})}catch{migrations.push({name:entry.name,checksum:null,bytes:0})}}
  const schema=await readFile(resolve(root,'prisma','schema.prisma'))
  const [catalog]=await prisma.$queryRaw<Array<Record<string,unknown>>>`SELECT (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema='public') AS tables,(SELECT COUNT(*)::int FROM information_schema.columns WHERE table_schema='public') AS columns,(SELECT COUNT(*)::int FROM pg_indexes WHERE schemaname='public') AS indexes,(SELECT COUNT(*)::int FROM information_schema.table_constraints WHERE constraint_schema='public') AS constraints,(SELECT COUNT(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e') AS enums`
  const snapshot={task:'SMARTFUND_PRODUCTION_MIGRATION_LEDGER_LOW_RISK_RECONCILIATION_PHASE1_V2',capturedAt:new Date().toISOString(),ledger,migrations,prismaSchemaChecksum:sha(schema),catalog}
  const bytes=Buffer.from(`${JSON.stringify(snapshot,null,2)}\n`);await mkdir(dirname(output),{recursive:true});await writeFile(output,bytes)
  await writeFile(manifest,`${JSON.stringify({snapshot:'runtime/migration-reconciliation/phase1-v2-snapshot.json',sha256:sha(bytes),ledgerRows:ledger.length,localMigrations:migrations.length,prismaSchemaChecksum:sha(schema)},null,2)}\n`)
  console.log(JSON.stringify({output,checksum:sha(bytes),ledgerRows:ledger.length,localMigrations:migrations.length}))
}finally{await prisma.$disconnect()}
