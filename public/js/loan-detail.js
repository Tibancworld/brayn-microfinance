let currentLoan = null;

async function setLoanStatus(status) {
  if (!currentLoan) return;
  const payload = { status };
  if (status === 'Rejected') {
    const reason = prompt('Rejection reason (required):');
    if (!reason || !reason.trim()) return;
    payload.reason = reason.trim();
  } else {
    const labels = { Approved: 'approve', Running: 'disburse' };
    if (!confirm(`Are you sure you want to ${labels[status] || 'update'} this loan?`)) return;
  }

  await Brayn.api(`/api/loans/${currentLoan.id}/status`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  await loadLoanDetail();
}

function renderWorkflow(loan) {
  const host = document.getElementById('loanWorkflow');
  if (!host) return;

  const canManage = Brayn.can('admin', 'officer');
  if (!canManage) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }

  const buttons = [];
  if (loan.status === 'Pending') {
    buttons.push(
      `<button type="button" class="btn btn-primary" data-status="Approved">Approve</button>`,
      `<button type="button" class="btn btn-danger" data-status="Rejected">Reject</button>`
    );
  }
  if (loan.status === 'Approved') {
    buttons.push(`<button type="button" class="btn btn-primary" data-status="Running">Disburse</button>`);
  }

  host.innerHTML = buttons.join('');
  host.hidden = buttons.length === 0;
}

