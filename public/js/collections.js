Brayn.pageState.collections = { page: 1 };

async function loadCollectionsPage(page = Brayn.pageState.collections.page) {
  const user = await Brayn.requireSession();
  if (!user) return;
  Brayn.mountShell('collections', user);

  const tbody = document.querySelector('#collectionTable tbody');
  if (!tbody) return;

  const type = document.getElementById('collectionType')?.value || 'overdue';
  const q = document.getElementById('collectionSearch')?.value || '';
  const branch = document.getElementById('collectionBranch')?.value || '';
  const params = new URLSearchParams({ page: String(page), pageSize: '20', type });
  if (q) params.set('q', q);
  if (branch) params.set('branch', branch);

  try {
    const listData = await Brayn.api(`/api/collections?${params.toString()}`);
    const list = Brayn.unwrapList(listData);
    Brayn.pageState.collections.page = list.page;
    const rows = list.items;

    const owed = rows.reduce((sum, row) => sum + Number(row.amount_owed || 0), 0);
    const penalty = rows.reduce((sum, row) => sum + Number(row.penalty || 0), 0);
    Brayn.setText('stat-queue', String(list.total));
    Brayn.setText('stat-owed', Brayn.formatKes(owed));
    Brayn.setText('stat-penalty', Brayn.formatKes(penalty));
    Brayn.setText('stat-type', type === 'dueSoon' ? 'Due soon' : 'Overdue');

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8">No ${
        type === 'dueSoon' ? 'upcoming' : 'overdue'
      } installments in this queue.</td></tr>`;
    } else {
      tbody.innerHTML = rows
        .map(
          (row) => `
          <tr>
            <td>${Brayn.escapeHtml(row.due_date)}</td>
            <td>${
              row.customer_id
                ? `<a href="/customer.html?id=${row.customer_id}">${Brayn.escapeHtml(row.customer_name)}</a>`
                : Brayn.escapeHtml(row.customer_name)
            }</td>
            <td><a href="/loan.html?id=${row.loan_id}">LN-${String(row.loan_id).padStart(4, '0')}</a></td>
            <td>#${row.installment_no}</td>
            <td>${Brayn.formatKes(row.amount_owed)}</td>
            <td>${Brayn.formatKes(row.penalty || 0)}</td>
            <td>${Number(row.days_past_due || 0)}</td>
            <td>
              <div class="inline-actions">
                <a class="btn btn-primary btn-compact" href="/payments.html?loanId=${row.loan_id}&amount=${encodeURIComponent(row.amount_owed)}">Record payment</a>
                <a class="btn btn-secondary btn-compact" href="/loan.html?id=${row.loan_id}">Ledger</a>
              </div>
            </td>
          </tr>`
        )
        .join('');
    }

    Brayn.renderPager('collectionPager', list, (next) => loadCollectionsPage(next));
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="8">${Brayn.escapeHtml(error.message)}</td></tr>`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const preset = new URLSearchParams(window.location.search).get('type');
  if (preset && document.getElementById('collectionType')) {
    document.getElementById('collectionType').value = preset === 'dueSoon' ? 'dueSoon' : 'overdue';
  }

  document.getElementById('collectionFilters')?.addEventListener('submit', (event) => {
    event.preventDefault();
    loadCollectionsPage(1);
  });
  document.getElementById('exportCollections')?.addEventListener('click', () =>
    Brayn.downloadExport('collections')
  );
  loadCollectionsPage(1);
});
