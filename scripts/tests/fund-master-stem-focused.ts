// Regression tests for the masterStem() fix (lib/yahoo/fundIngest.ts).
// Pure function, no DB access — these assert the stem computation directly against real fund names
// observed in Production (the 5 broken families + the 3 previously-confirmed-correct masters).
import assert from 'node:assert/strict';
import { masterStem } from '../../lib/yahoo/fundIngest';

function sameMaster(names: string[], label: string) {
  const stems = names.map(masterStem);
  const first = stems[0];
  for (let i = 1; i < stems.length; i++) {
    assert.equal(stems[i], first, `${label}: "${names[i]}" -> "${stems[i]}" should equal "${names[0]}" -> "${first}"`);
  }
  console.log(`SAME_MASTER[${label}]: PASS (stem="${first}")`);
}

function differentMaster(a: string, b: string, label: string) {
  const sa = masterStem(a), sb = masterStem(b);
  assert.notEqual(sa, sb, `${label}: "${a}" -> "${sa}" must differ from "${b}" -> "${sb}"`);
  console.log(`DIFFERENT_MASTER[${label}]: PASS ("${sa}" != "${sb}")`);
}

function regression() {
  // ---- SAME MASTER (true share classes of one fund) ----
  sameMaster(
    ['Fidelity Advisor OTC I', 'Fidelity Advisor OTC A', 'Fidelity Advisor OTC M', 'Fidelity Advisor OTC Z', 'Fidelity Advisor OTC C'],
    'Fidelity Advisor OTC',
  );
  sameMaster(
    ['Fidelity Freedom Blend 2050', 'Fidelity Freedom Blend 2050 K', 'Fidelity Freedom Blend 2050 K6'],
    'Fidelity Freedom Blend 2050',
  );
  sameMaster(['Nuveen S&P 500 Index I', 'Nuveen S&P 500 Index R6'], 'Nuveen S&P 500 Index');
  sameMaster(
    ['ClearBridge Dividend Strategy C', 'ClearBridge Dividend Strategy I', 'ClearBridge Dividend Strategy A', 'ClearBridge Dividend Strategy R'],
    'ClearBridge Dividend Strategy',
  );

  // ---- DIFFERENT MASTER (genuinely different underlying funds) ----
  differentMaster('Fidelity Advisor OTC I', 'Fidelity Advisor Blue Chip Growth I', 'Fidelity OTC vs Blue Chip Growth');
  differentMaster('Fidelity Advisor Gold Z', 'Fidelity Advisor Balanced M', 'Fidelity Gold vs Balanced');
  differentMaster('Morgan Stanley Inst Discovery A', 'Morgan Stanley Inst Growth A', 'Morgan Stanley Discovery vs Growth');
  differentMaster('Columbia Select Large Cap Value C', 'Columbia Select Corporate Income A', 'Columbia Large Cap Value vs Corporate Income');

  // ---- Exact expected stems from the user's spec ----
  assert.equal(masterStem('Fidelity Advisor OTC I'), 'fidelity advisor otc');
  assert.equal(masterStem('Fidelity Advisor OTC A'), 'fidelity advisor otc');
  assert.equal(masterStem('Fidelity Advisor Blue Chip Growth I'), 'fidelity advisor blue chip growth');
  assert.equal(masterStem('Fidelity Advisor Gold Z'), 'fidelity advisor gold');
  assert.equal(masterStem('Fidelity Advisor Balanced M'), 'fidelity advisor balanced');
  assert.equal(masterStem('Russell Inv US Small Cap Equity A'), 'russell inv us small cap equity');
  assert.equal(masterStem('Morgan Stanley Inst Discovery A'), 'morgan stanley inst discovery');
  assert.equal(masterStem('Columbia Select Corporate Income A'), 'columbia select corporate income');
  console.log('EXACT_STEM_SPEC: PASS');

  // ---- "Advisor"/"Inv"/"Inst"/"Select" must NOT be treated as a suffix when it is not trailing ----
  assert.equal(masterStem('Fidelity Advisor OTC'), 'fidelity advisor otc'); // no trailing class token at all -> unchanged
  console.log('MID_NAME_TOKEN_NOT_STRIPPED: PASS');

  // ---- VALIC: "Company I" must not truncate the real fund name that follows ----
  assert.equal(masterStem('VALIC Company I Asset Allocation'), 'valic company i asset allocation');
  assert.equal(masterStem('VALIC Company I Core Bond'), 'valic company i core bond');
  differentMaster('VALIC Company I Asset Allocation', 'VALIC Company I Core Bond', 'VALIC Asset Allocation vs Core Bond');
  console.log('VALIC_COMPANY_I_NOT_STRIPPED: PASS');
}

regression();
console.log('FUND_MASTER_STEM_REGRESSION: PASS');
