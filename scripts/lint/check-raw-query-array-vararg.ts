// 2026-10-23（使用者核准，防再犯檢查）: prisma.$queryRawUnsafe / $executeRawUnsafe 的參數是
// variadic（...values），不是「傳一個陣列當params清單」。SITCA_NAV_SYNC從2026-10-22 03:33 UTC起
// 連續21次卡在IN_PROGRESS，根因就是 app/api/cron/sitca-nav-sync/route.ts 寫了
// `prisma.$queryRawUnsafe(sql, [JOB])` ——把整個陣列當成$1單一個值綁進去，job_id(text)去跟
// text[]比，Postgres丟42883，例外沒被接住，finishRun從未被呼叫。
//
// 這支腳本靜態掃描 app/ 跟 lib/ 下所有直接呼叫（排除用 ...params 正確spread的helper寫法），
// 找出「唯一一個參數陣列字面值，且元素數=SQL裡的$N佔位符數，但那個佔位符本身不是故意要接收
// 陣列值（沒有 ::xxx[] 轉型或 = ANY(...)）」的呼叫——這種形狀幾乎必然是同一類bug。
// 跑法：npx tsx scripts/lint/check-raw-query-array-vararg.ts（已掛在 package.json 的
// "prebuild"，每次 `npm run build`／Vercel部署都會自動跑一次，抓到就讓build失敗）。
import * as ts from "typescript";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name === ".next") continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

type Finding = { file: string; line: number; text: string; reason: string };

function scan(files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const exprText = node.expression.getText(sf);
        if (/\$queryRawUnsafe$|\$executeRawUnsafe$/.test(exprText)) {
          const args = node.arguments;
          if (args.length >= 2) {
            const hasSpread = args.some((a) => ts.isSpreadElement(a));
            if (!hasSpread) {
              const paramArgs = args.slice(1);
              if (paramArgs.length === 1 && ts.isArrayLiteralExpression(paramArgs[0])) {
                const arrLit = paramArgs[0] as ts.ArrayLiteralExpression;
                const elements = arrLit.elements;
                const sqlText = args[0].getText(sf);
                const sqlRaw = sqlText.replace(/\\\$/g, "");
                const placeholders = new Set(sqlRaw.match(/\$\d+/g) ?? []);
                const usesArrayCast = /\$1\s*::\s*\w+\[\]|=\s*ANY\s*\(\s*\$1/.test(sqlRaw);
                if (elements.length === placeholders.size && placeholders.size >= 1 && !(elements.length === 1 && usesArrayCast)) {
                  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
                  findings.push({
                    file, line: line + 1,
                    text: node.getText(sf).slice(0, 200).replace(/\s+/g, " "),
                    reason: `array literal with ${elements.length} element(s) passed as the single vararg after the SQL string; SQL has ${placeholders.size} placeholder(s); not a deliberate = ANY()/::[] array-cast usage`,
                  });
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
  return findings;
}

const files = [...walk("app"), ...walk("lib")];
const findings = scan(files);

if (findings.length > 0) {
  console.error(`check-raw-query-array-vararg: ${findings.length} suspect call site(s) found (scanned ${files.length} files).`);
  for (const f of findings) console.error(`\n${f.file}:${f.line}\n  ${f.text}\n  -> ${f.reason}`);
  console.error(`\nFix: pass the scalar directly (e.g. ..., JOB) instead of wrapping it in an array (..., [JOB]) -- $queryRawUnsafe/$executeRawUnsafe take variadic values, not a params array.`);
  process.exit(1);
}
console.log(`check-raw-query-array-vararg: OK (scanned ${files.length} files, 0 suspect call sites).`);
