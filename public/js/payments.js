Brayn.pageState.payments = { page: 1 };

async function applyLoanSuggestion(loanId) {
  const hint = document.getElementById('suggestedDue');
  const amountInput = document.getElementById('paymentAmount');
  const nameInput = document.getElementById('customerName');
  if (!loanId) {
    if (hint) {
      hint.hidden = true;
      hint.textContent = '';
    }
    return;
  }

  try {
    const data = await Brayn.api(`/api/loans/${loanId}`);
    const loan = data.loan;
    if (nameInput && loan.customer_name) nameInput.value = loan.customer_name;
    const suggested = Number(data.nextDueAmount || 0);
    if (hint) {
      if (suggested > 0) {
        hint.hidden = false;
        const dueDate = data.nextInstallment?.due_date || '—';
        hint.innerHTML = `Suggested next due: <strong>${Brayn.formatKes(suggested)}</strong> (incl. penalty) · due ${Brayn.escapeHtml(dueDate)} · <button type="button" class="linkish" id="useSuggestedAmount">Use amount</button>`;
        document.getElementById('useSuggestedAmount')?.addEventListener('click', () => {
          if (amountInput) amountInput.value = String(suggested);
        });
      } else {
        hint.hidden = false;
        hint.textContent = 'No open installments on this loan.';
      }
    }
    if (amountInput && !amountInput.value && suggested > 0) {
      amountInput.value = String(suggested);
    }
  } catch (error) {
    if (hint) {
      hint.hidden = false;
      hint.textContent = error.message;
    }
  }
}

