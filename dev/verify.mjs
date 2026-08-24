#!/usr/bin/env node
/**
 * dev/verify.mjs — verification harness for Financial Cycles.
 *
 * The app ships as a single self-contained index.html, so there is nothing to
 * import in the usual sense. This script extracts the DOM-free CORE region of
 * index.html (between the `CORE START` / `CORE END` markers), executes it in a
 * node:vm context, and runs the scenarios below against the exported
 * globalThis.FinancialCyclesCore surface.
 *
 * Dev-only: index.html does not read, load or depend on this file.
 *
 * Run:  node dev/verify.mjs
 * Exit: 0 when every check passes, 1 otherwise.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(HERE, '..', 'index.html');
const CORE_START = '/* ==== CORE START ====';
const CORE_END = '/* ==== CORE END ==== */';

function loadCore() {
  const html = readFileSync(HTML_PATH, 'utf8');
  const start = html.indexOf(CORE_START);
  const end = html.indexOf(CORE_END);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Could not locate the CORE region markers inside index.html');
  }
  const source = html.slice(start, end);
  const context = vm.createContext({ console });
  vm.runInContext(source, context, { filename: 'index.html#core' });
  if (!context.FinancialCyclesCore) {
    throw new Error('The CORE region did not export globalThis.FinancialCyclesCore');
  }
  return context.FinancialCyclesCore;
}

