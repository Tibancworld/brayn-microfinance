const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const {
  init,
  all,
  run,
  get,
  getDashboardStats,
  writeAudit,
  createScheduleForLoan,
  allocatePaymentToLoan,
  refreshAllDelinquency,
} = require('./db');
const { calculateEmi, buildSchedule, round2 } = require('./lib/loanMath');

loadEnvFile(path.join(__dirname, '.env'));

const app = express();
const port = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const LOAN_PRODUCTS = new Set([
  'Title deed',
  'Motor vehicle',
  'Salary advance',
  'Check-off',
  'Non check-off',
  'Share-backed',
]);
const PAYMENT_CHANNELS = new Set(['M-Pesa', 'Bank transfer', 'Paybill', 'Cash', 'Check-off']);
const LOAN_STATUSES = new Set([
  'Pending',
  'Approved',
  'Running',
  'Rejected',
  'Closed',
  'Delinquent',
  'Defaulted',
]);
const CUSTOMER_STATUSES = new Set(['New', 'Active', 'Approved', 'Inactive', 'Suspended']);
const PAYMENT_STATUSES = new Set(['Settled', 'Pending', 'Failed']);
const ROLES = new Set(['admin', 'officer', 'teller']);
const loginAttempts = new Map();

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.status(401).json({ error: 'Authentication required' });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'You do not have permission for this action' });
    }
    return next();
  };
}

function parsePositiveNumber(value, field) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw Object.assign(new Error(`${field} must be a positive number`), { status: 400 });
  }
  return num;
}

function parsePositiveInt(value, field) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw Object.assign(new Error(`${field} must be a positive integer`), { status: 400 });
  }
  return num;
}

function cleanText(value, field, { required = false, max = 200 } = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) throw Object.assign(new Error(`${field} is required`), { status: 400 });
  if (text.length > max) throw Object.assign(new Error(`${field} is too long`), { status: 400 });
  return text;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    const text = String(value ?? '');
    if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((h) => escape(row[h])).join(','))].join(
    '\n'
  );
}

function parsePage(req) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function paged(items, total, page, pageSize) {
  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function checkLoginRate(ip) {
  const now = Date.now();
  const bucket = loginAttempts.get(ip) || { count: 0, start: now };
  if (now - bucket.start > 15 * 60 * 1000) {
    loginAttempts.set(ip, { count: 1, start: now });
    return true;
  }
  bucket.count += 1;
  loginAttempts.set(ip, bucket);
  return bucket.count <= 20;
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(
  session({
    name: 'brayn.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const PUBLIC_DIR = path.join(__dirname, 'public');

function safeNextPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.startsWith('/api')) return '/';
  const pathOnly = value.split('?')[0];
  if (pathOnly === '/login' || pathOnly === '/login.html') return '/';
  return value;
}

function resolveHtmlPage(pathname) {
  if (pathname === '/') return 'index.html';
  if (path.extname(pathname)) return null;
  const base = pathname.slice(1);
  if (!base || base.includes('/') || base.includes('\\') || base.includes('..')) return null;
  const file = `${base}.html`;
  if (!fs.existsSync(path.join(PUBLIC_DIR, file))) return null;
  return file;
}

// Clean URLs + server-side page auth (stops dashboard flash before login).
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api')) return next();

  if (req.path.endsWith('.html')) {
    let clean = req.path.slice(0, -5);
    if (clean === '/index' || clean === '') clean = '/';
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    return res.redirect(301, `${clean}${query}`);
  }

  if (req.path.startsWith('/css') || req.path.startsWith('/js')) return next();

  const htmlFile = resolveHtmlPage(req.path);
  if (!htmlFile) return next();

  if (htmlFile === 'login.html') {
    if (req.session?.user) return res.redirect(302, safeNextPath(req.query.next));
    return res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  }

  if (!req.session?.user) {
    return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  }

  return res.sendFile(path.join(PUBLIC_DIR, htmlFile));
});

app.get(
  '/api/health',
  asyncHandler(async (_req, res) => {
    await get('SELECT 1 AS ok');
    res.json({ ok: true, message: 'Brayn Microfinance API is live' });
  })
);

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ ok: true, user: req.session.user });
});

app.post(
  '/api/auth/login',
  asyncHandler(async (req, res) => {
    const ip = req.ip || 'local';
    if (!checkLoginRate(ip)) {
      return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }

    const username = cleanText(req.body.username, 'username', { required: true, max: 80 });
    const password = cleanText(req.body.password, 'password', { required: true, max: 200 });
    const user = await get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !user.active || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.user = { id: user.id, username: user.username, role: user.role };
    await writeAudit(user.id, 'login', 'user', user.id, 'Signed in');
    res.json({ ok: true, user: req.session.user });
  })
);

app.post('/api/auth/logout', (req, res) => {
  const userId = req.session?.user?.id;
  req.session.destroy(async () => {
    if (userId) await writeAudit(userId, 'logout', 'user', userId, 'Signed out').catch(() => {});
    res.clearCookie('brayn.sid');
    res.json({ ok: true });
  });
});