async function loadPaymentsPage(page = Brayn.pageState.payments.page) {
  const user = await Brayn.requireSession();
  if (!user) return;
  Brayn.mountShell('payments', user);

  const tbody = document.querySelector('#paymentTable tbody');
  const loanSelect = document.getElementById('loanId');
  if (!tbody) return;
  const q = document.getElementById('paymentSearch')?.value || '';
  const channel = document.getElementById('paymentChannel')?.value || '';
  const status = document.getElementById('paymentStatus')?.value || '';
  const date = document.getElementById('paymentDate')?.value || '';
  const params = new URLSearchParams({ page: String(page), pageSize: '15' });
  if (q) params.set('q', q);
  if (channel) params.set('channel', channel);
  if (status) params.set('status', status);
  if (date) params.set('date', date);

  try {
    const [listData, loanData, dashboard] = await Promise.all([
      Brayn.api(`/api/payments?${params.toString()}`),
      Brayn.api('/api/loans?pageSize=100'),
      Brayn.api('/api/dashboard'),
    ]);
    const list = Brayn.unwrapList(listData);
    const loans = Brayn.unwrapList(loanData).items;
    Brayn.pageState.payments.page = list.page;
    const rows = list.items;

    Brayn.setText('stat-today', Brayn.formatKes(dashboard.collectionsToday));
    Brayn.setText('stat-count', String(dashboard.paymentsTodayCount || 0));
    Brayn.setText('stat-pending', String(dashboard.pendingPayments || 0));
    Brayn.setText('stat-total', String(list.total));

    if (loanSelect) {
      const current = loanSelect.value;
      loanSelect.innerHTML =
        '<option value="">No linked loan</option>' +
        loans
          .filter((loan) => !['Rejected', 'Closed'].includes(loan.status))
          .map(
            (loan) =>
              `<option value="${loan.id}">LN-${String(loan.id).padStart(4, '0')} · ${Brayn.escapeHtml(loan.customer_name)} · out ${Brayn.formatKes(loan.outstanding || 0)}</option>`
          )
          .join('');
      if (current) loanSelect.value = current;
    }

    const canSettle = Brayn.can('admin', 'officer', 'teller');
    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="7">No payments match your filters. <a href="#paymentForm">Record a payment</a></td></tr>';
    } else {
      tbody.innerHTML = rows
        .map((payment) => {
          const actions = [];
          actions.push(
            `<a class="btn btn-secondary btn-compact" href="/receipt.html?id=${payment.id}">Receipt</a>`
          );
          if (canSettle && payment.status === 'Pending') {
            actions.push(
              `<button type="button" class="btn btn-primary btn-compact" data-settle="${payment.id}">Settle</button>`
            );
          }
          if (canSettle && payment.status === 'Pending') {
            actions.push(
              `<button type="button" class="btn btn-danger btn-compact" data-fail="${payment.id}">Mark failed</button>`
            );
          }
          return `
          <tr>
            <td><a href="/receipt.html?id=${payment.id}">PY-${String(payment.id).padStart(4, '0')}</a></td>
            <td>${payment.loan_id ? `<a href="/loan.html?id=${payment.loan_id}">LN-${String(payment.loan_id).padStart(4, '0')}</a>` : '—'}</td>
            <td>${
              payment.customer_id
                ? `<a href="/customer.html?id=${payment.customer_id}">${Brayn.escapeHtml(payment.customer_name)}</a>`
                : Brayn.escapeHtml(payment.customer_name)
            }</td>
            <td>${Brayn.escapeHtml(payment.channel)}</td>
            <td>${Brayn.formatKes(payment.amount)}</td>
            <td>${Brayn.statusBadge(payment.status)}</td>
            <td><div class="inline-actions">${actions.join('')}</div></td>
          </tr>`;
        })
        .join('');
    }

    Brayn.renderPager('paymentPager', list, (next) => loadPaymentsPage(next));
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="7">${Brayn.escapeHtml(error.message)}</td></tr>`;
  }
}

async function updatePaymentStatus(id, status) {
  await Brayn.api(`/api/payments/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  await loadPaymentsPage();
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('paymentForm');
  const message = document.getElementById('paymentMessage');
  const loanSelect = document.getElementById('loanId');

  loanSelect?.addEventListener('change', () => applyLoanSuggestion(loanSelect.value));

  if (form && message) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.className = 'success-text';
      message.textContent = '';
      const data = new FormData(form);
      const loanId = data.get('loanId');
      try {
        const result = await Brayn.api('/api/payments', {
          method: 'POST',
          body: JSON.stringify({
            loanId: loanId ? Number(loanId) : null,
            customerName: data.get('customerName'),
            channel: data.get('channel'),
            amount: Number(data.get('amount') || 0),
            reference: data.get('reference') || '',
            status: data.get('status') || 'Settled',
          }),
        });
        message.innerHTML = `Payment recorded. <a href="/receipt.html?id=${result.payment.id}">Open receipt PY-${String(result.payment.id).padStart(4, '0')}</a>`;
        form.reset();
        document.getElementById('suggestedDue').hidden = true;
        await loadPaymentsPage(1);
      } catch (error) {
        message.className = 'error-text';
        message.textContent = error.message;
      }
    });
  }

  document.getElementById('paymentFilters')?.addEventListener('submit', (event) => {
    event.preventDefault();
    loadPaymentsPage(1);
  });
  document.getElementById('paymentToday')?.addEventListener('click', () => {
    const input = document.getElementById('paymentDate');
    if (!input) return;
    input.value = new Date().toISOString().slice(0, 10);
    loadPaymentsPage(1);
  });
  document.getElementById('exportPayments')?.addEventListener('click', () =>
    Brayn.downloadExport('payments')
  );
  document.querySelector('#paymentTable')?.addEventListener('click', async (event) => {
    const settleBtn = event.target.closest('button[data-settle]');
    const failBtn = event.target.closest('button[data-fail]');
    const button = settleBtn || failBtn;
    if (!button) return;
    const id = button.dataset.settle || button.dataset.fail;
    const status = settleBtn ? 'Settled' : 'Failed';
    if (!confirm(`${status === 'Settled' ? 'Settle' : 'Mark failed'} payment PY-${String(id).padStart(4, '0')}?`)) {
      return;
    }
    button.disabled = true;
    try {
      await updatePaymentStatus(id, status);
    } catch (error) {
      alert(error.message);
      button.disabled = false;
    }
  });

  loadPaymentsPage(1).then(async () => {
    const params = new URLSearchParams(window.location.search);
    const loanId = params.get('loanId');
    const amount = params.get('amount');
    if (loanId && loanSelect) {
      loanSelect.value = String(loanId);
      await applyLoanSuggestion(loanId);
    }
    if (amount && document.getElementById('paymentAmount')) {
      document.getElementById('paymentAmount').value = amount;
    }
  });
});
