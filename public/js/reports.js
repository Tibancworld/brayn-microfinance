async function loadReportsPage() {
  const user = await Brayn.requireSession();
  if (!user) return;
  Brayn.mountShell('reports', user);

  const summary = document.getElementById('summaryCards');
  const channels = document.getElementById('channelCards');
  const statuses = document.getElementById('statusCards');
  const aging = document.getElementById('agingCards');
  const branches = document.getElementById('branchCards');
  if (!summary || !channels || !statuses || !aging || !branches) return;

  try {
    const data = await Brayn.api('/api/reports');
    const stats = data.stats || {};

    Brayn.setText('stat-portfolio', Brayn.formatKes(stats.portfolioValue));
    Brayn.setText('stat-repayment', `${Number(stats.repaymentRate || 0).toFixed(1)}%`);
    Brayn.setText('stat-delinquent', String(stats.delinquentCount || 0));
    Brayn.setText('stat-overdue', Brayn.formatKes(stats.overdueAmount || 0));

    const maxOutstanding = Math.max(
      1,
      ...(data.summary || []).map((item) => Number(item.outstanding || 0))
    );
    summary.innerHTML = (data.summary || []).length
      ? `<div class="bar-list">${data.summary
          .map((item) => {
            const value = Number(item.outstanding || 0);
            const width = Math.max(4, Math.round((value / maxOutstanding) * 100));
            return `
            <div class="bar-row">
              <header>
                <span>${Brayn.escapeHtml(item.product)} · ${Number(item.count)} loans</span>
                <strong>${Brayn.formatKes(value)}</strong>
              </header>
              <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
            </div>`;
          })
          .join('')}</div>`
      : '<div class="report-item"><strong>No products yet</strong><span>Submit a loan to populate this.</span></div>';

    channels.innerHTML = (data.payments || []).length
      ? data.payments
          .map(
            (item) => `
          <div class="report-item">
            <strong>${Brayn.escapeHtml(item.channel)}</strong>
            <span>${Number(item.count)} payments · ${Brayn.formatKes(item.total)}</span>
          </div>`
          )
          .join('')
      : '<div class="report-item"><strong>No payments yet</strong><span>Record a settlement first.</span></div>';

    statuses.innerHTML = (data.statusBreakdown || []).length
      ? data.statusBreakdown
          .map(
            (item) => `
          <div class="report-item">
            <strong>${Brayn.escapeHtml(item.status)}</strong>
            <span>${Number(item.count)} loans · ${Brayn.formatKes(item.outstanding)}</span>
          </div>`
          )
          .join('')
      : '<div class="report-item"><strong>No status data</strong><span>Loans will appear here.</span></div>';

    aging.innerHTML = (stats.aging || []).length
      ? stats.aging
          .map(
            (item) => `
          <div class="report-item">
            <strong>${Brayn.escapeHtml(item.bucket)}</strong>
            <span>${Number(item.count)} loans · ${Brayn.formatKes(item.total)}</span>
          </div>`
          )
          .join('')
      : '<div class="report-item"><strong>No aging data</strong><span>Active loans will appear here.</span></div>';

    branches.innerHTML = (data.branches || []).length
      ? data.branches
          .map(
            (item) => `
          <div class="report-item">
            <strong>${Brayn.escapeHtml(item.branch || 'Main')}</strong>
            <span>${Number(item.count)} loans · outstanding ${Brayn.formatKes(item.outstanding)}</span>
          </div>`
          )
          .join('')
      : '<div class="report-item"><strong>No branch data</strong><span>Loans will appear here.</span></div>';
  } catch (error) {
    summary.innerHTML = `<div class="report-item"><strong>Unable to load</strong><span>${Brayn.escapeHtml(error.message)}</span></div>`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-export]').forEach((button) => {
    button.addEventListener('click', () => Brayn.downloadExport(button.dataset.export));
  });
  loadReportsPage();
});
