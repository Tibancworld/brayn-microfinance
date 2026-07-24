async function bootDashboard() {
  const user = await Brayn.requireSession();
  if (!user) return;
  Brayn.mountShell('dashboard', user);

  const loanPanel = document.getElementById('loanFormPanel');
  if (loanPanel && !Brayn.can('admin', 'officer')) {
    loanPanel.hidden = true;
  }

  try {
    const data = await Brayn.api('/api/dashboard');
    Brayn.setText('portfolio-value', Brayn.formatKes(data.portfolioValue));
    Brayn.setText('disbursed-value', Brayn.formatKes(data.disbursedValue));
    Brayn.setText('repayment-rate', `${Number(data.repaymentRate || 0).toFixed(1)}%`);
    Brayn.setText('delinquent-count', String(data.delinquentCount || 0));
    Brayn.setText(
      'dashboard-note',
      `${data.loanCount || 0} active loans · overdue ${Brayn.formatKes(data.overdueAmount || 0)} · signed in as ${user.role}`
    );

    const dueSoon = document.getElementById('dueSoonList');
    if (dueSoon) {
      const rows = data.dueSoon || [];
      dueSoon.innerHTML = rows.length
        ? rows
            .map(
              (row) => `
            <a class="alert-item" href="/loan.html?id=${row.loan_id}">
              <strong>${Brayn.escapeHtml(row.customer_name)}</strong>
              <span>${Brayn.formatKes(row.amount_due - row.amount_paid)}</span>
              <span>Due ${Brayn.escapeHtml(row.due_date)} · ${Brayn.escapeHtml(row.product)}</span>
            </a>`
            )
            .join('')
        : '<div class="alert-item"><strong>All clear</strong><span>No installments due in the next 7 days.</span></div>';
    }

    const overdue = document.getElementById('overdueList');
    if (overdue) {
      const rows = data.overdueInstallments || [];
      overdue.innerHTML = rows.length
        ? rows
            .map(
              (row) => `
            <a class="alert-item overdue" href="/loan.html?id=${row.loan_id}">
              <strong>${Brayn.escapeHtml(row.customer_name)}</strong>
              <span>${Brayn.formatKes(row.amount_due - row.amount_paid)}</span>
              <span>Was due ${Brayn.escapeHtml(row.due_date)} · DPD ${Number(row.days_past_due || 0)}</span>
            </a>`
            )
            .join('')
        : '<div class="alert-item"><strong>No overdue items</strong><span>Collections are current.</span></div>';
    }

    const loansBody = document.querySelector('#recentLoansTable tbody');
    if (loansBody) {
      const loans = data.recentLoans || [];
      loansBody.innerHTML = loans.length
        ? loans
            .map(
              (loan) => `
            <tr>
              <td><a href="/loan.html?id=${loan.id}">LN-${String(loan.id).padStart(4, '0')}</a></td>
              <td>${Brayn.escapeHtml(loan.customer_name)}</td>
              <td>${Brayn.formatKes(loan.outstanding || 0)}</td>
              <td>${Brayn.statusBadge(loan.status)}</td>
            </tr>`
            )
            .join('')
        : '<tr><td colspan="4">No recent loans.</td></tr>';
    }

    const paymentsBody = document.querySelector('#recentPaymentsTable tbody');
    if (paymentsBody) {
      const payments = data.recentPayments || [];
      paymentsBody.innerHTML = payments.length
        ? payments
            .map(
              (payment) => `
            <tr>
              <td><a href="/receipt.html?id=${payment.id}">PY-${String(payment.id).padStart(4, '0')}</a></td>
              <td>${Brayn.escapeHtml(payment.customer_name)}</td>
              <td>${Brayn.formatKes(payment.amount)}</td>
              <td>${Brayn.escapeHtml(payment.channel)}</td>
            </tr>`
            )
            .join('')
        : '<tr><td colspan="4">No recent payments.</td></tr>';
    }
  } catch (error) {
    console.error(error);
    Brayn.setText('dashboard-note', error.message);
  }
}

function wireLoanForm() {
  const form = document.getElementById('loanForm');
  const message = document.getElementById('formMessage');
  if (!form || !message) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.className = 'success-text';
    message.textContent = '';
    const data = new FormData(form);

    try {
      const result = await Brayn.api('/api/loans', {
        method: 'POST',
        body: JSON.stringify({
          customerName: data.get('name'),
          product: data.get('product'),
          amount: Number(data.get('amount') || 0),
          months: Number(data.get('period') || 0),
          interestRate: Number(data.get('rate') || 18),
          notes: data.get('notes') || '',
          phone: data.get('phone') || '',
          email: data.get('email') || '',
          branch: data.get('branch') || 'Main',
        }),
      });

      message.textContent = `Saved. Loan LN-${String(result.loan.id).padStart(4, '0')} is pending review.`;
      form.reset();
      bootDashboard();
    } catch (error) {
      message.className = 'error-text';
      message.textContent = error.message;
    }
  });
}

function wireEmiForm() {
  const emiForm = document.getElementById('emiForm');
  const emiResult = document.getElementById('emiResult');
  if (!emiForm || !emiResult) return;

  emiForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const principal = Number(document.getElementById('principal').value || 0);
    const annualRate = Number(document.getElementById('rate').value || 0);
    const months = Number(document.getElementById('months').value || 0);

    try {
      const data = await Brayn.api('/api/tools/emi', {
        method: 'POST',
        body: JSON.stringify({ amount: principal, months, interestRate: annualRate }),
      });
      emiResult.className = 'success-text';
      emiResult.textContent = `EMI ${Brayn.formatKes(data.emi)} / month · total payable ${Brayn.formatKes(data.totalPayable)} · interest ${Brayn.formatKes(data.totalInterest)}`;
    } catch (error) {
      emiResult.className = 'error-text';
      emiResult.textContent = error.message;
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bootDashboard();
  wireLoanForm();
  wireEmiForm();
});
