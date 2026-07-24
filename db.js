const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { buildSchedule, round2, daysBetween } = require('./lib/loanMath');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'brayn.db');
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

async function tableColumns(table) {
  const rows = await all(`PRAGMA table_info(${table})`);
  return new Set(rows.map((r) => r.name));
}

async function ensureColumn(table, column, definition) {
  const cols = await tableColumns(table);
  if (!cols.has(column)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function writeAudit(userId, action, entityType, entityId, details = '') {
  await run(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?)`,
    [userId || null, action, entityType, entityId || null, details]
  );
}

async function createScheduleForLoan(loanId, startDate = new Date().toISOString().slice(0, 10)) {
  const loan = await get('SELECT * FROM loans WHERE id = ?', [loanId]);
  if (!loan) throw Object.assign(new Error('Loan not found'), { status: 404 });

  const existing = await get('SELECT COUNT(*) AS count FROM installments WHERE loan_id = ?', [loanId]);
  if ((existing?.count || 0) > 0) return loan;

  const schedule = buildSchedule(loan.amount, loan.interest_rate, loan.months, startDate);
  for (const row of schedule.rows) {
    await run(
      `INSERT INTO installments
        (loan_id, installment_no, due_date, principal_due, interest_due, amount_due, amount_paid, status)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'Due')`,
      [loanId, row.installmentNo, row.dueDate, row.principalDue, row.interestDue, row.amountDue]
    );
  }

  await run(
    `UPDATE loans
     SET emi = ?, total_payable = ?, outstanding = ?, paid_total = 0,
         disbursed_at = COALESCE(disbursed_at, ?), schedule_generated = 1
     WHERE id = ?`,
    [schedule.emi, schedule.totalPayable, schedule.totalPayable, startDate, loanId]
  );

  return get('SELECT * FROM loans WHERE id = ?', [loanId]);
}

async function allocatePaymentToLoan(loanId, amount) {
  let remaining = round2(amount);
  const installments = await all(
    `SELECT * FROM installments
     WHERE loan_id = ? AND status != 'Paid'
     ORDER BY installment_no ASC`,
    [loanId]
  );

  for (const row of installments) {
    if (remaining <= 0) break;
    const dueLeft = round2(Number(row.amount_due) - Number(row.amount_paid || 0));
    if (dueLeft <= 0) continue;
    const apply = round2(Math.min(remaining, dueLeft));
    const newPaid = round2(Number(row.amount_paid || 0) + apply);
    const status = newPaid >= Number(row.amount_due) - 0.009 ? 'Paid' : 'Partial';
    await run(
      'UPDATE installments SET amount_paid = ?, status = ?, paid_at = ? WHERE id = ?',
      [newPaid, status, status === 'Paid' ? new Date().toISOString() : row.paid_at || null, row.id]
    );
    remaining = round2(remaining - apply);
  }

  const totals = await get(
    `SELECT
       COALESCE(SUM(amount_due), 0) AS total_due,
       COALESCE(SUM(amount_paid), 0) AS total_paid
     FROM installments WHERE loan_id = ?`,
    [loanId]
  );

  const paidTotal = round2(totals?.total_paid || 0);
  const outstanding = round2(Math.max(0, Number(totals?.total_due || 0) - paidTotal));
  let status = 'Running';
  if (outstanding <= 0.05) status = 'Closed';

  await run(
    `UPDATE loans SET paid_total = ?, outstanding = ?, status = CASE WHEN ? = 'Closed' THEN 'Closed' ELSE status END WHERE id = ?`,
    [paidTotal, outstanding, status, loanId]
  );

  if (status === 'Closed') {
    await run(`UPDATE loans SET status = 'Closed', outstanding = 0 WHERE id = ?`, [loanId]);
  }

  await refreshLoanDelinquency(loanId);
  return get('SELECT * FROM loans WHERE id = ?', [loanId]);
}

async function refreshLoanDelinquency(loanId) {
  const today = new Date().toISOString().slice(0, 10);
  const overdue = await all(
    `SELECT * FROM installments
     WHERE loan_id = ? AND status != 'Paid' AND date(due_date) < date(?)`,
    [loanId, today]
  );

  for (const row of overdue) {
    const dpd = Math.max(0, daysBetween(row.due_date, today));
    // 0.1% of installment per day past due, capped at 50% of installment
    const penalty = round2(
      Math.min(Number(row.amount_due) * 0.5, Number(row.amount_due) * 0.001 * dpd)
    );
    await run(`UPDATE installments SET status = 'Overdue', penalty = ? WHERE id = ?`, [
      penalty,
      row.id,
    ]);
  }

  const loan = await get('SELECT * FROM loans WHERE id = ?', [loanId]);
  if (!loan || ['Closed', 'Rejected', 'Pending'].includes(loan.status)) return loan;

  if (overdue.length) {
    const oldest = overdue[0];
    const dpd = Math.max(0, daysBetween(oldest.due_date, today));
    const nextStatus = dpd >= 90 ? 'Defaulted' : 'Delinquent';
    await run(`UPDATE loans SET status = ?, days_past_due = ? WHERE id = ?`, [nextStatus, dpd, loanId]);
  } else if (['Delinquent', 'Defaulted'].includes(loan.status)) {
    await run(`UPDATE loans SET status = 'Running', days_past_due = 0 WHERE id = ?`, [loanId]);
  } else {
    await run(`UPDATE loans SET days_past_due = 0 WHERE id = ?`, [loanId]);
  }

  return get('SELECT * FROM loans WHERE id = ?', [loanId]);
}

async function refreshAllDelinquency() {
  const loans = await all(
    `SELECT id FROM loans WHERE status IN ('Approved', 'Running', 'Delinquent', 'Defaulted') AND schedule_generated = 1`
  );
  for (const loan of loans) {
    await refreshLoanDelinquency(loan.id);
  }
}

async function ensureSchedulesForActiveLoans() {
  const loans = await all(
    `SELECT id FROM loans
     WHERE status IN ('Approved', 'Running', 'Delinquent', 'Defaulted')
       AND COALESCE(schedule_generated, 0) = 0`
  );
  for (const loan of loans) {
    await createScheduleForLoan(loan.id);
  }
}

async function syncPaymentAllocations() {
  const loans = await all(
    `SELECT l.id,
            COALESCE(l.paid_total, 0) AS paid_total,
            (SELECT COALESCE(SUM(amount), 0) FROM payments p
              WHERE p.loan_id = l.id AND p.status = 'Settled') AS settled
     FROM loans l
     WHERE COALESCE(l.schedule_generated, 0) = 1`
  );

  for (const loan of loans) {
    if (Math.abs(Number(loan.paid_total) - Number(loan.settled)) < 0.05) continue;
    await run(
      `UPDATE installments SET amount_paid = 0, status = 'Due', paid_at = NULL WHERE loan_id = ?`,
      [loan.id]
    );
    await run(`UPDATE loans SET paid_total = 0, outstanding = COALESCE(total_payable, amount) WHERE id = ?`, [
      loan.id,
    ]);
    const payments = await all(
      `SELECT amount FROM payments WHERE loan_id = ? AND status = 'Settled' ORDER BY id ASC`,
      [loan.id]
    );
    for (const payment of payments) {
      await allocatePaymentToLoan(loan.id, payment.amount);
    }
  }
}

async function init() {
  await run('PRAGMA foreign_keys = ON');

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'officer',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      product TEXT NOT NULL DEFAULT '',
      email TEXT,
      phone TEXT,
      national_id TEXT,
      status TEXT DEFAULT 'New',
      branch TEXT DEFAULT 'Main',
      guarantor_name TEXT DEFAULT '',
      guarantor_phone TEXT DEFAULT '',
      collateral TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      customer_name TEXT NOT NULL,
      product TEXT NOT NULL,
      amount REAL NOT NULL,
      months INTEGER NOT NULL,
      interest_rate REAL NOT NULL DEFAULT 18,
      emi REAL DEFAULT 0,
      total_payable REAL DEFAULT 0,
      paid_total REAL DEFAULT 0,
      outstanding REAL DEFAULT 0,
      days_past_due INTEGER DEFAULT 0,
      branch TEXT DEFAULT 'Main',
      officer TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'Pending',
      schedule_generated INTEGER DEFAULT 0,
      disbursed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_id INTEGER,
      customer_id INTEGER,
      customer_name TEXT NOT NULL,
      channel TEXT NOT NULL,
      amount REAL NOT NULL,
      reference TEXT,
      status TEXT DEFAULT 'Settled',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (loan_id) REFERENCES loans(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS installments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_id INTEGER NOT NULL,
      installment_no INTEGER NOT NULL,
      due_date TEXT NOT NULL,
      principal_due REAL NOT NULL,
      interest_due REAL NOT NULL,
      amount_due REAL NOT NULL,
      amount_paid REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Due',
      paid_at TEXT,
      FOREIGN KEY (loan_id) REFERENCES loans(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await ensureColumn('users', 'active', 'INTEGER DEFAULT 1');
  await ensureColumn('users', 'created_at', 'TEXT');
  await ensureColumn('customers', 'national_id', 'TEXT');
  await ensureColumn('customers', 'branch', "TEXT DEFAULT 'Main'");
  await ensureColumn('customers', 'guarantor_name', "TEXT DEFAULT ''");
  await ensureColumn('customers', 'guarantor_phone', "TEXT DEFAULT ''");
  await ensureColumn('customers', 'collateral', "TEXT DEFAULT ''");
  await ensureColumn('customers', 'created_at', 'TEXT');
  await ensureColumn('loans', 'customer_id', 'INTEGER');
  await ensureColumn('loans', 'interest_rate', 'REAL DEFAULT 18');
  await ensureColumn('loans', 'emi', 'REAL DEFAULT 0');
  await ensureColumn('loans', 'total_payable', 'REAL DEFAULT 0');
  await ensureColumn('loans', 'paid_total', 'REAL DEFAULT 0');
  await ensureColumn('loans', 'outstanding', 'REAL DEFAULT 0');
  await ensureColumn('loans', 'days_past_due', 'INTEGER DEFAULT 0');
  await ensureColumn('loans', 'branch', "TEXT DEFAULT 'Main'");
  await ensureColumn('loans', 'officer', "TEXT DEFAULT ''");
  await ensureColumn('loans', 'notes', "TEXT DEFAULT ''");
  await ensureColumn('loans', 'schedule_generated', 'INTEGER DEFAULT 0');
  await ensureColumn('loans', 'disbursed_at', 'TEXT');
  await ensureColumn('loans', 'created_at', 'TEXT');
  await ensureColumn('loans', 'rejection_reason', "TEXT DEFAULT ''");
  await ensureColumn('payments', 'loan_id', 'INTEGER');
  await ensureColumn('payments', 'customer_id', 'INTEGER');
  await ensureColumn('payments', 'reference', 'TEXT');
  await ensureColumn('payments', 'created_at', 'TEXT');
  await ensureColumn('installments', 'penalty', 'REAL DEFAULT 0');

  await run(`UPDATE customers SET created_at = datetime('now') WHERE created_at IS NULL`);
  await run(`UPDATE loans SET created_at = datetime('now') WHERE created_at IS NULL`);
  await run(`UPDATE payments SET created_at = datetime('now') WHERE created_at IS NULL`);
  await run(`UPDATE users SET created_at = datetime('now') WHERE created_at IS NULL`);
  await run(`UPDATE users SET role = 'officer' WHERE role = 'staff'`);

  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'password123';
  const user = await get('SELECT id, password FROM users WHERE username = ?', [adminUsername]);
  if (!user) {
    await run('INSERT INTO users (username, password, role, active) VALUES (?, ?, ?, 1)', [
      adminUsername,
      bcrypt.hashSync(adminPassword, 12),
      'admin',
    ]);
  } else if (process.env.ADMIN_PASSWORD && !bcrypt.compareSync(adminPassword, user.password)) {
    // Keep the seeded admin password aligned with Render/env ADMIN_PASSWORD.
    await run('UPDATE users SET password = ?, active = 1, role = ? WHERE id = ?', [
      bcrypt.hashSync(adminPassword, 12),
      'admin',
      user.id,
    ]);
  }

  const officer = await get('SELECT id FROM users WHERE username = ?', ['officer']);
  if (!officer) {
    await run('INSERT INTO users (username, password, role, active) VALUES (?, ?, ?, 1)', [
      'officer',
      bcrypt.hashSync('officer123', 12),
      'officer',
    ]);
  }
  const teller = await get('SELECT id FROM users WHERE username = ?', ['teller']);
  if (!teller) {
    await run('INSERT INTO users (username, password, role, active) VALUES (?, ?, ?, 1)', [
      'teller',
      bcrypt.hashSync('teller123', 12),
      'teller',
    ]);
  }

  const customerCount = await get('SELECT COUNT(*) AS count FROM customers');
  if ((customerCount?.count || 0) === 0) {
    const jane = await run(
      `INSERT INTO customers
        (name, product, email, phone, national_id, status, branch, guarantor_name, guarantor_phone, collateral)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'Jane Muthoni',
        'Title deed',
        'jane@example.com',
        '0712345678',
        '12345678',
        'Active',
        'Nairobi',
        'Peter Muthoni',
        '0700111222',
        'Title deed LR 123',
      ]
    );
    const kelvin = await run(
      `INSERT INTO customers
        (name, product, email, phone, national_id, status, branch, guarantor_name, guarantor_phone, collateral)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'Kelvin Otieno',
        'Motor vehicle',
        'kelvin@example.com',
        '0723456789',
        '23456789',
        'Approved',
        'Kisumu',
        'Mary Otieno',
        '0700222333',
        'Toyota Wish KDA 123A',
      ]
    );
    const faith = await run(
      `INSERT INTO customers
        (name, product, email, phone, national_id, status, branch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['Faith Njeri', 'Salary advance', 'faith@example.com', '0734567890', '34567890', 'New', 'Nakuru']
    );

    const loan1 = await run(
      `INSERT INTO loans
        (customer_id, customer_name, product, amount, months, interest_rate, status, branch, officer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [jane.id, 'Jane Muthoni', 'Title deed', 350000, 18, 16, 'Running', 'Nairobi', 'officer']
    );
    const loan2 = await run(
      `INSERT INTO loans
        (customer_id, customer_name, product, amount, months, interest_rate, status, branch, officer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [kelvin.id, 'Kelvin Otieno', 'Motor vehicle', 240000, 12, 18, 'Approved', 'Kisumu', 'officer']
    );
    await run(
      `INSERT INTO loans
        (customer_id, customer_name, product, amount, months, interest_rate, status, branch, officer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [faith.id, 'Faith Njeri', 'Salary advance', 80000, 6, 20, 'Pending', 'Nakuru', 'officer']
    );

    await createScheduleForLoan(loan1.id, new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10));
    await createScheduleForLoan(loan2.id);

    await run(
      `INSERT INTO payments (loan_id, customer_id, customer_name, channel, amount, reference, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [loan1.id, jane.id, 'Jane Muthoni', 'M-Pesa', 25000, 'MPX-1001', 'Settled']
    );
    await allocatePaymentToLoan(loan1.id, 25000);

    await run(
      `INSERT INTO payments (loan_id, customer_id, customer_name, channel, amount, reference, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [loan2.id, kelvin.id, 'Kelvin Otieno', 'Bank transfer', 18000, 'BNK-2044', 'Settled']
    );
    await allocatePaymentToLoan(loan2.id, 18000);
  } else {
    const orphanLoans = await all('SELECT id, customer_name FROM loans WHERE customer_id IS NULL');
    for (const loan of orphanLoans) {
      const customer = await get('SELECT id FROM customers WHERE name = ?', [loan.customer_name]);
      if (customer) await run('UPDATE loans SET customer_id = ? WHERE id = ?', [customer.id, loan.id]);
    }
    await ensureSchedulesForActiveLoans();
    await syncPaymentAllocations();
  }

  await refreshAllDelinquency();

  // Keep at least one overdue installment visible for demos when the book is current
  const overdueCount = await get(
    `SELECT COUNT(*) AS count FROM installments
     WHERE status != 'Paid' AND date(due_date) < date('now')`
  );
  if ((overdueCount?.count || 0) === 0) {
    const sample = await get(
      `SELECT id, loan_id FROM installments
       WHERE status != 'Paid'
       ORDER BY installment_no ASC LIMIT 1`
    );
    if (sample) {
      await run(`UPDATE installments SET due_date = date('now', '-15 day') WHERE id = ?`, [
        sample.id,
      ]);
      await refreshLoanDelinquency(sample.loan_id);
    }
  }
}

async function getDashboardStats() {
  const portfolio = await get(
    `SELECT COUNT(*) AS count, COALESCE(SUM(outstanding), 0) AS outstanding, COALESCE(SUM(amount), 0) AS principal
     FROM loans WHERE status IN ('Approved', 'Running', 'Delinquent', 'Defaulted')`
  );
  const disbursed = await get(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM loans WHERE status IN ('Approved', 'Running', 'Delinquent', 'Defaulted', 'Closed')`
  );
  const payments = await get(
    `SELECT COALESCE(SUM(amount), 0) AS settled FROM payments WHERE status = 'Settled'`
  );
  const pendingLoans = await get(`SELECT COUNT(*) AS count FROM loans WHERE status = 'Pending'`);
  const delinquent = await get(
    `SELECT COUNT(*) AS count FROM loans WHERE status IN ('Delinquent', 'Defaulted')`
  );
  const overdueAmount = await get(
    `SELECT COALESCE(SUM(amount_due - amount_paid), 0) AS total
     FROM installments WHERE status IN ('Overdue', 'Partial', 'Due') AND date(due_date) < date('now')`
  );
  const customers = await get(`SELECT COUNT(*) AS count FROM customers`);
  const activeCustomers = await get(
    `SELECT COUNT(*) AS count FROM customers WHERE status IN ('Active', 'Approved')`
  );
  const todayPayments = await get(
    `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
     FROM payments WHERE date(created_at) = date('now') AND status = 'Settled'`
  );
  const pendingPayments = await get(`SELECT COUNT(*) AS count FROM payments WHERE status = 'Pending'`);
  const aging = await all(
    `SELECT
       CASE
         WHEN days_past_due <= 0 THEN 'Current'
         WHEN days_past_due BETWEEN 1 AND 30 THEN '1-30'
         WHEN days_past_due BETWEEN 31 AND 60 THEN '31-60'
         WHEN days_past_due BETWEEN 61 AND 90 THEN '61-90'
         ELSE '90+'
       END AS bucket,
       COUNT(*) AS count,
       COALESCE(SUM(outstanding), 0) AS total
     FROM loans
     WHERE status IN ('Running', 'Delinquent', 'Defaulted', 'Approved')
     GROUP BY bucket`
  );

  const outstanding = Number(portfolio?.outstanding || 0);
  const settled = Number(payments?.settled || 0);
  const principal = Number(portfolio?.principal || 0);
  const repaymentRate = principal > 0 ? Math.min(99.9, (settled / (settled + outstanding || 1)) * 100) : 0;

  return {
    portfolioValue: outstanding,
    principalBook: principal,
    disbursedValue: Number(disbursed?.total || 0),
    loanCount: Number(portfolio?.count || 0),
    pendingLoans: Number(pendingLoans?.count || 0),
    delinquentCount: Number(delinquent?.count || 0),
    overdueAmount: Number(overdueAmount?.total || 0),
    repaymentRate: Number(repaymentRate.toFixed(1)),
    customerCount: Number(customers?.count || 0),
    activeCustomers: Number(activeCustomers?.count || 0),
    collectionsToday: Number(todayPayments?.total || 0),
    paymentsTodayCount: Number(todayPayments?.count || 0),
    pendingPayments: Number(pendingPayments?.count || 0),
    aging,
  };
}

module.exports = {
  db,
  init,
  run,
  all,
  get,
  getDashboardStats,
  writeAudit,
  createScheduleForLoan,
  allocatePaymentToLoan,
  refreshAllDelinquency,
  refreshLoanDelinquency,
};