app.post(
  '/api/auth/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const currentPassword = cleanText(req.body.currentPassword, 'currentPassword', {
      required: true,
      max: 200,
    });
    const newPassword = cleanText(req.body.newPassword, 'newPassword', { required: true, max: 200 });
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const user = await get('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    if (!user || !bcrypt.compareSync(currentPassword, user.password)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    await run('UPDATE users SET password = ? WHERE id = ?', [
      bcrypt.hashSync(newPassword, 12),
      user.id,
    ]);
    await writeAudit(user.id, 'password', 'user', user.id, 'Changed own password');
    res.json({ ok: true });
  })
);

app.get(
  '/api/dashboard',
  requireAuth,
  asyncHandler(async (_req, res) => {
    await refreshAllDelinquency();
    const stats = await getDashboardStats();
    const [recentLoans, recentCustomers, recentPayments, dueSoon, overdueInstallments] =
      await Promise.all([
        all(
          `SELECT l.*, c.phone AS customer_phone
           FROM loans l LEFT JOIN customers c ON c.id = l.customer_id
           ORDER BY l.id DESC LIMIT 5`
        ),
        all('SELECT * FROM customers ORDER BY id DESC LIMIT 5'),
        all('SELECT * FROM payments ORDER BY id DESC LIMIT 5'),
        all(
          `SELECT i.*, l.customer_name, l.product, l.branch
           FROM installments i
           JOIN loans l ON l.id = i.loan_id
           WHERE i.status != 'Paid'
             AND date(i.due_date) BETWEEN date('now') AND date('now', '+7 day')
           ORDER BY i.due_date ASC
           LIMIT 8`
        ),
        all(
          `SELECT i.*, l.customer_name, l.product, l.branch, l.days_past_due
           FROM installments i
           JOIN loans l ON l.id = i.loan_id
           WHERE i.status != 'Paid'
             AND date(i.due_date) < date('now')
           ORDER BY i.due_date ASC
           LIMIT 8`
        ),
      ]);
    res.json({
      ...stats,
      recentLoans,
      recentCustomers,
      recentPayments,
      dueSoon,
      overdueInstallments,
    });
  })
);

app.get(
  '/api/notifications',
  requireAuth,
  asyncHandler(async (_req, res) => {
    await refreshAllDelinquency();
    const [dueSoon, overdue, pending] = await Promise.all([
      all(
        `SELECT i.id, i.loan_id, i.due_date, i.amount_due, i.amount_paid, i.penalty,
                l.customer_name, l.product
         FROM installments i
         JOIN loans l ON l.id = i.loan_id
         WHERE i.status != 'Paid'
           AND date(i.due_date) BETWEEN date('now') AND date('now', '+7 day')
         ORDER BY i.due_date ASC
         LIMIT 10`
      ),
      all(
        `SELECT i.id, i.loan_id, i.due_date, i.amount_due, i.amount_paid, i.penalty,
                l.customer_name, l.product, l.days_past_due
         FROM installments i
         JOIN loans l ON l.id = i.loan_id
         WHERE i.status != 'Paid'
           AND date(i.due_date) < date('now')
         ORDER BY i.due_date ASC
         LIMIT 10`
      ),
      get(`SELECT COUNT(*) AS count FROM loans WHERE status = 'Pending'`),
    ]);

    res.json({
      counts: {
        dueSoon: dueSoon.length,
        overdue: overdue.length,
        pendingApprovals: Number(pending?.count || 0),
        total: dueSoon.length + overdue.length + Number(pending?.count || 0),
      },
      dueSoon,
      overdue,
    });
  })
);

