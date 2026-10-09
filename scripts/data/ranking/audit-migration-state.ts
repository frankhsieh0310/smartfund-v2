import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { prisma } from '../../../lib/prisma.ts'

const root=resolve(import.meta.dirname,'..','..','..')
const migrationsRoot=resolve(root,'prisma','migrations')
type MigrationRow={migrationName:string;checksum:string;startedAt:Date;finishedAt:Date|null;rolledBackAt:Date|null;logs:string|null;appliedStepsCount:number}

try {
  const dirs=(await readdir(migrationsRoot,{withFileTypes:true})).filter(x=>x.isDirectory()).map(x=>x.name)
  const duplicateNames=dirs.filter((name,index)=>dirs.indexOf(name)!==index)
  const local=new Map<string,string>()
  for(const name of dirs){try{const sql=await readFile(resolve(migrationsRoot,name,'migration.sql'));local.set(name,createHash('sha256').update(sql).digest('hex'))}catch{}}
  const ledger=await prisma.$queryRaw<MigrationRow[]>`SELECT migration_name AS "migrationName",checksum,started_at AS "startedAt",finished_at AS "finishedAt",rolled_back_at AS "rolledBackAt",logs,applied_steps_count AS "appliedStepsCount" FROM _prisma_migrations ORDER BY started_at`
  const failed=ledger.filter(x=>!x.finishedAt&&!x.rolledBackAt)
  const appliedNames=new Set(ledger.filter(x=>x.finishedAt&&!x.rolledBackAt).map(x=>x.migrationName))
  const dbOnly=[...new Set(ledger.map(x=>x.migrationName))].filter(x=>!local.has(x))
  const localOnly=[...local.keys()].filter(x=>!appliedNames.has(x))
  const checksumMismatch=ledger.filter(x=>local.has(x.migrationName)&&local.get(x.migrationName)!==x.checksum).map(x=>x.migrationName)
  const blocker=failed[0]??null
  let blockerSchema=null
  if(blocker&&local.has(blocker.migrationName)){
    const sql=await readFile(resolve(migrationsRoot,blocker.migrationName,'migration.sql'),'utf8')
    const expected=[...sql.matchAll(/CREATE TABLE\s+"([^"]+)"/g)].map(x=>x[1])
    const physical=await prisma.$queryRaw<Array<{tableName:string}>>`SELECT table_name AS "tableName" FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY(${expected})`
    const present=new Set(physical.map(x=>x.tableName)); blockerSchema={expectedTables:expected,presentTables:expected.filter(x=>present.has(x)),missingTables:expected.filter(x=>!present.has(x)),partialObjectCount:expected.filter(x=>present.has(x)).length}
  }
  const rankingTables=['ranking_metric_contracts','ranking_definitions','ranking_universe_snapshots','ranking_snapshots','ranking_results','ranking_work_items']
  const rankingPhysical=await prisma.$queryRaw<Array<{tableName:string}>>`SELECT table_name AS "tableName" FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY(${rankingTables})`
  console.log(JSON.stringify({failedMigrationCount:failed.length,failedMigrations:failed.map(x=>({name:x.migrationName,logs:x.logs,appliedStepsCount:x.appliedStepsCount})),rolledBackMigrations:ledger.filter(x=>!!x.rolledBackAt).map(x=>({name:x.migrationName,logs:x.logs,appliedStepsCount:x.appliedStepsCount})),dbOnlyMigrations:dbOnly,localOnlyMigrations:localOnly,checksumMismatches:checksumMismatch,duplicateMigrationNames:duplicateNames,blockerSchema,rankingPhysicalTables:rankingPhysical.map(x=>x.tableName),ledgerCount:ledger.length},null,2))
} finally { await prisma.$disconnect() }
