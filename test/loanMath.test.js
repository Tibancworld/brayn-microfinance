const assert = require('assert');
const { calculateEmi, buildSchedule, round2 } = require('../lib/loanMath');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`fail - ${name}`);
    throw error;
  }
}

test('EMI for zero interest is principal / months', () => {
  assert.strictEqual(calculateEmi(120000, 0, 12), 10000);
});

test('EMI for standard reducing balance is positive and stable', () => {
  const emi = calculateEmi(150000, 18, 12);
  assert.ok(emi > 13000 && emi < 15000);
});

test('schedule totals principal back to zero balance', () => {
  const schedule = buildSchedule(100000, 12, 6, '2026-01-01');
  assert.strictEqual(schedule.rows.length, 6);
  assert.strictEqual(schedule.rows[schedule.rows.length - 1].balanceAfter, 0);
  const principalSum = round2(schedule.rows.reduce((sum, row) => sum + row.principalDue, 0));
  assert.ok(Math.abs(principalSum - 100000) < 0.2);
});

test('total payable equals sum of installment dues', () => {
  const schedule = buildSchedule(80000, 20, 6, '2026-01-01');
  const sum = round2(schedule.rows.reduce((total, row) => total + row.amountDue, 0));
  assert.strictEqual(sum, schedule.totalPayable);
});

console.log('All loan math tests passed');