app.get(
  '/api/collections',
  requireAuth,
  asyncHandler(async (req, res) => {
    await refreshAllDelinquency();
    const type = cleanText(req.query.type || 'overdue', 'type', { max: 40 });
    const branch = cleanText(req.query.branch || '', 'branch', { max: 80 });
    const q = cleanText(req.query.q || '', 'q', { max: 120 }).toLowerCase();
    const { page, pageSize, offset } = parsePage(req);

    const params = [];
    let where = ` WHERE i.status != 'Paid'`;
    if (type === 'dueSoon') {
      where += ` AND date(i.due_date) BETWEEN date('now') AND date('now', '+7 day')`;
    } else {
      where += ` AND date(i.due_date) < date('now')`;
    }
    if (branch) {
      where += ` AND lower(l.branch) = lower(?)`;
      params.push(branch);
    }
    if (q) {
      where += ` AND (lower(l.customer_name) LIKE ? OR cast(l.id AS TEXT) LIKE ? OR lower(l.product) LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const totalRow = await get(
      `SELECT COUNT(*) AS count
       FROM installments i
       JOIN loans l ON l.id = i.loan_id
       ${where}`,
      params
    );
    const items = await all(
      `SELECT i.id, i.loan_id, i.installment_no, i.due_date, i.amount_due, i.amount_paid,
              i.penalty, i.status AS installment_status,
              l.customer_name, l.customer_id, l.product, l.branch, l.officer,
              l.days_past_due, l.status AS loan_status, l.outstanding,
              ROUND(i.amount_due - i.amount_paid + COALESCE(i.penalty, 0), 2) AS amount_owed
       FROM installments i
       JOIN loans l ON l.id = i.loan_id
       ${where}
       ORDER BY i.due_date ASC, i.installment_no ASC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json(paged(items, Number(totalRow?.count || 0), page, pageSize));
  })
);

app.get(
  '/api/search',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = cleanText(req.query.q || '', 'q', { required: true, max: 120 }).toLowerCase();
    const like = `%${q}%`;
    const [loans, customers, payments] = await Promise.all([
      all(
        `SELECT id, customer_name, product, status, outstanding
         FROM loans
         WHERE lower(customer_name) LIKE ? OR lower(product) LIKE ? OR cast(id AS TEXT) LIKE ?
         ORDER BY id DESC LIMIT 8`,
        [like, like, like]
      ),
      all(
        `SELECT id, name, phone, status, branch
         FROM customers
         WHERE lower(name) LIKE ? OR lower(phone) LIKE ? OR lower(national_id) LIKE ?
         ORDER BY id DESC LIMIT 8`,
        [like, like, like]
      ),
      all(
        `SELECT id, customer_name, channel, amount, reference, loan_id
         FROM payments
         WHERE lower(customer_name) LIKE ? OR lower(reference) LIKE ? OR cast(id AS TEXT) LIKE ?
         ORDER BY id DESC LIMIT 8`,
        [like, like, like]
      ),
    ]);
    res.json({ q, loans, customers, payments });
  })
);

app.get(
  '/api/loans',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = cleanText(req.query.q || '', 'q', { max: 120 }).toLowerCase();
    const status = cleanText(req.query.status || '', 'status', { max: 40 });
    const branch = cleanText(req.query.branch || '', 'branch', { max: 80 });
    const { page, pageSize, offset } = parsePage(req);
    const params = [];
    let where = ' WHERE 1 = 1';
    if (q) {
      where += ` AND (lower(l.customer_name) LIKE ? OR lower(l.product) LIKE ? OR cast(l.id AS TEXT) LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status) {
      where += ` AND l.status = ?`;
      params.push(status);
    }
    if (branch) {
      where += ` AND lower(l.branch) = lower(?)`;
      params.push(branch);
    }

    const totalRow = await get(
      `SELECT COUNT(*) AS count FROM loans l LEFT JOIN customers c ON c.id = l.customer_id${where}`,
      params
    );
    const items = await all(
      `SELECT l.*, c.email AS customer_email, c.phone AS customer_phone
       FROM loans l
       LEFT JOIN customers c ON c.id = l.customer_id
       ${where}
       ORDER BY l.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json(paged(items, Number(totalRow?.count || 0), page, pageSize));
  })
);

app.get(
  '/api/loans/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = parsePositiveInt(req.params.id, 'id');
    const loan = await get(
      `SELECT l.*, c.email AS customer_email, c.phone AS customer_phone,
              c.guarantor_name, c.guarantor_phone, c.collateral, c.national_id
       FROM loans l LEFT JOIN customers c ON c.id = l.customer_id
       WHERE l.id = ?`,
      [id]
    );
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    const installments = await all(
      'SELECT * FROM installments WHERE loan_id = ? ORDER BY installment_no ASC',
      [id]
    );
    const payments = await all(
      'SELECT * FROM payments WHERE loan_id = ? ORDER BY id DESC',
      [id]
    );
    const nextOpen = installments.find((row) => row.status !== 'Paid');
    const nextDueAmount = nextOpen
      ? round2(
          Number(nextOpen.amount_due || 0) -
            Number(nextOpen.amount_paid || 0) +
            Number(nextOpen.penalty || 0)
        )
      : 0;
    res.json({ loan, installments, payments, nextDueAmount, nextInstallment: nextOpen || null });
  })
);

