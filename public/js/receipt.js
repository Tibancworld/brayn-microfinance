async function loadReceipt() {
  const user = await Brayn.requireSession();
  if (!user) return;
  Brayn.mountShell('payments', user);

  const id = Number(new URLSearchParams(window.location.search).get('id'));
  if (!id) {
    Brayn.setText('receiptTitle', 'Missing payment id');
    return;
  }

  try {
    const payment = await Brayn.api(`/api/payments/${id}`);
    Brayn.setText('receiptTitle', `Receipt PY-${String(payment.id).padStart(4, '0')}`);
    Brayn.setText('receiptDate', `Issued ${new Date().toLocaleString('en-KE')}`);

    let balanceLine = '';
    if (payment.loan_id) {
      balanceLine = `
        <div class="alert-item"><strong>Loan balance after posting</strong><span>${Brayn.formatKes(
          payment.loan_outstanding
        )}</span></div>
        <div class="alert-item"><strong>Loan paid to date</strong><span>${Brayn.formatKes(
          payment.loan_paid_total
        )}</span></div>`;
    }

    document.getElementById('receiptDetails').innerHTML = `
      <div class="alert-item"><strong>Customer</strong><span>${Brayn.escapeHtml(payment.customer_name)}</span></div>
      <div class="alert-item"><strong>Amount received</strong><span>${Brayn.formatKes(payment.amount)}</span></div>
      <div class="alert-item"><strong>Channel</strong><span>${Brayn.escapeHtml(payment.channel)}</span></div>
      <div class="alert-item"><strong>Reference</strong><span>${Brayn.escapeHtml(payment.reference || '—')}</span></div>
      <div class="alert-item"><strong>Status</strong><span>${Brayn.escapeHtml(payment.status)}</span></div>
      <div class="alert-item"><strong>Loan</strong><span>${
        payment.loan_id
          ? `LN-${String(payment.loan_id).padStart(4, '0')} · ${Brayn.escapeHtml(payment.loan_product || '')}`
          : 'Not linked'
      }</span></div>
      <div class="alert-item"><strong>Branch / officer</strong><span>${Brayn.escapeHtml(
        payment.loan_branch || '—'
      )} · ${Brayn.escapeHtml(payment.loan_officer || '—')}</span></div>
      ${balanceLine}
      <div class="alert-item"><strong>Posted</strong><span>${Brayn.escapeHtml(
        String(payment.created_at || '').slice(0, 19)
      )}</span></div>
    `;
  } catch (error) {
    Brayn.setText('receiptTitle', error.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('printBtn')?.addEventListener('click', () => window.print());
  loadReceipt();
});
