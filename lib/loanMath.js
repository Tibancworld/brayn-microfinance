function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function calculateEmi(principal, annualRatePercent, months) {
  const p = Number(principal);
  const n = Number(months);
  const annual = Number(annualRatePercent) / 100;
  if (!p || !n) return 0;
  const r = annual / 12;
  if (r <= 0) return round2(p / n);
  return round2((p * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1));
}

function addMonths(isoDate, monthsToAdd) {
  const date = new Date(`${isoDate}T00:00:00`);
  const day = date.getDate();
  date.setMonth(date.getMonth() + monthsToAdd);
  if (date.getDate() < day) date.setDate(0);
  return date.toISOString().slice(0, 10);
}

function buildSchedule(principal, annualRatePercent, months, startDate = new Date().toISOString().slice(0, 10)) {
  const emi = calculateEmi(principal, annualRatePercent, months);
  const monthlyRate = Number(annualRatePercent) / 100 / 12;
  let balance = round2(principal);
  const rows = [];

  for (let i = 1; i <= months; i += 1) {
    const interest = round2(balance * monthlyRate);
    let principalPart = round2(emi - interest);
    if (i === months) {
      principalPart = balance;
    }
    const amountDue = round2(principalPart + interest);
    balance = round2(Math.max(0, balance - principalPart));
    rows.push({
      installmentNo: i,
      dueDate: addMonths(startDate, i),
      principalDue: principalPart,
      interestDue: interest,
      amountDue,
      balanceAfter: balance,
    });
  }

  const totalPayable = round2(rows.reduce((sum, row) => sum + row.amountDue, 0));
  return { emi, totalPayable, rows };
}

function daysBetween(fromIso, toIso = new Date().toISOString().slice(0, 10)) {
  const a = new Date(`${fromIso}T00:00:00`);
  const b = new Date(`${toIso}T00:00:00`);
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

module.exports = {
  round2,
  calculateEmi,
  addMonths,
  buildSchedule,
  daysBetween,
};
