import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { prisma } from '../../../lib/prisma.ts'

const root=resolve(import.meta.dirname,'..','..','..'); const migrationsRoot=resolve(root,'prisma','migrations')
type Ledger={name:string;checksum:string;startedAt:Date;finishedAt:Date|null;rolledBackAt:Date|null;logs:string|null;steps:number}
type Targets={tables:string[];columns:string[];indexes:string[];constraints:string[];enums:string[];references:string[]}
const uniq=(xs:string[])=>[...new Set(xs)]
function targets(sql:string):Targets{
  return {
    tables:uniq([...sql.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+"([^"]+)"/gi)].map(x=>x[1])),
    columns:uniq([...sql.matchAll(/ALTER\s+TABLE\s+"([^"]+)"\s+ADD(?:\s+COLUMN)?(?:\s+IF\s+NOT\s+EXISTS)?\s+"([^"]+)"/gi)].map(x=>`${x[1]}.${x[2]}`)),
    indexes:uniq([...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+"([^"]+)"/gi)].map(x=>x[1])),
    constraints:uniq([...sql.matchAll(/CONSTRAINT\s+"([^"]+)"/gi)].map(x=>x[1])),
    enums:uniq([...sql.matchAll(/CREATE\s+TYPE\s+"([^"]+)"\s+AS\s+ENUM/gi)].map(x=>x[1])),
    references:uniq([...sql.matchAll(/REFERENCES\s+"([^"]+)"/gi)].map(x=>x[1])),
  }
}
function domain(name:string){const n=name.toLowerCase();for(const [key,label] of [['stock','GLOBAL_STOCK'],['etf','GLOBAL_ETF'],['fund','GLOBAL_FUND'],['crypto','GLOBAL_CRYPTO'],['fx','GLOBAL_FX'],['index','GLOBAL_INDEX'],['ranking','GLOBAL_RANKING_ENGINE'],['reit','GLOBAL_REIT'],['analyst','GLOBAL_ANALYST_ESTIMATES'],['institution','GLOBAL_INSTITUTIONAL_HOLDINGS'],['buyback','GLOBAL_SHARE_BUYBACK'],['insider','GLOBAL_INSIDER_OWNERSHIP']] as const)if(n.includes(key))return label;return 'GLOBAL_PLATFORM'}

try{
  const dirs=(await readdir(migrationsRoot,{withFileTypes:true})).filter(x=>x.isDirectory()).map(x=>x.name).sort()
  const local=new Map<string,{checksum:string;sql:string;targets:Targets}>()
  for(const name of dirs){try{const bytes=await readFile(resolve(migrationsRoot,name,'migration.sql'));const sql=bytes.toString('utf8');local.set(name,{checksum:createHash('sha256').update(bytes).digest('hex'),sql,targets:targets(sql)})}catch{}}
  const ledger=await prisma.$queryRaw<Ledger[]>`SELECT migration_name name,checksum,started_at AS "startedAt",finished_at AS "finishedAt",rolled_back_at AS "rolledBackAt",logs,applied_steps_count steps FROM _prisma_migrations ORDER BY started_at`
  const tables=new Set((await prisma.$queryRaw<Array<{n:string}>>`SELECT table_name n FROM information_schema.tables WHERE table_schema='public'`).map(x=>x.n))
  const columns=new Set((await prisma.$queryRaw<Array<{t:string;c:string}>>`SELECT table_name t,column_name c FROM information_schema.columns WHERE table_schema='public'`).map(x=>`${x.t}.${x.c}`))
  const indexes=new Set((await prisma.$queryRaw<Array<{n:string}>>`SELECT indexname n FROM pg_indexes WHERE schemaname='public'`).map(x=>x.n))
  const constraints=new Set((await prisma.$queryRaw<Array<{n:string}>>`SELECT constraint_name n FROM information_schema.table_constraints WHERE constraint_schema='public'`).map(x=>x.n))
  const enums=new Set((await prisma.$queryRaw<Array<{n:string}>>`SELECT t.typname n FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'`).map(x=>x.n))
  const presence=(t:Targets)=>{const expected=[...t.tables.map(x=>['TABLE',x] as const),...t.columns.map(x=>['COLUMN',x] as const),...t.indexes.map(x=>['INDEX',x] as const),...t.constraints.map(x=>['CONSTRAINT',x] as const),...t.enums.map(x=>['ENUM',x] as const)];const present=expected.filter(([k,n])=>k==='TABLE'?tables.has(n):k==='COLUMN'?columns.has(n):k==='INDEX'?indexes.has(n):k==='CONSTRAINT'?constraints.has(n):enums.has(n));return{expected:expected.map(x=>`${x[0]}:${x[1]}`),present:present.map(x=>`${x[0]}:${x[1]}`),missing:expected.filter(x=>!present.includes(x)).map(x=>`${x[0]}:${x[1]}`)}}
  const byName=new Map<string,Ledger[]>();for(const row of ledger){const xs=byName.get(row.name)??[];xs.push(row);byName.set(row.name,xs)}
  const rows=[] as any[]
  for(const name of uniq([...dirs,...ledger.map(x=>x.name)]).sort()){
    const ls=byName.get(name)??[];const l=ls.at(-1);const file=local.get(name);const p=file?presence(file.targets):null
    let classification='UNKNOWN'
    if(l&&!l.finishedAt&&!l.rolledBackAt)classification='FAILED_ACTIVE'
    else if(l?.rolledBackAt&&file)classification=l.checksum===file.checksum?'ROLLED_BACK_MATCHED':'ROLLED_BACK_DIVERGENT'
    else if(l?.rolledBackAt&&!file)classification='ROLLED_BACK_DIVERGENT'
    else if(l?.finishedAt&&!file)classification='DB_ONLY'
    else if(l?.finishedAt&&file)classification=l.checksum===file.checksum?'MATCHED':'CHECKSUM_MISMATCH'
    else if(!l&&file)classification='LOCAL_ONLY'
    let localOnlyState=null
    if(classification==='LOCAL_ONLY'&&p){const refsReady=file!.targets.references.every(x=>tables.has(x));localOnlyState=p.expected.length>0&&p.missing.length===0?'ALREADY_PHYSICALLY_PRESENT':p.present.length>0?'CONFLICTING':refsReady?'SAFE_PENDING':'DEPENDENCY_BLOCKED'}
    rows.push({name,domain:domain(name),classification,startedAt:l?.startedAt??null,finishedAt:l?.finishedAt??null,rolledBackAt:l?.rolledBackAt??null,steps:l?.steps??null,ledgerChecksum:l?.checksum??null,localChecksum:file?.checksum??null,presence:p,localOnlyState,logs:l?.logs??null})
  }
  const schema=await readFile(resolve(root,'prisma','schema.prisma'),'utf8');const modelBlocks=[...schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)]
  const modelTables=modelBlocks.map(m=>({model:m[1],table:m[2].match(/@@map\("([^"]+)"\)/)?.[1]??m[1]}));const prismaMissing=modelTables.filter(x=>!tables.has(x.table))
  const mappedTables=new Set(modelTables.map(x=>x.table));const dbMissingPrisma=[...tables].filter(x=>!mappedTables.has(x)&&x!=='_prisma_migrations').sort()
  const enumNames=new Set([...schema.matchAll(/enum\s+(\w+)\s*\{/g)].map(x=>x[1]));const scalar=new Set(['String','Int','BigInt','Decimal','Float','Boolean','DateTime','Json','Bytes',...enumNames])
  const expectedColumns=new Set<string>();const expectedFks=new Set<string>();const expectedIndexes=new Set<string>()
  for(const m of modelBlocks){const block=m[2],table=block.match(/@@map\("([^"]+)"\)/)?.[1]??m[1];const fieldMap=new Map<string,string>()
    for(const line of block.split(/\r?\n/)){const fm=line.match(/^\s*(\w+)\s+(\w+)(?:\[\])?\??\s*(.*)$/);if(!fm)continue;const [,field,type,attrs]=fm;if(scalar.has(type)&&!attrs.includes('@ignore')){const column=attrs.match(/@map\("([^"]+)"\)/)?.[1]??field;fieldMap.set(field,column);expectedColumns.add(`${table}.${column}`)}const rel=attrs.match(/@relation\([^)]*fields:\s*\[([^\]]+)\][^)]*(?:map:\s*"([^"]+)")?/);if(rel){for(const f of rel[1].split(',').map(x=>x.trim()))expectedFks.add(rel[2]??`${table}_${fieldMap.get(f)??f}_fkey`)}}
    for(const im of block.matchAll(/@@(index|unique)\(\[([^\]]+)\][^)]*(?:map:\s*"([^"]+)")?[^)]*\)/g)){const cols=im[2].split(',').map(x=>(fieldMap.get(x.trim().split(/\s+/)[0])??x.trim().split(/\s+/)[0])).join('_');expectedIndexes.add(im[3]??`${table}_${cols}_${im[1]==='unique'?'key':'idx'}`)}
  }
  const physicalModelColumns=new Set([...columns].filter(x=>mappedTables.has(x.split('.')[0])));const columnDivergence=[...expectedColumns].filter(x=>!columns.has(x)).length+[...physicalModelColumns].filter(x=>!expectedColumns.has(x)).length
  const fkDivergence=[...expectedFks].filter(x=>!constraints.has(x)).length
  const indexDivergence=[...expectedIndexes].filter(x=>!indexes.has(x)).length
  const enumDivergence=[...enumNames].filter(x=>!enums.has(x)).length+[...enums].filter(x=>!enumNames.has(x)).length
  const mismatch=rows.filter(x=>x.classification==='CHECKSUM_MISMATCH');const localOnly=rows.filter(x=>x.classification==='LOCAL_ONLY');const dbOnly=rows.filter(x=>x.classification==='DB_ONLY')
  const first=rows.filter(x=>x.classification!=='MATCHED').sort((a,b)=>String(a.startedAt??a.name).localeCompare(String(b.startedAt??b.name)))[0]
  const ranking=rows.find(x=>x.name==='20260810030000_global_ranking_engine_p0_depth_recovery')
  const report={ledgerRows:ledger.length,localMigrationCount:local.size,rows,summary:{matched:rows.filter(x=>x.classification==='MATCHED').length,activeFailed:rows.filter(x=>x.classification==='FAILED_ACTIVE').length,rolledBackLedgerRows:ledger.filter(x=>!!x.rolledBackAt).length,checksumMismatch:mismatch.length,dbOnly:dbOnly.length,localOnly:localOnly.length,duplicates:[...byName].filter(([,v])=>v.length>1).map(([k])=>k),unknown:rows.filter(x=>x.classification==='UNKNOWN').length,localOnlyStates:Object.fromEntries(['SAFE_PENDING','ALREADY_PHYSICALLY_PRESENT','SUPERSEDED','DEPENDENCY_BLOCKED','CONFLICTING','ABANDONED','UNKNOWN'].map(s=>[s,localOnly.filter(x=>(x.localOnlyState??'UNKNOWN')===s).length])),prismaModelsMissingInDb:prismaMissing.map(x=>x.table),dbRelationsMissingInPrisma:dbMissingPrisma,columnDivergence,fkDivergence,indexDivergence,enumDivergence,firstDivergence:first?.name??null,firstDivergenceTimestamp:first?.startedAt??first?.name??null,dependentMigrationCount:first?rows.filter(x=>x.name>first.name).length:0,assetsImpacted:uniq(rows.filter(x=>x.classification!=='MATCHED').map(x=>x.domain)),rankingMigration:ranking},catalogCounts:{tables:tables.size,columns:columns.size,indexes:indexes.size,constraints:constraints.size,enums:enums.size}}
  const output=process.argv.includes('--summary')?{ledgerRows:report.ledgerRows,localMigrationCount:report.localMigrationCount,summary:report.summary,checksumMismatchNames:mismatch.map(x=>x.name),dbOnlyNames:dbOnly.map(x=>x.name),localOnlyNames:localOnly.map(x=>x.name),rolledBackNames:ledger.filter(x=>!!x.rolledBackAt).map(x=>x.name)}:report
  console.log(JSON.stringify(output,null,2))
}finally{await prisma.$disconnect()}