app.post(
  '/api/loans',
  requireAuth,
  requireRole('admin', 'officer'),
  asyncHandler(async (req, res) => {
    const customerName = cleanText(req.body.customerName, 'customerName', { required: true, max: 120 });
    const product = cleanText(req.body.product, 'product', { required: true, max: 80 });
    const notes = cleanText(req.body.notes || '', 'notes', { max: 1000 });
    const branch = cleanText(req.body.branch || 'Main', 'branch', { max: 80 });
    const officer = cleanText(req.body.officer || req.session.user.username, 'officer', { max: 80 });
    const amount = parsePositiveNumber(req.body.amount, 'amount');
    const months = parsePositiveInt(req.body.months, 'months');
    const interestRate = Number(req.body.interestRate ?? 18);

    if (!LOAN_PRODUCTS.has(product)) return res.status(400).json({ error: 'Unsupported loan product' });
    if (months > 60) return res.status(400).json({ error: 'months cannot exceed 60' });
    if (!Number.isFinite(interestRate) || interestRate < 0 || interestRate > 100) {
      return res.status(400).json({ error: 'interestRate must be between 0 and 100' });
    }

    let customerId = req.body.customerId ? parsePositiveInt(req.body.customerId, 'customerId') : null;
    let customer = customerId
      ? await get('SELECT * FROM customers WHERE id = ?', [customerId])
      : await get('SELECT * FROM customers WHERE lower(name) = lower(?)', [customerName]);

    if (!customer) {
      const created = await run(
        `INSERT INTO customers (name, product, email, phone, status, branch)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          customerName,
          product,
          cleanText(req.body.email || '', 'email', { max: 160 }),
          cleanText(req.body.phone || '', 'phone', { max: 40 }),
          'New',
          branch,
        ]
      );
      customer = await get('SELECT * FROM customers WHERE id = ?', [created.id]);
    }

    const preview = buildSchedule(amount, interestRate, months);
    const created = await run(
      `INSERT INTO loans
        (customer_id, customer_name, product, amount, months, interest_rate, emi, total_payable, outstanding, notes, status, branch, officer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)`,
      [
        customer.id,
        customer.name,
        product,
        amount,
        months,
        interestRate,
        preview.emi,
        preview.totalPayable,
        preview.totalPayable,
        notes,
        branch,
        officer,
      ]
    );

    const loan = await get('SELECT * FROM loans WHERE id = ?', [created.id]);
    await writeAudit(req.session.user.id, 'create', 'loan', loan.id, `Created pending loan for ${customer.name}`);
    res.status(201).json({ ok: true, loan });
  })
);

app.patch(
  '/api/loans/:id/status',
  requireAuth,
  requireRole('admin', 'officer'),
  asyncHandler(async (req, res) => {
    const id = parsePositiveInt(req.params.id, 'id');
    const status = cleanText(req.body.status, 'status', { required: true, max: 40 });
    if (!LOAN_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid loan status' });

    const existing = await get('SELECT * FROM loans WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Loan not found' });

    const reason = cleanText(req.body.reason || '', 'reason', { max: 500 });
    if (status === 'Rejected' && !reason) {
      return res.status(400).json({ error: 'A rejection reason is required' });
    }

    await run('UPDATE loans SET status = ?, rejection_reason = ? WHERE id = ?', [
      status,
      status === 'Rejected' ? reason : existing.rejection_reason || '',
      id,
    ]);

    if (status === 'Approved' || status === 'Running') {
      await createScheduleForLoan(id);
      await run('UPDATE customers SET status = ? WHERE id = ?', ['Active', existing.customer_id]);
      if (status === 'Approved') {
        await run(`UPDATE loans SET status = 'Approved' WHERE id = ?`, [id]);
      }
      if (status === 'Running') {
        await run(`UPDATE loans SET status = 'Running' WHERE id = ?`, [id]);
      }
    }

    const loan = await get('SELECT * FROM loans WHERE id = ?', [id]);
    await writeAudit(
      req.session.user.id,
      'status',
      'loan',
      id,
      status === 'Rejected'
        ? `${existing.status} → Rejected: ${reason}`
        : `${existing.status} → ${loan.status}`
    );
    res.json({ ok: true, loan });
  })
);

app.patch(
  '/api/loans/:id',
  requireAuth,
  requireRole('admin', 'officer'),
  asyncHandler(async (req, res) => {
    const id = parsePositiveInt(req.params.id, 'id');
    const existing = await get('SELECT * FROM loans WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Loan not found' });

    const notes = cleanText(req.body.notes ?? existing.notes ?? '', 'notes', { max: 1000 });
    const branch = cleanText(req.body.branch ?? existing.branch ?? 'Main', 'branch', { max: 80 });
    const officer = cleanText(req.body.officer ?? existing.officer ?? '', 'officer', { max: 80 });

    await run('UPDATE loans SET notes = ?, branch = ?, officer = ? WHERE id = ?', [
      notes,
      branch,
      officer,
      id,
    ]);
    const loan = await get('SELECT * FROM loans WHERE id = ?', [id]);
    await writeAudit(req.session.user.id, 'update', 'loan', id, 'Updated loan details');
    res.json({ ok: true, loan });
  })
);

app.post(
  '/api/loans/:id/close',
  requireAuth,
  requireRole('admin', 'officer'),
  asyncHandler(async (req, res) => {
    const id = parsePositiveInt(req.params.id, 'id');
    const existing = await get('SELECT * FROM loans WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Loan not found' });
    if (['Rejected', 'Closed'].includes(existing.status)) {
      return res.status(400).json({ error: 'Loan cannot be closed from its current status' });
    }

    const force = Boolean(req.body.force);
    const outstanding = Number(existing.outstanding || 0);
    if (outstanding > 1 && !force) {
      return res.status(400).json({
        error: `Outstanding balance is ${outstanding.toFixed(2)}. Pass force=true to close anyway.`,
      });
    }

    await run(
      `UPDATE loans SET status = 'Closed', outstanding = 0, days_past_due = 0 WHERE id = ?`,
      [id]
    );
    await run(
      `UPDATE installments
       SET status = 'Paid', amount_paid = amount_due, paid_at = COALESCE(paid_at, datetime('now'))
       WHERE loan_id = ? AND status != 'Paid'`,
      [id]
    );

    const loan = await get('SELECT * FROM loans WHERE id = ?', [id]);
    await writeAudit(
      req.session.user.id,
      'close',
      'loan',
      id,
      force ? 'Force closed with balance' : 'Closed loan'
    );
    res.json({ ok: true, loan });
  })
);

app.get(
  '/api/customers',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = cleanText(req.query.q || '', 'q', { max: 120 }).toLowerCase();
    const { page, pageSize, offset } = parsePage(req);
    const params = [];
    let where = ' WHERE 1 = 1';
    if (q) {
      where += ` AND (lower(c.name) LIKE ? OR lower(c.phone) LIKE ? OR lower(c.national_id) LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const totalRow = await get(`SELECT COUNT(*) AS count FROM customers c${where}`, params);
    const items = await all(
      `SELECT c.*,
        (SELECT COUNT(*) FROM loans l WHERE l.customer_id = c.id) AS loan_count,
        (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.customer_id = c.id AND p.status = 'Settled') AS paid_total
       FROM customers c
       ${where}
       ORDER BY c.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json(paged(items, Number(totalRow?.count || 0), page, pageSize));
  })
);

app.get(
  '/api/customers/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = parsePositiveInt(req.params.id, 'id');
    const customer = await get('SELECT * FROM customers WHERE id = ?', [id]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    if (req.query.detail === '1') {
      const [loans, payments] = await Promise.all([
        all('SELECT * FROM loans WHERE customer_id = ? ORDER BY id DESC', [id]),
        all('SELECT * FROM payments WHERE customer_id = ? ORDER BY id DESC LIMIT 20', [id]),
      ]);
      return res.json({ customer, loans, payments });
    }

    res.json(customer);
  })
);

app.post(
  '/api/customers',
  requireAuth,
  requireRole('admin', 'officer'),
  asyncHandler(async (req, res) => {
    const name = cleanText(req.body.name, 'name', { required: true, max: 120 });
    const product = cleanText(req.body.product || '', 'product', { max: 80 });
    const email = cleanText(req.body.email || '', 'email', { max: 160 });
    const phone = cleanText(req.body.phone || '', 'phone', { max: 40 });
    const nationalId = cleanText(req.body.nationalId || '', 'nationalId', { max: 40 });
    const status = cleanText(req.body.status || 'New', 'status', { max: 40 });
    const branch = cleanText(req.body.branch || 'Main', 'branch', { max: 80 });
    const guarantorName = cleanText(req.body.guarantorName || '', 'guarantorName', { max: 120 });
    const guarantorPhone = cleanText(req.body.guarantorPhone || '', 'guarantorPhone', { max: 40 });
    const collateral = cleanText(req.body.collateral || '', 'collateral', { max: 240 });

    if (product && !LOAN_PRODUCTS.has(product)) return res.status(400).json({ error: 'Unsupported product' });
    if (!CUSTOMER_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid customer status' });

    const created = await run(
      `INSERT INTO customers
        (name, product, email, phone, national_id, status, branch, guarantor_name, guarantor_phone, collateral)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, product, email, phone, nationalId, status, branch, guarantorName, guarantorPhone, collateral]
    );
    const customer = await get('SELECT * FROM customers WHERE id = ?', [created.id]);
    await writeAudit(req.session.user.id, 'create', 'customer', customer.id, name);
    res.status(201).json({ ok: true, customer });
  })
);

app.patch(
  '/api/customers/:id',
  requireAuth,
  requireRole('admin', 'officer'),
  asyncHandler(async (req, res) => {
    const id = parsePositiveInt(req.params.id, 'id');
    const existing = await get('SELECT * FROM customers WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Customer not found' });

    const name = cleanText(req.body.name ?? existing.name, 'name', { required: true, max: 120 });
    const product = cleanText(req.body.product ?? existing.product ?? '', 'product', { max: 80 });
    const email = cleanText(req.body.email ?? existing.email ?? '', 'email', { max: 160 });
    const phone = cleanText(req.body.phone ?? existing.phone ?? '', 'phone', { max: 40 });
    const nationalId = cleanText(req.body.nationalId ?? existing.national_id ?? '', 'nationalId', {
      max: 40,
    });
    const status = cleanText(req.body.status ?? existing.status, 'status', { max: 40 });
    const branch = cleanText(req.body.branch ?? existing.branch ?? 'Main', 'branch', { max: 80 });
    const guarantorName = cleanText(
      req.body.guarantorName ?? existing.guarantor_name ?? '',
      'guarantorName',
      { max: 120 }
    );
    const guarantorPhone = cleanText(
      req.body.guarantorPhone ?? existing.guarantor_phone ?? '',
      'guarantorPhone',
      { max: 40 }
    );
    const collateral = cleanText(req.body.collateral ?? existing.collateral ?? '', 'collateral', {
      max: 240,
    });

    if (product && !LOAN_PRODUCTS.has(product)) return res.status(400).json({ error: 'Unsupported product' });
    if (!CUSTOMER_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid customer status' });

    await run(
      `UPDATE customers
       SET name = ?, product = ?, email = ?, phone = ?, national_id = ?, status = ?,
           branch = ?, guarantor_name = ?, guarantor_phone = ?, collateral = ?
       WHERE id = ?`,
      [
        name,
        product,
        email,
        phone,
        nationalId,
        status,
        branch,
        guarantorName,
        guarantorPhone,
        collateral,
        id,
      ]
    );
    await run(`UPDATE loans SET customer_name = ? WHERE customer_id = ?`, [name, id]);
    const customer = await get('SELECT * FROM customers WHERE id = ?', [id]);
    await writeAudit(req.session.user.id, 'update', 'customer', id, `Updated ${name}`);
    res.json({ ok: true, customer });
  })
);

app.get(
  '/api/payments',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = cleanText(req.query.q || '', 'q', { max: 120 }).toLowerCase();
    const channel = cleanText(req.query.channel || '', 'channel', { max: 60 });
    const status = cleanText(req.query.status || '', 'status', { max: 40 });
    const date = cleanText(req.query.date || '', 'date', { max: 20 });
    const dateFrom = cleanText(req.query.dateFrom || '', 'dateFrom', { max: 20 });
    const dateTo = cleanText(req.query.dateTo || '', 'dateTo', { max: 20 });
    const { page, pageSize, offset } = parsePage(req);
    const params = [];
    let where = ' WHERE 1 = 1';
    if (q) {
      where += ` AND (lower(p.customer_name) LIKE ? OR lower(p.reference) LIKE ? OR cast(p.loan_id AS TEXT) LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (channel) {
      where += ` AND p.channel = ?`;
      params.push(channel);
    }
    if (status) {
      where += ` AND p.status = ?`;
      params.push(status);
    }
    if (date) {
      where += ` AND date(p.created_at) = date(?)`;
      params.push(date);
    } else {
      if (dateFrom) {
        where += ` AND date(p.created_at) >= date(?)`;
        params.push(dateFrom);
      }
      if (dateTo) {
        where += ` AND date(p.created_at) <= date(?)`;
        params.push(dateTo);
      }
    }

    const totalRow = await get(
      `SELECT COUNT(*) AS count FROM payments p LEFT JOIN loans l ON l.id = p.loan_id${where}`,
      params
    );
    const items = await all(
      `SELECT p.*, l.product AS loan_product,
              COALESCE(p.customer_id, l.customer_id) AS customer_id
       FROM payments p LEFT JOIN loans l ON l.id = p.loan_id
       ${where}
       ORDER BY p.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json(paged(items, Number(totalRow?.count || 0), page, pageSize));
  })
);

app.get(
  '/api/payments/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = parsePositiveInt(req.params.id, 'id');
    const payment = await get(
      `SELECT p.*, l.product AS loan_product, l.branch AS loan_branch, l.officer AS loan_officer,
              l.outstanding AS loan_outstanding, l.paid_total AS loan_paid_total, l.status AS loan_status
       FROM payments p
       LEFT JOIN loans l ON l.id = p.loan_id
       WHERE p.id = ?`,
      [id]
    );
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    res.json(payment);
  })
);

