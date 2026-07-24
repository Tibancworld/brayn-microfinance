Brayn.pageState.customers = { page: 1 };

async function loadCustomersPage(page = Brayn.pageState.customers.page) {
  const user = await Brayn.requireSession();
  if (!user) return;
  Brayn.mountShell('customers', user);

  const canManage = Brayn.can('admin', 'officer');
  const formPanel = document.getElementById('customerFormPanel');
  if (formPanel) formPanel.hidden = !canManage;

  const tbody = document.querySelector('#customerTable tbody');
  if (!tbody) return;
  const q = document.getElementById('customerSearch')?.value || '';
  const params = new URLSearchParams({ page: String(page), pageSize: '15' });
  if (q) params.set('q', q);

  try {
    const [listData, dashboard] = await Promise.all([
      Brayn.api(`/api/customers?${params.toString()}`),
      Brayn.api('/api/dashboard'),
    ]);
    const list = Brayn.unwrapList(listData);
    Brayn.pageState.customers.page = list.page;
    const rows = list.items;

    const loanTotal = rows.reduce((sum, row) => sum + Number(row.loan_count || 0), 0);
    Brayn.setText('stat-active', String(dashboard.activeCustomers || 0));
    Brayn.setText('stat-total', String(dashboard.customerCount || 0));
    Brayn.setText('stat-new', String(rows.filter((c) => c.status === 'New').length));
    Brayn.setText('stat-loans', String(loanTotal));

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8">No customers found.</td></tr>';
    } else {
      tbody.innerHTML = rows
        .map(
          (customer) => `
          <tr>
            <td><a href="/customer?id=${customer.id}">${Brayn.escapeHtml(customer.name)}</a></td>
            <td>${Brayn.escapeHtml(customer.phone || '—')}</td>
            <td>${Brayn.escapeHtml(customer.branch || 'Main')}</td>
            <td>${Brayn.escapeHtml(customer.guarantor_name || '—')}</td>
            <td>${Brayn.escapeHtml(customer.collateral || '—')}</td>
            <td>${Brayn.statusBadge(customer.status)}</td>
            <td>${Number(customer.loan_count || 0)}</td>
            <td>
              <div class="inline-actions">
                <a class="btn btn-secondary btn-compact" href="/customer?id=${customer.id}">View</a>
                ${
                  canManage
                    ? `<button class="btn btn-secondary btn-compact" data-edit="${customer.id}">Edit</button>`
                    : ''
                }
              </div>
            </td>
          </tr>`
        )
        .join('');
    }

    Brayn.renderPager('customerPager', list, (next) => loadCustomersPage(next));
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="8">${Brayn.escapeHtml(error.message)}</td></tr>`;
  }
}

async function openEditCustomer(id) {
  const modal = document.getElementById('editModal');
  const form = document.getElementById('editCustomerForm');
  if (!modal || !form) return;
  const customer = await Brayn.api(`/api/customers/${id}`);
  form.elements.id.value = customer.id;
  form.elements.name.value = customer.name || '';
  form.elements.phone.value = customer.phone || '';
  form.elements.email.value = customer.email || '';
  form.elements.nationalId.value = customer.national_id || '';
  form.elements.branch.value = customer.branch || 'Main';
  form.elements.product.value = customer.product || '';
  form.elements.status.value = customer.status || 'New';
  form.elements.guarantorName.value = customer.guarantor_name || '';
  form.elements.guarantorPhone.value = customer.guarantor_phone || '';
  form.elements.collateral.value = customer.collateral || '';
  modal.hidden = false;
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('customerForm');
  const message = document.getElementById('customerMessage');

  if (form && message) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.className = 'success-text';
      message.textContent = '';
      const data = new FormData(form);
      try {
        await Brayn.api('/api/customers', {
          method: 'POST',
          body: JSON.stringify({
            name: data.get('name'),
            product: data.get('product'),
            email: data.get('email'),
            phone: data.get('phone'),
            nationalId: data.get('nationalId'),
            status: data.get('status') || 'New',
            branch: data.get('branch') || 'Main',
            guarantorName: data.get('guarantorName') || '',
            guarantorPhone: data.get('guarantorPhone') || '',
            collateral: data.get('collateral') || '',
          }),
        });
        message.textContent = 'Customer saved.';
        form.reset();
        await loadCustomersPage(1);
      } catch (error) {
        message.className = 'error-text';
        message.textContent = error.message;
      }
    });
  }

  document.querySelector('#customerTable')?.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-edit]');
    if (!button) return;
    try {
      await openEditCustomer(button.dataset.edit);
    } catch (error) {
      alert(error.message);
    }
  });

  const editForm = document.getElementById('editCustomerForm');
  const editMessage = document.getElementById('editMessage');
  const modal = document.getElementById('editModal');

  document.getElementById('closeEditModal')?.addEventListener('click', () => {
    if (modal) modal.hidden = true;
  });

  editForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    editMessage.className = 'success-text';
    editMessage.textContent = '';
    const data = new FormData(editForm);
    try {
      await Brayn.api(`/api/customers/${data.get('id')}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: data.get('name'),
          product: data.get('product'),
          email: data.get('email'),
          phone: data.get('phone'),
          nationalId: data.get('nationalId'),
          status: data.get('status') || 'New',
          branch: data.get('branch') || 'Main',
          guarantorName: data.get('guarantorName') || '',
          guarantorPhone: data.get('guarantorPhone') || '',
          collateral: data.get('collateral') || '',
        }),
      });
      editMessage.textContent = 'Customer updated.';
      modal.hidden = true;
      await loadCustomersPage();
    } catch (error) {
      editMessage.className = 'error-text';
      editMessage.textContent = error.message;
    }
  });

  document.getElementById('customerFilters')?.addEventListener('submit', (event) => {
    event.preventDefault();
    loadCustomersPage(1);
  });
  document.getElementById('exportCustomers')?.addEventListener('click', () =>
    Brayn.downloadExport('customers')
  );
  loadCustomersPage(1);
});