/* ===== SUITE START ===== (engine-agnostic: no Node APIs beyond plain JS) */
function runSuite(Core) {
  const lines = [];
  let passed = 0;
  let failed = 0;

  const show = (v) => {
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'object' && v !== null) {
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    return String(v);
  };
  const group = (title) => { lines.push(''); lines.push(title); lines.push('-'.repeat(title.length)); };
  const ok = (name, cond, detail) => {
    if (cond) { passed++; lines.push('  PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
    else { failed++; lines.push('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
  };
  const eq = (name, actual, expected) => {
    ok(name, Object.is(actual, expected), 'got ' + show(actual) + ', expected ' + show(expected));
  };

  const cycle = (over, txAmounts) => Core.createCycle(Object.assign({
    periodType: 'monthly', startDate: '2025-01-01', endDate: '2025-01-31',
    transactions: (txAmounts || []).map((a, i) => ({
      amountCents: a, date: '2025-01-0' + (i + 1), description: 'Συναλλαγή ' + (i + 1)
    }))
  }, over));

  /* ---------------------------------------------------------------- */
  group('1. Income cycle over target (1000 target, 600 + 600)');
  const inc1 = cycle({ title: 'Έσοδα Α', type: 'income', targetAmountCents: 100000 }, [60000, 60000]);
  eq('actual amount is 120000 cents', Core.getCycleActualAmountCents(inc1), 120000);
  eq('progress is 120%', Core.getCycleProgressPercent(inc1), 120);
  const inc1s = Core.getCycleStatus(inc1);
  eq('status key is surplus', inc1s.key, 'surplus');
  eq('status label is Πλεόνασμα', inc1s.label, 'Πλεόνασμα');
  ok('status is visually positive, never red', inc1s.tone !== 'red' && inc1s.ringOver === false, 'tone=' + inc1s.tone);
  eq('settlement adjustment is +20000', Core.calculateSettlementAdjustmentCents(inc1), 20000);

  /* ---------------------------------------------------------------- */
  group('2. Income cycle under target (1000 target, actual 800)');
  const inc2 = cycle({ title: 'Έσοδα Β', type: 'income', targetAmountCents: 100000 }, [50000, 30000]);
  eq('actual amount is 80000 cents', Core.getCycleActualAmountCents(inc2), 80000);
  eq('progress is 80%', Core.getCycleProgressPercent(inc2), 80);
  eq('status label is Εντός στόχου', Core.getCycleStatus(inc2).label, 'Εντός στόχου');
  eq('settlement adjustment is -20000', Core.calculateSettlementAdjustmentCents(inc2), -20000);

  /* ---------------------------------------------------------------- */
  group('3. Expense cycle under limit (500 limit, actual 400)');
  const exp1 = cycle({ title: 'Έξοδα Α', type: 'expense', targetAmountCents: 50000 }, [25000, 15000]);
  eq('actual amount is 40000 cents', Core.getCycleActualAmountCents(exp1), 40000);
  eq('progress is 80%', Core.getCycleProgressPercent(exp1), 80);
  const exp1s = Core.getCycleStatus(exp1);
  eq('status key is within', exp1s.key, 'within');
  eq('status tone is green', exp1s.tone, 'green');
  eq('settlement adjustment is +10000', Core.calculateSettlementAdjustmentCents(exp1), 10000);
  eq('caption counts down to the limit',
    Core.getCycleCaption(exp1).text.indexOf('Απομένουν') === 0, true);

  /* ---------------------------------------------------------------- */
  group('4. Expense cycle over limit (500 limit, actual 650)');
  const exp2 = cycle({ title: 'Έξοδα Β', type: 'expense', targetAmountCents: 50000 }, [40000, 25000]);
  eq('actual amount is 65000 cents', Core.getCycleActualAmountCents(exp2), 65000);
  eq('progress is 130%', Core.getCycleProgressPercent(exp2), 130);
  const exp2s = Core.getCycleStatus(exp2);
  eq('status key is over', exp2s.key, 'over');
  eq('status tone is red', exp2s.tone, 'red');
  eq('status label is Υπέρβαση', exp2s.label, 'Υπέρβαση');
  eq('ring renders fully red', exp2s.ringOver, true);
  eq('settlement adjustment is -15000', Core.calculateSettlementAdjustmentCents(exp2), -15000);
  eq('difference (actual - target) is +15000', Core.getCycleDifferenceCents(exp2), 15000);

  /* ---------------------------------------------------------------- */
  group('5. Settling the same cycle twice creates exactly one settlement');
  let st5 = Core.createDefaultState();
  st5.initialBalanceCents = 100000;
  st5.cycles = [exp2];
  eq('balance before settling', Core.calculateCurrentBalanceCents(st5), 100000);
  const sid5 = Core.newId('stl');
  const first = Core.applySettlement(st5, exp2.id, sid5);
  eq('first settlement applied', first.applied, true);
  eq('balance after first settlement', Core.calculateCurrentBalanceCents(first.state), 85000);
  eq('ledger has 1 entry', first.state.balanceLedger.length, 1);
  eq('cycle is closed', first.state.cycles[0].status, 'closed');
  eq('closed target snapshot stored', first.state.cycles[0].closedTargetAmountCents, 50000);
  eq('closed actual snapshot stored', first.state.cycles[0].closedActualAmountCents, 65000);

  const second = Core.applySettlement(first.state, exp2.id, sid5);
  eq('second settlement refused', second.applied, false);
  eq('refusal reason', second.reason, 'already-closed');
  eq('balance unchanged after second attempt', Core.calculateCurrentBalanceCents(second.state), 85000);
  eq('ledger still has 1 entry', second.state.balanceLedger.length, 1);

  const thirdFreshId = Core.applySettlement(first.state, exp2.id, Core.newId('stl'));
  eq('a fresh settlementId cannot re-settle a closed cycle', thirdFreshId.applied, false);
  eq('balance still unchanged', Core.calculateCurrentBalanceCents(thirdFreshId.state), 85000);

  // Guard #2: the same settlementId is refused even on an open cycle.
  const forcedOpen = Object.assign({}, first.state, {
    cycles: [Object.assign({}, first.state.cycles[0], { status: 'open' })]
  });
  const replay = Core.applySettlement(forcedOpen, exp2.id, sid5);
  eq('replaying a used settlementId is refused', replay.applied, false);
  eq('replay refusal reason', replay.reason, 'duplicate-settlement');

  /* ---------------------------------------------------------------- */
  group('6. Close -> reopen -> edit transactions -> close again');
  const c6 = cycle({ title: 'Μισθός', type: 'income', targetAmountCents: 100000 }, [60000]);
  let st6 = Core.createDefaultState();
  st6.initialBalanceCents = 100000;
  st6.cycles = [c6];

  const close1 = Core.applySettlement(st6, c6.id, Core.newId('stl'));
  const settlementIdOne = close1.state.cycles[0].settlementId;
  eq('first close adjustment is -40000', close1.adjustmentCents, -40000);
  eq('balance after first close', Core.calculateCurrentBalanceCents(close1.state), 60000);

  const reopened = Core.reverseSettlement(close1.state, c6.id);
  eq('reopen applied', reopened.applied, true);
  eq('reversal entry type', reopened.entry.type, 'reversal');
  eq('reversal cancels the prior adjustment', reopened.entry.adjustmentCents, 40000);
  eq('balance restored after reopen', Core.calculateCurrentBalanceCents(reopened.state), 100000);
  eq('ledger keeps both entries', reopened.state.balanceLedger.length, 2);
  eq('cycle is open again', reopened.state.cycles[0].status, 'open');
  eq('old settlementId invalidated on the cycle', reopened.state.cycles[0].settlementId, null);

  let st6b = Object.assign({}, reopened.state, {
    cycles: [Core.addTransactionToCycle(reopened.state.cycles[0], {
      amountCents: 60000, date: '2025-01-20', description: 'Δεύτερη δόση'
    })]
  });
  eq('actual after editing transactions', Core.getCycleActualAmountCents(st6b.cycles[0]), 120000);

  const close2 = Core.applySettlement(st6b, c6.id, Core.newId('stl'));
  eq('second close applied', close2.applied, true);
  eq('second close adjustment is +20000 (fresh values)', close2.adjustmentCents, 20000);
  eq('balance after second close', Core.calculateCurrentBalanceCents(close2.state), 120000);
  eq('ledger now holds 3 entries', close2.state.balanceLedger.length, 3);
  eq('original settlement entry is still in the ledger',
    close2.state.balanceLedger.filter((e) => e.type === 'settlement' && e.settlementId === settlementIdOne).length, 1);
  eq('reversal entry is still in the ledger',
    close2.state.balanceLedger.filter((e) => e.type === 'reversal' && e.settlementId === settlementIdOne).length, 1);
  eq('no ledger entry was ever removed',
    close2.state.balanceLedger.length >= reopened.state.balanceLedger.length, true);
  eq('new settlementId differs from the old one',
    close2.state.cycles[0].settlementId !== settlementIdOne, true);

  /* ---------------------------------------------------------------- */
  group('7. Cent arithmetic is exact');
  const a710 = Core.parseAmountToCents('10,10');
  const a720 = Core.parseAmountToCents('20,20');
  eq('10,10 parses to 1010', a710, 1010);
  eq('20,20 parses to 2020', a720, 2020);
  eq('10.10 + 20.20 === 3030 cents exactly', Core.addCents(a710, a720), 3030);
  eq('sumCents matches', Core.sumCents([1010, 2020]), 3030);
  ok('float arithmetic would have failed', (10.10 + 20.20) * 100 !== 3030,
    'raw float gives ' + ((10.10 + 20.20) * 100));

  /* ---------------------------------------------------------------- */
  group('8. Amount parser: accepted formats and rejections');
  eq('"10,50"', Core.parseAmountToCents('10,50'), 1050);
  eq('"10.50"', Core.parseAmountToCents('10.50'), 1050);
  eq('"1.000,50"', Core.parseAmountToCents('1.000,50'), 100050);
  eq('"1000,50"', Core.parseAmountToCents('1000,50'), 100050);
  eq('"1,234,567.89"', Core.parseAmountToCents('1,234,567.89'), 123456789);
  eq('"€ 1.234,56"', Core.parseAmountToCents('€ 1.234,56'), 123456);
  eq('"-25"', Core.parseAmountToCents('-25'), -2500);
  eq('"7"', Core.parseAmountToCents('7'), 700);
  eq('rejects "abc"', Core.parseAmountToCents('abc'), null);
  eq('rejects "1.2.3"', Core.parseAmountToCents('1.2.3'), null);
  eq('rejects "" (empty)', Core.parseAmountToCents(''), null);
  eq('rejects "   " (whitespace)', Core.parseAmountToCents('   '), null);
  eq('rejects "Infinity"', Core.parseAmountToCents('Infinity'), null);
  eq('rejects Infinity (number)', Core.parseAmountToCents(Infinity), null);
  eq('rejects NaN (number)', Core.parseAmountToCents(NaN), null);
  eq('rejects ambiguous "1,000"', Core.parseAmountToCents('1,000'), null);
  eq('rejects ambiguous "1.000"', Core.parseAmountToCents('1.000'), null);
  eq('rejects "10,555" (3 decimals)', Core.parseAmountToCents('10,555'), null);
  eq('rejection carries a Greek message',
    /[Ͱ-Ͽ]/.test(Core.parseAmountResult('abc').error || ''), true);
  ok('formatCents(3030) renders 30,30', Core.formatCents(3030).indexOf('30,30') >= 0,
    Core.formatCents(3030));

  /* ---------------------------------------------------------------- */
  group('9. Recurrence dates (month lengths and leap years)');
  const nx2025 = Core.nextPeriodDates('monthly', '2025-01-01', '2025-01-31');
  eq('Jan 2025 -> Feb start', nx2025.startDate, '2025-02-01');
  eq('Jan 2025 -> Feb end', nx2025.endDate, '2025-02-28');
  const nx2024 = Core.nextPeriodDates('monthly', '2024-01-01', '2024-01-31');
  eq('Jan 2024 -> Feb start (leap)', nx2024.startDate, '2024-02-01');
  eq('Jan 2024 -> Feb end (leap)', nx2024.endDate, '2024-02-29');
  eq('Jan 31 2025 + 1 month clamps to Feb 28', Core.addMonthsClampedISO('2025-01-31', 1), '2025-02-28');
  eq('Jan 31 2024 + 1 month clamps to Feb 29', Core.addMonthsClampedISO('2024-01-31', 1), '2024-02-29');
  eq('no Mar 3 overflow in 2025', Core.addMonthsClampedISO('2025-01-31', 1) === '2025-03-03', false);
  eq('Mar 31 -> Apr 30', Core.addMonthsClampedISO('2025-03-31', 1), '2025-04-30');
  eq('Dec 31 -> Jan 31 next year', Core.addMonthsClampedISO('2025-12-31', 1), '2026-01-31');
  eq('Feb 2024 -> Mar (full month)', Core.nextPeriodDates('monthly', '2024-02-01', '2024-02-29').endDate, '2024-03-29');
  const wk = Core.nextPeriodDates('weekly', '2025-03-03', '2025-03-09');
  eq('weekly +7 start', wk.startDate, '2025-03-10');
  eq('weekly +7 end', wk.endDate, '2025-03-16');
  const cst = Core.nextPeriodDates('custom', '2025-01-10', '2025-01-14');
  eq('custom continues the day after', cst.startDate, '2025-01-15');
  eq('custom keeps the same span', cst.endDate, '2025-01-19');
  eq('2100 is not a leap year', Core.isLeapYear(2100), false);
  eq('2000 is a leap year', Core.isLeapYear(2000), true);

  /* ---------------------------------------------------------------- */
  group('10. Merge import is idempotent');
  let demo = Core.buildDemoState('2025-03-12');
  const settled = Core.applySettlement(demo, demo.cycles[0].id, Core.newId('stl'));
  const source = settled.state;
  const backup = JSON.parse(JSON.stringify(source));

  const countTx = (s) => s.cycles.reduce((n, c) => n + c.transactions.length, 0);
  const baseCycles = source.cycles.length;
  const baseTx = countTx(source);
  const baseLedger = source.balanceLedger.length;
  const baseBalance = Core.calculateCurrentBalanceCents(source);

  const merge1 = Core.mergeImport(source, backup);
  eq('merging a backup into its own state adds no cycles', merge1.state.cycles.length, baseCycles);
  eq('adds no transactions', countTx(merge1.state), baseTx);
  eq('adds no ledger entries', merge1.state.balanceLedger.length, baseLedger);
  eq('summary: 0 cycles imported', merge1.summary.importedCycles, 0);
  eq('summary: all cycles skipped', merge1.summary.skippedCycles, baseCycles);
  eq('summary: 0 conflicts', merge1.summary.conflicts, 0);
  eq('balance unchanged', Core.calculateCurrentBalanceCents(merge1.state), baseBalance);

  const merge2 = Core.mergeImport(merge1.state, backup);
  eq('second merge still adds no cycles', merge2.state.cycles.length, baseCycles);
  eq('second merge still adds no transactions', countTx(merge2.state), baseTx);
  eq('second merge still adds no ledger entries', merge2.state.balanceLedger.length, baseLedger);
  eq('balance still unchanged', Core.calculateCurrentBalanceCents(merge2.state), baseBalance);

  const emptyTarget = Core.createDefaultState();
  const fresh = Core.mergeImport(emptyTarget, backup);
  eq('merging into an empty state imports every cycle', fresh.state.cycles.length, baseCycles);
  eq('merging into an empty state imports every transaction', countTx(fresh.state), baseTx);
  eq('merging into an empty state imports every ledger entry', fresh.state.balanceLedger.length, baseLedger);
  const freshAgain = Core.mergeImport(fresh.state, backup);
  eq('re-merging duplicates nothing', freshAgain.state.cycles.length, baseCycles);
  eq('re-merging duplicates no transactions', countTx(freshAgain.state), baseTx);
  eq('re-merging duplicates no ledger entries', freshAgain.state.balanceLedger.length, baseLedger);

  /* ---------------------------------------------------------------- */
  group('11. Balance is derived, storage migrates, validation speaks Greek');
  const ledgerState = {
    schemaVersion: 1, initialBalanceCents: 50000,
    cycles: [],
    balanceLedger: [{ adjustmentCents: 2500 }, { adjustmentCents: -1000 }, { adjustmentCents: 30000 }],
    settings: {}
  };
  eq('balance = initial + sum(adjustments)', Core.calculateCurrentBalanceCents(Core.migrate(ledgerState)), 81500);
  eq('migrate(null) yields a valid default state', Core.migrate(null).schemaVersion, Core.CURRENT_SCHEMA_VERSION);
  eq('migrate(garbage) does not throw', Core.migrate('not an object').cycles.length, 0);
  eq('migrate keeps unknown-version data safe', Core.migrate({ schemaVersion: 99, cycles: [] }).schemaVersion, Core.CURRENT_SCHEMA_VERSION);
  const badCycle = Core.validateCycleInput({
    title: '', type: 'income', periodType: 'monthly',
    targetAmount: '0', startDate: '2025-05-10', endDate: '2025-05-01'
  });
  eq('empty title rejected', !!badCycle.errors.title, true);
  eq('zero target rejected', !!badCycle.errors.targetAmount, true);
  eq('end before start rejected', !!badCycle.errors.endDate, true);
  const goodCycle = Core.validateCycleInput({
    title: 'Ενοίκιο', type: 'expense', periodType: 'monthly',
    targetAmount: '450,00', startDate: '2025-05-01', endDate: '2025-05-31'
  });
  eq('valid cycle passes', goodCycle.ok, true);
  eq('valid cycle parses target to cents', goodCycle.value.targetAmountCents, 45000);
  eq('negative transaction amount rejected',
    !!Core.validateTransactionInput({ amount: '-5', date: '2025-05-01' }).errors.amount, true);
  eq('expense defaults to over-target-is-negative',
    Core.createCycle({ title: 'x', type: 'expense' }).overTargetIsNegative, true);
  eq('income defaults to over-target-is-positive',
    Core.createCycle({ title: 'x', type: 'income' }).overTargetIsNegative, false);

  lines.push('');
  lines.push('='.repeat(60));
  lines.push('TOTAL: ' + (passed + failed) + ' checks | passed: ' + passed + ' | failed: ' + failed);
  lines.push(failed === 0 ? 'RESULT: ALL CHECKS PASSED' : 'RESULT: FAILURES PRESENT');
  lines.push('='.repeat(60));

  return { lines, passed, failed };
}
/* ===== SUITE END ===== */

const core = loadCore();
const header = 'Financial Cycles — verification suite (core extracted from index.html)';
console.log(header);
console.log('='.repeat(header.length));
const result = runSuite(core);
result.lines.forEach((line) => console.log(line));
process.exit(result.failed === 0 ? 0 : 1);