app.patch(
  '/api/payments/:id/status',
  requireAuth,
  requireRole('admin', 'officer', 'teller'),
  asyncHandler(async (req, res) => {
    const id = parsePositiveInt(req.params.id, 'id');
    const status = cleanText(req.body.status, 'status', { required: true, max: 40 });
    if (!PAYMENT_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid payment status' });

    const existing = await get('SELECT * FROM payments WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Payment not found' });

    if (existing.status === status) {
      return res.json({ ok: true, payment: existing });
    }

    if (existing.status === 'Settled' && status !== 'Settled') {
      return res.status(400).json({ error: 'Settled payments cannot be reversed from this screen' });
    }

    await run('UPDATE payments SET status = ? WHERE id = ?', [status, id]);

    if (status === 'Settled' && existing.status !== 'Settled' && existing.loan_id) {
      const loan = await get('SELECT * FROM loans WHERE id = ?', [existing.loan_id]);
      if (loan && ['Approved', 'Pending'].includes(loan.status)) {
        await createScheduleForLoan(existing.loan_id);
        await run(`UPDATE loans SET status = 'Running' WHERE id = ?`, [existing.loan_id]);
      }
      await allocatePaymentToLoan(existing.loan_id, Number(existing.amount));
    }

    const payment = await get('SELECT * FROM payments WHERE id = ?', [id]);
    await writeAudit(
      req.session.user.id,
      'update',
      'payment',
      id,
      `${existing.status} → ${status}`
    );
    res.json({ ok: true, payment });
  })
);