async function loadLoanDetail() {
  const user = await Brayn.requireSession();
  if (!user) return;
  Brayn.mountShell('loans', user);

  const params = new URLSearchParams(window.location.search);
  const id = Number(params.get('id'));
  if (!id) {
    Brayn.setText('loanSubtitle', 'Missing loan id.');
    return;
  }

  try {
    const data = await Brayn.api(`/api/loans/${id}`);
    const loan = data.loan;
    currentLoan = loan;
    Brayn.setText('loanTitle', `LN-${String(loan.id).padStart(4, '0')} · ${loan.customer_name}`);
    Brayn.setText(
      'loanSubtitle',
      `${loan.product} · ${loan.status} · Branch ${loan.branch || 'Main'} · Officer ${loan.officer || '—'}`
    );
    const statementLink = document.getElementById('statementLink');
    if (statementLink) statementLink.href = `/statement?id=${loan.id}`;
    if (loan.customer_id) {
      const subtitle = document.getElementById('loanSubtitle');
      if (subtitle) {
        subtitle.innerHTML = `${Brayn.escapeHtml(loan.product)} · ${Brayn.statusBadge(loan.status)} · <a href="/customer?id=${loan.customer_id}">${Brayn.escapeHtml(loan.customer_name)}</a> · Branch ${Brayn.escapeHtml(loan.branch || 'Main')}`;
      }
    }

    Brayn.setText('stat-principal', Brayn.formatKes(loan.amount));
    Brayn.setText('stat-outstanding', Brayn.formatKes(loan.outstanding));
    Brayn.setText('stat-paid', Brayn.formatKes(loan.paid_total));
    Brayn.setText('stat-dpd', String(loan.days_past_due || 0));
    Brayn.setText(
      'loanMeta',
      `EMI ${Brayn.formatKes(loan.emi)} · Total payable ${Brayn.formatKes(loan.total_payable)}`
    );

    const canManage = Brayn.can('admin', 'officer');
    const canPay = Brayn.can('admin', 'officer', 'teller');
    const editPanel = document.getElementById('loanEditPanel');
    const payPanel = document.getElementById('quickPayPanel');
    const closeBtn = document.getElementById('closeLoanBtn');
    if (editPanel) editPanel.hidden = !canManage;
    if (payPanel) {
      payPanel.hidden = !canPay || ['Pending', 'Rejected', 'Closed'].includes(loan.status);
    }
    const payLoanLink = document.getElementById('payLoanLink');
    if (payLoanLink) {
      const canShowPay = canPay && !['Pending', 'Rejected', 'Closed'].includes(loan.status);
      payLoanLink.hidden = !canShowPay;
      if (canShowPay) {
        const suggested = Number(data.nextDueAmount || 0);
        payLoanLink.href = suggested
          ? `/payments?loanId=${loan.id}&amount=${encodeURIComponent(suggested)}`
          : `/payments?loanId=${loan.id}`;
      }
    }
    if (closeBtn) {
      closeBtn.hidden =
        !canManage || ['Closed', 'Rejected', 'Pending'].includes(loan.status);
    }
    renderWorkflow(loan);

    const form = document.getElementById('loanEditForm');
    if (form && canManage) {
      form.branch.value = loan.branch || 'Main';
      form.officer.value = loan.officer || '';
      form.notes.value = loan.notes || '';
    }

    const scheduleBody = document.querySelector('#scheduleTable tbody');
    if (loan.status === 'Rejected' && loan.rejection_reason) {
      Brayn.setText('loanMeta', `Rejected: ${loan.rejection_reason}`);
    }

    scheduleBody.innerHTML = (data.installments || [])
      .map(
        (row) => `
        <tr>
          <td>${row.installment_no}</td>
          <td>${Brayn.escapeHtml(row.due_date)}</td>
          <td>${Brayn.formatKes(row.principal_due)}</td>
          <td>${Brayn.formatKes(row.interest_due)}</td>
          <td>${Brayn.formatKes(row.amount_due)}</td>
          <td>${Brayn.formatKes(row.amount_paid)}</td>
          <td>${Brayn.formatKes(row.penalty || 0)}</td>
          <td>${Brayn.statusBadge(row.status)}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="8">No schedule yet. Approve the loan to generate installments.</td></tr>';

    const paymentsBody = document.querySelector('#loanPaymentsTable tbody');
    paymentsBody.innerHTML = (data.payments || [])
      .map(
        (payment) => `
        <tr>
          <td><a href="/receipt?id=${payment.id}">PY-${String(payment.id).padStart(4, '0')}</a></td>
          <td>${Brayn.escapeHtml(payment.channel)}</td>
          <td>${Brayn.formatKes(payment.amount)}</td>
          <td>${Brayn.escapeHtml(payment.reference || '—')}</td>
          <td>${Brayn.statusBadge(payment.status)}</td>
          <td>${Brayn.escapeHtml(String(payment.created_at || '').slice(0, 10))}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="6">No payments recorded.</td></tr>';
  } catch (error) {
    Brayn.setText('loanSubtitle', error.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loanWorkflow')?.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-status]');
    if (!button) return;
    button.disabled = true;
    try {
      await setLoanStatus(button.dataset.status);
    } catch (error) {
      alert(error.message);
      button.disabled = false;
    }
  });

  document.getElementById('loanEditForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentLoan) return;
    const message = document.getElementById('loanEditMessage');
    const data = new FormData(event.target);
    message.className = 'success-text';
    message.textContent = '';
    try {
      await Brayn.api(`/api/loans/${currentLoan.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          branch: data.get('branch'),
          officer: data.get('officer'),
          notes: data.get('notes'),
        }),
      });
      message.textContent = 'Loan details saved.';
      await loadLoanDetail();
    } catch (error) {
      message.className = 'error-text';
      message.textContent = error.message;
    }
  });

  document.getElementById('quickPayForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentLoan) return;
    const message = document.getElementById('quickPayMessage');
    const data = new FormData(event.target);
    message.className = 'success-text';
    message.textContent = '';
    try {
      const result = await Brayn.api('/api/payments', {
        method: 'POST',
        body: JSON.stringify({
          loanId: currentLoan.id,
          amount: Number(data.get('amount') || 0),
          channel: data.get('channel'),
          reference: data.get('reference') || '',
          status: 'Settled',
        }),
      });
      message.innerHTML = `Payment posted. <a href="/receipt?id=${result.payment.id}">Open receipt PY-${String(result.payment.id).padStart(4, '0')}</a>`;
      event.target.reset();
      await loadLoanDetail();
    } catch (error) {
      message.className = 'error-text';
      message.textContent = error.message;
    }
  });

  document.getElementById('closeLoanBtn')?.addEventListener('click', async () => {
    if (!currentLoan) return;
    const outstanding = Number(currentLoan.outstanding || 0);
    const ok =
      outstanding > 1
        ? confirm(`Outstanding is ${Brayn.formatKes(outstanding)}. Close this loan anyway?`)
        : confirm('Close this loan?');
    if (!ok) return;
    try {
      await Brayn.api(`/api/loans/${currentLoan.id}/close`, {
        method: 'POST',
        body: JSON.stringify({ force: outstanding > 1 }),
      });
      await loadLoanDetail();
    } catch (error) {
      alert(error.message);
    }
  });

  loadLoanDetail();
});
