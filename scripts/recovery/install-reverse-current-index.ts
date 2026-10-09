/** Explicit one-time projection install/resume. Never modifies canonical holdings or ingestion checkpoints.
 * Run with --apply only after isolated tests pass. Do not deploy the new reader until this exits 0.
 * Bootstrap queues concurrent source changes; readiness is enabled before draining that captured queue.
 * Subsequent holdings commits refresh their own products synchronously in the same transaction.
 */
import pg from 'pg';
import {reverseIndexSchema,reverseIndexIncremental} from '../../lib/data-platform/reverseIndexSchema';

async function main(){
  if(!process.argv.includes('--apply'))throw Error('Explicit --apply required; no database changes made');
  const client=new pg.Client({connectionString:process.env.DATABASE_URL,application_name:'reverse-current-index-install'});
  await client.connect();let locked=false;
  try{
    locked=(await client.query("SELECT pg_try_advisory_lock(hashtextextended('reverse-current-index-install',0)) locked")).rows[0].locked;
    if(!locked)throw Error('Another reverse projection installer is running');
    await client.query("SET statement_timeout='120s';SET lock_timeout='3s'");
    const exists=(await client.query("SELECT to_regclass('public.reverse_projection_state') name")).rows[0].name;
    if(!exists){
      // Short DDL transaction: never hold source table DDL locks while building the index.
      await client.query('BEGIN');
      try{await client.query(reverseIndexSchema);await client.query(reverseIndexIncremental);await client.query('COMMIT');}
      catch(error){await client.query('ROLLBACK');throw error;}
    }
    const ready=(await client.query('SELECT ready FROM reverse_projection_state')).rows[0]?.ready;
    if(!ready){
      await client.query('SELECT refresh_reverse_securities()');
      await client.query('ANALYZE reverse_current_securities');
      // Rebuilds only the disposable read projection, never history or canonical source rows.
      await client.query('SELECT refresh_reverse_products(NULL,NULL)');
      const count=Number((await client.query('SELECT count(*) c FROM reverse_current_positions')).rows[0].c);
      if(!count)throw Error('Empty projection; readiness not enabled');
      await client.query('UPDATE reverse_projection_state SET ready=true');
    }
    for(let batch=0;batch<1000;batch++){
      const rows=(await client.query('SELECT tx::text,kind,product_key FROM reverse_refresh_queue ORDER BY tx,kind,product_key LIMIT 100')).rows as {tx:string;kind:string;product_key:string}[];
      if(!rows.length){
        await client.query('ANALYZE reverse_current_positions');
        console.log(JSON.stringify({ready:true,pending:0,positions:(await client.query('SELECT count(*)::int c FROM reverse_current_positions')).rows[0].c}));return;
      }
      const etfs=[...new Set(rows.filter(r=>r.kind==='ETF').map(r=>r.product_key))];
      const funds=[...new Set(rows.filter(r=>r.kind==='FUND').map(r=>r.product_key))];
      await client.query('BEGIN');
      try{
        await client.query('SELECT refresh_reverse_products($1::text[],$2::text[])',[etfs,funds]);
        // Delete only captured transaction/product identities, never newly enqueued changes.
        await client.query(`DELETE FROM reverse_refresh_queue q USING jsonb_to_recordset($1::jsonb) r(tx text,kind text,product_key text)
          WHERE q.tx=r.tx::bigint AND q.kind=r.kind AND q.product_key=r.product_key`,[JSON.stringify(rows)]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}
      console.log(JSON.stringify({drained:rows.length,batch:batch+1}));
    }
    throw Error('Concurrent updates did not converge; do not deploy reader; rerun this installer to resume');
  }finally{
    if(locked)await client.query("SELECT pg_advisory_unlock(hashtextextended('reverse-current-index-install',0))");
    await client.end();
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Projection installation failed');process.exitCode=1;});