app.post(
  '/api/payments',
  requireAuth,
  requireRole('admin', 'officer', 'teller'),
  asyncHandler(async (req, res) => {
    const channel = cleanText(req.body.channel, 'channel', { required: true, max: 60 });
    const amount = parsePositiveNumber(req.body.amount, 'amount');
    const reference = cleanText(req.body.reference || '', 'reference', { max: 80 });
    const status = cleanText(req.body.status || 'Settled', 'status', { max: 40 });

    if (!PAYMENT_CHANNELS.has(channel)) return res.status(400).json({ error: 'Unsupported payment channel' });
    if (!PAYMENT_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid payment status' });

    let loanId = req.body.loanId ? parsePositiveInt(req.body.loanId, 'loanId') : null;
    let customerId = req.body.customerId ? parsePositiveInt(req.body.customerId, 'customerId') : null;
    let customerName = cleanText(req.body.customerName || '', 'customerName', { max: 120 });

    if (loanId) {
      const loan = await get('SELECT * FROM loans WHERE id = ?', [loanId]);
      if (!loan) return res.status(404).json({ error: 'Loan not found' });
      customerId = loan.customer_id;
      customerName = loan.customer_name;
    } else if (customerId) {
      const customer = await get('SELECT * FROM customers WHERE id = ?', [customerId]);
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
      customerName = customer.name;
    } else if (customerName) {
      const customer = await get('SELECT * FROM customers WHERE lower(name) = lower(?)', [customerName]);
      if (customer) customerId = customer.id;
    } else {
      return res.status(400).json({ error: 'loanId, customerId, or customerName is required' });
    }

    const created = await run(
      `INSERT INTO payments
        (loan_id, customer_id, customer_name, channel, amount, reference, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [loanId, customerId, customerName, channel, amount, reference || null, status]
    );

    if (status === 'Settled' && loanId) {
      const loan = await get('SELECT * FROM loans WHERE id = ?', [loanId]);
      if (loan && ['Approved', 'Pending'].includes(loan.status)) {
        await createScheduleForLoan(loanId);
        await run(`UPDATE loans SET status = 'Running' WHERE id = ?`, [loanId]);
      }
      await allocatePaymentToLoan(loanId, amount);
    }

    const payment = await get('SELECT * FROM payments WHERE id = ?', [created.id]);
    await writeAudit(
      req.session.user.id,
      'create',
      'payment',
      payment.id,
      `${channel} ${amount} for ${customerName}`
    );
    res.status(201).json({ ok: true, payment });
  })
);

app.get(
  '/api/reports',
  requireAuth,
  asyncHandler(async (_req, res) => {
    await refreshAllDelinquency();
    const [summary, payments, statusBreakdown, stats, branches] = await Promise.all([
      all(
        `SELECT product, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(outstanding), 0) AS outstanding
         FROM loans GROUP BY product ORDER BY total DESC`
      ),
      all(
        `SELECT channel, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
         FROM payments GROUP BY channel ORDER BY total DESC`
      ),
      all(
        `SELECT status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(outstanding), 0) AS outstanding
         FROM loans GROUP BY status ORDER BY count DESC`
      ),
      getDashboardStats(),
      all(
        `SELECT branch, COUNT(*) AS count, COALESCE(SUM(outstanding), 0) AS outstanding
         FROM loans GROUP BY branch ORDER BY outstanding DESC`
      ),
    ]);
    res.json({ summary, payments, statusBreakdown, stats, branches });
  })
);

app.get(
  '/api/export/:type',
  requireAuth,
  asyncHandler(async (req, res) => {
    const type = cleanText(req.params.type, 'type', { required: true, max: 40 });
    let rows = [];
    if (type === 'loans') {
      rows = await all(
        `SELECT id, customer_name, product, amount, months, interest_rate, emi, outstanding, paid_total, status, branch, officer, days_past_due, created_at
         FROM loans ORDER BY id DESC`
      );
    } else if (type === 'customers') {
      rows = await all(
        `SELECT id, name, product, phone, email, national_id, status, branch, guarantor_name, collateral, created_at
         FROM customers ORDER BY id DESC`
      );
    } else if (type === 'payments') {
      rows = await all(
        `SELECT id, loan_id, customer_name, channel, amount, reference, status, created_at
         FROM payments ORDER BY id DESC`
      );
    } else if (type === 'audit') {
      if (!['admin', 'officer'].includes(req.session.user.role)) {
        return res.status(403).json({ error: 'You do not have permission for this action' });
      }
      rows = await all(
        `SELECT a.id, u.username, a.action, a.entity_type, a.entity_id, a.details, a.created_at
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.id DESC LIMIT 1000`
      );
    } else if (type === 'collections') {
      await refreshAllDelinquency();
      rows = await all(
        `SELECT l.id AS loan_id, l.customer_name, l.product, l.branch, l.days_past_due,
                i.installment_no, i.due_date, i.amount_due, i.amount_paid, i.penalty,
                ROUND(i.amount_due - i.amount_paid + COALESCE(i.penalty, 0), 2) AS amount_owed,
                i.status AS installment_status
         FROM installments i
         JOIN loans l ON l.id = i.loan_id
         WHERE i.status != 'Paid' AND date(i.due_date) < date('now')
         ORDER BY i.due_date ASC`
      );
    } else {
      return res.status(400).json({ error: 'Unsupported export type' });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="brayn-${type}.csv"`);
    res.send(toCsv(rows));
  })
);

