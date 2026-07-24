async function loadStatement() {
  const user = await Brayn.requireSession();
  if (!user) return;
  Brayn.mountShell('loans', user);

  const id = Number(new URLSearchParams(window.location.search).get('id'));
  const back = document.getElementById('backLink');
  if (back && id) back.href = `/loan?id=${id}`;
  if (!id) {
    Brayn.setText('stmtTitle', 'Missing loan id');
    return;
  }

  try {
    const data = await Brayn.api(`/api/loans/${id}`);
    const loan = data.loan;
    Brayn.setText('stmtTitle', `LN-${String(loan.id).padStart(4, '0')}`);
    Brayn.setText('stmtDate', `Generated ${new Date().toLocaleString('en-KE')}`);
    Brayn.setText('stmtPrincipal', Brayn.formatKes(loan.amount));
    Brayn.setText('stmtPaid', Brayn.formatKes(loan.paid_total));
    Brayn.setText('stmtOutstanding', Brayn.formatKes(loan.outstanding));
    Brayn.setText('stmtStatus', loan.status);
    Brayn.setText(
      'stmtMeta',
      [
        loan.customer_name,
        loan.product,
        `Branch ${loan.branch || 'Main'}`,
        `Officer ${loan.officer || '—'}`,
        loan.customer_phone ? `Phone ${loan.customer_phone}` : null,
        loan.national_id ? `ID ${loan.national_id}` : null,
        `EMI ${Brayn.formatKes(loan.emi)}`,
      ]
        .filter(Boolean)
        .join(' · ')
    );

    document.querySelector('#stmtSchedule tbody').innerHTML = (data.installments || [])
      .map(
        (row) => `
        <tr>
          <td>${row.installment_no}</td>
          <td>${Brayn.escapeHtml(row.due_date)}</td>
          <td>${Brayn.formatKes(row.amount_due)}</td>
          <td>${Brayn.formatKes(row.amount_paid)}</td>
          <td>${Brayn.formatKes(row.penalty || 0)}</td>
          <td>${Brayn.statusBadge(row.status)}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="6">No schedule available.</td></tr>';

    document.querySelector('#stmtPayments tbody').innerHTML = (data.payments || [])
      .map(
        (payment) => `
        <tr>
          <td>PY-${String(payment.id).padStart(4, '0')}</td>
          <td>${Brayn.escapeHtml(String(payment.created_at || '').slice(0, 10))}</td>
          <td>${Brayn.escapeHtml(payment.channel)}</td>
          <td>${Brayn.escapeHtml(payment.reference || '—')}</td>
          <td>${Brayn.formatKes(payment.amount)}</td>
          <td>${Brayn.statusBadge(payment.status)}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="6">No payments recorded.</td></tr>';
  } catch (error) {
    Brayn.setText('stmtTitle', error.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('printBtn')?.addEventListener('click', () => window.print());
  loadStatement();
});
