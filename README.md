# Brayn Microfinance

Staff lending workspace for loan applications, repayment schedules, collections, customer KYC, and portfolio reporting.

## Stack

- Node.js + Express
- SQLite (`data/brayn.db`)
- Session auth with roles: `admin`, `officer`, `teller`
- Vanilla HTML/CSS/JS in `public/`

## Quick start

```bash
npm install
npm start
```

Open [http://localhost:3000/login.html](http://localhost:3000/login.html).

### Demo users

| User | Password | Access |
|---|---|---|
| `admin` | `password123` | Full access + staff settings |
| `officer` | `officer123` | Loans, customers, approvals |
| `teller` | `teller123` | View data + record payments |

## What is included

- Loan ledger with EMI schedule, outstanding balance, and payment allocation
- Delinquency tracking and arrears aging (1-30 / 31-60 / 61-90 / 90+)
- Role-based permissions
- Customer KYC fields: branch, guarantor, collateral
- Search/filter on loans, customers, and payments
- CSV export for loans, customers, payments, and audit log
- Audit trail of key staff actions
- Staff user management (admin)
- Pagination on loans, customers, and payments
- Printable loan statements
- Customer edit modal
- Password change for every staff account
- Admin database backup copies in `data/backups/`
- Global search across loans, customers, and payments
- Due-in-7-days and overdue installment alerts
- Customer profile pages
- Loan close + editable branch/officer/notes
- Alerts bell (pending, due soon, overdue)
- Rejection reasons on declined loans
- Late installment penalty estimate
- Printable payment receipts
- Portfolio bar charts on reports
- Mobile navigation menu

## Useful commands

```bash
npm start   # run the app
npm test    # loan math checks
```

## Environment

Copy `.env.example` to `.env`:

- `PORT`
- `SESSION_SECRET`
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` (seed only if admin does not exist)
- `NODE_ENV=production` for secure cookies
- `APP_URL` (public URL, e.g. `https://www.myprototype.work`)

## Deploy (always-on, no local PC)

See [DEPLOY.md](DEPLOY.md). Use **Render** (blueprint in repo), then point `www.myprototype.work` at the Render URL. Cloudflare Containers require Workers Paid.