app.get(
  '/api/users',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    const users = await all(
      `SELECT id, username, role, active, created_at FROM users ORDER BY id ASC`
    );
    res.json(users);
  })
);

app.post(
  '/api/users',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const username = cleanText(req.body.username, 'username', { required: true, max: 80 });
    const password = cleanText(req.body.password, 'password', { required: true, max: 200 });
    const role = cleanText(req.body.role || 'officer', 'role', { max: 40 });
    if (!ROLES.has(role)) return res.status(400).json({ error: 'Invalid role' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    try {
      const created = await run(
        'INSERT INTO users (username, password, role, active) VALUES (?, ?, ?, 1)',
        [username, bcrypt.hashSync(password, 12), role]
      );
      const user = await get('SELECT id, username, role, active, created_at FROM users WHERE id = ?', [
        created.id,
      ]);
      await writeAudit(req.session.user.id, 'create', 'user', user.id, `Created ${username} (${role})`);
      res.status(201).json({ ok: true, user });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        return res.status(400).json({ error: 'Username already exists' });
      }
      throw error;
    }
  })
);

app.patch(
  '/api/users/:id',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const id = parsePositiveInt(req.params.id, 'id');
    const existing = await get('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'User not found' });

    const role = cleanText(req.body.role ?? existing.role, 'role', { max: 40 });
    const active = req.body.active === undefined ? existing.active : req.body.active ? 1 : 0;
    if (!ROLES.has(role)) return res.status(400).json({ error: 'Invalid role' });
    if (existing.username === 'admin' && !active) {
      return res.status(400).json({ error: 'Cannot deactivate the primary admin' });
    }

    await run('UPDATE users SET role = ?, active = ? WHERE id = ?', [role, active, id]);
    if (req.body.password) {
      const password = cleanText(req.body.password, 'password', { required: true, max: 200 });
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      await run('UPDATE users SET password = ? WHERE id = ?', [bcrypt.hashSync(password, 12), id]);
    }

    const user = await get('SELECT id, username, role, active, created_at FROM users WHERE id = ?', [id]);
    await writeAudit(req.session.user.id, 'update', 'user', id, `Updated ${user.username}`);
    res.json({ ok: true, user });
  })
);

