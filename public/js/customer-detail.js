async function loadCustomerDetail() {
  const user = await Brayn.requireSession();
  if (!user) return;
  Brayn.mountShell('customers', user);

  const id = Number(new URLSearchParams(window.location.search).get('id'));
  if (!id) {
    Brayn.setText('customerSubtitle', 'Missing customer id.');
    return;
  }

  try {
    const data = await Brayn.api(`/api/customers/${id}?detail=1`);
    const customer = data.customer;
    const loans = data.loans || [];
    const payments = data.payments || [];
    const outstanding = loans.reduce((sum, loan) => sum + Number(loan.outstanding || 0), 0);
    const paid = payments
      .filter((p) => p.status === 'Settled')
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);

    Brayn.setText('customerTitle', customer.name);
    Brayn.setText(
      'customerSubtitle',
      `${customer.branch || 'Main'} · ${customer.phone || 'No phone'} · ${customer.email || 'No email'}`
    );

    const activeLoan = loans.find((loan) => !['Rejected', 'Closed'].includes(loan.status));
    const payLink = document.getElementById('customerPayLink');
    if (payLink) {
      payLink.href = activeLoan
        ? `/payments.html?loanId=${activeLoan.id}`
        : '/payments.html';
    }
    Brayn.setText('c-loans', String(loans.length));
    Brayn.setText('c-outstanding', Brayn.formatKes(outstanding));
    Brayn.setText('c-paid', Brayn.formatKes(paid));
    Brayn.setText('c-status', customer.status || '—');

    document.getElementById('profileList').innerHTML = `
      <div class="alert-item"><strong>National ID</strong><span>${Brayn.escapeHtml(customer.national_id || '—')}</span></div>
      <div class="alert-item"><strong>Product interest</strong><span>${Brayn.escapeHtml(customer.product || '—')}</span></div>
      <div class="alert-item"><strong>Guarantor</strong><span>${Brayn.escapeHtml(customer.guarantor_name || '—')} · ${Brayn.escapeHtml(customer.guarantor_phone || '—')}</span></div>
      <div class="alert-item"><strong>Collateral</strong><span>${Brayn.escapeHtml(customer.collateral || '—')}</span></div>
    `;

    document.querySelector('#customerLoansTable tbody').innerHTML = loans.length
      ? loans
          .map(
            (loan) => `
          <tr>
            <td><a href="/loan.html?id=${loan.id}">LN-${String(loan.id).padStart(4, '0')}</a></td>
            <td>${Brayn.escapeHtml(loan.product)}</td>
            <td>${Brayn.formatKes(loan.outstanding || 0)}</td>
            <td>${Brayn.statusBadge(loan.status)}</td>
          </tr>`
          )
          .join('')
      : '<tr><td colspan="4">No loans for this customer.</td></tr>';

    document.querySelector('#customerPaymentsTable tbody').innerHTML = payments.length
      ? payments
          .map(
            (payment) => `
          <tr>
            <td><a href="/receipt.html?id=${payment.id}">PY-${String(payment.id).padStart(4, '0')}</a></td>
            <td>${payment.loan_id ? `<a href="/loan.html?id=${payment.loan_id}">LN-${String(payment.loan_id).padStart(4, '0')}</a>` : '—'}</td>
            <td>${Brayn.escapeHtml(payment.channel)}</td>
            <td>${Brayn.formatKes(payment.amount)}</td>
            <td>${Brayn.statusBadge(payment.status)}</td>
          </tr>`
          )
          .join('')
      : '<tr><td colspan="5">No payments yet.</td></tr>';
  } catch (error) {
    Brayn.setText('customerSubtitle', error.message);
  }
}

document.addEventListener('DOMContentLoaded', loadCustomerDetail);
