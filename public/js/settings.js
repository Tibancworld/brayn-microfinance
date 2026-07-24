async function loadSettingsPage() {
  const user = await Brayn.requireSession();
  if (!user) return;
  if (user.role !== 'admin') {
    window.location.href = '/index.html';
    return;
  }
  Brayn.mountShell('settings', user);

  const userBody = document.querySelector('#userTable tbody');
  const auditBody = document.querySelector('#auditTable tbody');
  const backupBody = document.querySelector('#backupTable tbody');

  try {
    const [users, audit, backups] = await Promise.all([
      Brayn.api('/api/users'),
      Brayn.api('/api/audit'),
      Brayn.api('/api/admin/backups'),
    ]);

    userBody.innerHTML = users
      .map(
        (row) => `
        <tr>
          <td>${Brayn.escapeHtml(row.username)}</td>
          <td>${Brayn.escapeHtml(row.role)}</td>
          <td>${row.active ? 'Yes' : 'No'}</td>
          <td>
            <button class="btn btn-secondary btn-compact" data-toggle="${row.id}" data-active="${row.active ? 0 : 1}">
              ${row.active ? 'Deactivate' : 'Activate'}
            </button>
          </td>
        </tr>`
      )
      .join('');

    auditBody.innerHTML = audit.length
      ? audit
          .map(
            (row) => `
          <tr>
            <td>${Brayn.escapeHtml(String(row.created_at || '').slice(0, 19))}</td>
            <td>${Brayn.escapeHtml(row.username || '—')}</td>
            <td>${Brayn.escapeHtml(row.action)}</td>
            <td>${Brayn.escapeHtml(row.entity_type)} #${Brayn.escapeHtml(row.entity_id || '—')}</td>
            <td>${Brayn.escapeHtml(row.details || '')}</td>
          </tr>`
          )
          .join('')
      : '<tr><td colspan="5">No audit events yet.</td></tr>';

    if (backupBody) {
      backupBody.innerHTML = backups.length
        ? backups
            .map(
              (row) => `
            <tr>
              <td>${Brayn.escapeHtml(row.file)}</td>
              <td>${Math.round(row.size / 1024)} KB</td>
              <td>${Brayn.escapeHtml(String(row.createdAt || '').slice(0, 19))}</td>
            </tr>`
            )
            .join('')
        : '<tr><td colspan="3">No backups yet.</td></tr>';
    }
  } catch (error) {
    userBody.innerHTML = `<tr><td colspan="4">${Brayn.escapeHtml(error.message)}</td></tr>`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('userForm');
  const message = document.getElementById('userMessage');

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.className = 'success-text';
    message.textContent = '';
    const data = new FormData(form);
    try {
      await Brayn.api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          username: data.get('username'),
          password: data.get('password'),
          role: data.get('role'),
        }),
      });
      message.textContent = 'User created.';
      form.reset();
      await loadSettingsPage();
    } catch (error) {
      message.className = 'error-text';
      message.textContent = error.message;
    }
  });

  const passwordForm = document.getElementById('passwordForm');
  const passwordMessage = document.getElementById('passwordMessage');
  passwordForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    passwordMessage.className = 'success-text';
    passwordMessage.textContent = '';
    const data = new FormData(passwordForm);
    try {
      await Brayn.api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: data.get('currentPassword'),
          newPassword: data.get('newPassword'),
        }),
      });
      passwordMessage.textContent = 'Password updated.';
      passwordForm.reset();
    } catch (error) {
      passwordMessage.className = 'error-text';
      passwordMessage.textContent = error.message;
    }
  });

  document.getElementById('backupBtn')?.addEventListener('click', async () => {
    const note = document.getElementById('backupMessage');
    try {
      const result = await Brayn.api('/api/admin/backup', { method: 'POST', body: '{}' });
      if (note) {
        note.className = 'success-text';
        note.textContent = `Backup created: ${result.file}`;
      }
      await loadSettingsPage();
    } catch (error) {
      if (note) {
        note.className = 'error-text';
        note.textContent = error.message;
      }
    }
  });

  document.querySelector('#userTable')?.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-toggle]');
    if (!button) return;
    button.disabled = true;
    try {
      await Brayn.api(`/api/users/${button.dataset.toggle}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: Number(button.dataset.active) === 1 }),
      });
      await loadSettingsPage();
    } catch (error) {
      alert(error.message);
      button.disabled = false;
    }
  });

  document.getElementById('exportAudit')?.addEventListener('click', () => Brayn.downloadExport('audit'));
  loadSettingsPage();
});