app.get(
  '/api/audit',
  requireAuth,
  requireRole('admin', 'officer'),
  asyncHandler(async (_req, res) => {
    const rows = await all(
      `SELECT a.*, u.username
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.id DESC LIMIT 100`
    );
    res.json(rows);
  })
);

app.post(
  '/api/tools/emi',
  requireAuth,
  asyncHandler(async (req, res) => {
    const amount = parsePositiveNumber(req.body.amount, 'amount');
    const months = parsePositiveInt(req.body.months, 'months');
    const rate = Number(req.body.interestRate ?? 18);
    const schedule = buildSchedule(amount, rate, months);
    res.json({
      emi: schedule.emi,
      totalPayable: schedule.totalPayable,
      totalInterest: round2(schedule.totalPayable - amount),
      calculateEmi: calculateEmi(amount, rate, months),
    });
  })
);

app.post(
  '/api/admin/backup',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const source = path.join(__dirname, 'data', 'brayn.db');
    const backupDir = path.join(__dirname, 'data', 'backups');
    if (!fs.existsSync(source)) return res.status(404).json({ error: 'Database file not found' });
    fs.mkdirSync(backupDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(backupDir, `brayn-${stamp}.db`);
    fs.copyFileSync(source, target);

    await writeAudit(req.session.user.id, 'backup', 'database', null, path.basename(target));
    res.json({
      ok: true,
      file: path.basename(target),
      path: target,
    });
  })
);

app.get(
  '/api/admin/backups',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    const backupDir = path.join(__dirname, 'data', 'backups');
    if (!fs.existsSync(backupDir)) return res.json([]);
    const files = fs
      .readdirSync(backupDir)
      .filter((name) => name.endsWith('.db'))
      .map((name) => {
        const full = path.join(backupDir, name);
        const stat = fs.statSync(full);
        return { file: name, size: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    res.json(files);
  })
);

app.use(express.static(PUBLIC_DIR, { index: false, extensions: ['html'] }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }));
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

init()
  .then(() => {
    app.listen(port, '0.0.0.0', () => {
      const publicUrl = process.env.APP_URL || `http://localhost:${port}`;
      console.log(`Brayn Microfinance running at ${publicUrl}`);
      if (!process.env.SESSION_SECRET) {
        console.warn('SESSION_SECRET is not set. Using an ephemeral secret for this process.');
      }
    });
  })
  .catch((error) => {
    console.error('Failed to initialize DB', error);
    process.exit(1);
  });
