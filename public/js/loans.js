Brayn.pageState.loans = { page: 1 };

async function loadLoansPage(page = Brayn.pageState.loans.page) {
  const user = await Brayn.requireSession();
  if (!user) return;
  Brayn.mountShell('loans', user);

  const canManage = Brayn.can('admin', 'officer');
  const actionsNote = document.getElementById('actionsNote');
  const newLoanLink = document.getElementById('newLoanLink');
  if (newLoanLink) newLoanLink.hidden = !canManage;
  if (actionsNote) {
    actionsNote.textContent = canManage
      ? 'Approve applications to generate repayment schedules.'
      : 'View and collect — ask an officer or admin to approve loans.';
  }

  const tbody = document.querySelector('#loanTable tbody');
  if (!tbody) return;

  const q = document.getElementById('loanSearch')?.value || '';
  const status = document.getElementById('loanStatus')?.value || '';
  const branch = document.getElementById('loanBranch')?.value || '';
  const params = new URLSearchParams({ page: String(page), pageSize: '15' });
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (branch) params.set('branch', branch);

  try {
    const [listData, dashboard] = await Promise.all([
      Brayn.api(`/api/loans?${params.toString()}`),
      Brayn.api('/api/dashboard'),
    ]);
    const list = Brayn.unwrapList(listData);
    Brayn.pageState.loans.page = list.page;
    const loans = list.items;

    Brayn.setText('stat-pending', String(dashboard.pendingLoans || 0));
    Brayn.setText('stat-disbursed', Brayn.formatKes(dashboard.portfolioValue));
    Brayn.setText('stat-collections', String(dashboard.loanCount || 0));
    Brayn.setText('stat-delinquent', String(dashboard.delinquentCount || 0));

    if (!loans.length) {
      tbody.innerHTML = '<tr><td colspan="8">No loans match your filters.</td></tr>';
    } else {
      tbody.innerHTML = loans
        .map((loan) => {
          const id = Brayn.escapeHtml(loan.id);
          let actions = `
            <a class="btn btn-secondary btn-compact" href="/loan?id=${id}">Ledger</a>
            <a class="btn btn-secondary btn-compact" href="/statement?id=${id}">Statement</a>`;
          if (canManage && loan.status === 'Pending') {
            actions += `
              <button class="btn btn-secondary btn-compact" data-action="Approved" data-id="${id}">Approve</button>
              <button class="btn btn-danger btn-compact" data-action="Rejected" data-id="${id}">Reject</button>`;
          } else if (canManage && loan.status === 'Approved') {
            actions += `<button class="btn btn-secondary btn-compact" data-action="Running" data-id="${id}">Disburse</button>`;
          } else if (
            canManage &&
            ['Running', 'Delinquent', 'Defaulted', 'Approved'].includes(loan.status)
          ) {
            actions += `<button class="btn btn-danger btn-compact" data-close="${id}" data-out="${Number(loan.outstanding || 0)}">Close</button>`;
          }

          return `
            <tr>
              <td><a href="/loan?id=${id}">LN-${String(loan.id).padStart(4, '0')}</a></td>
              <td>${
                loan.customer_id
                  ? `<a href="/customer?id=${loan.customer_id}">${Brayn.escapeHtml(loan.customer_name)}</a>`
                  : Brayn.escapeHtml(loan.customer_name)
              }</td>
              <td>${Brayn.escapeHtml(loan.product)}</td>
              <td>${Brayn.formatKes(loan.amount)}</td>
              <td>${Brayn.formatKes(loan.outstanding || 0)}</td>
              <td>${Brayn.escapeHtml(loan.branch || 'Main')}</td>
              <td>${Brayn.statusBadge(loan.status)}</td>
              <td><div class="inline-actions">${actions}</div></td>
            </tr>`;
        })
        .join('');
    }

    Brayn.renderPager('loanPager', list, (next) => loadLoansPage(next));
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="8">${Brayn.escapeHtml(error.message)}</td></tr>`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const tbody = document.querySelector('#loanTable tbody');
  if (tbody) {
    tbody.addEventListener('click', async (event) => {
      const closeBtn = event.target.closest('button[data-close]');
      if (closeBtn) {
        const outstanding = Number(closeBtn.dataset.out || 0);
        const ok =
          outstanding > 1
            ? confirm(`Outstanding is ${Brayn.formatKes(outstanding)}. Close this loan anyway?`)
            : confirm('Close this loan?');
        if (!ok) return;
        closeBtn.disabled = true;
        try {
          await Brayn.api(`/api/loans/${closeBtn.dataset.close}/close`, {
            method: 'POST',
            body: JSON.stringify({ force: outstanding > 1 }),
          });
          await loadLoansPage();
        } catch (error) {
          alert(error.message);
          closeBtn.disabled = false;
        }
        return;
      }

      const button = event.target.closest('button[data-action]');
      if (!button) return;
      button.disabled = true;
      try {
        const payload = { status: button.dataset.action };
        if (button.dataset.action === 'Rejected') {
          const reason = prompt('Rejection reason (required):');
          if (!reason || !reason.trim()) {
            button.disabled = false;
            return;
          }
          payload.reason = reason.trim();
        }
        await Brayn.api(`/api/loans/${button.dataset.id}/status`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        await loadLoansPage();
      } catch (error) {
        alert(error.message);
        button.disabled = false;
      }
    });
  }

  document.getElementById('loanFilters')?.addEventListener('submit', (event) => {
    event.preventDefault();
    loadLoansPage(1);
  });
  document.getElementById('exportLoans')?.addEventListener('click', () => Brayn.downloadExport('loans'));

  const presetStatus = new URLSearchParams(window.location.search).get('status');
  if (presetStatus && document.getElementById('loanStatus')) {
    document.getElementById('loanStatus').value = presetStatus;
  }
  loadLoansPage(1);
});
