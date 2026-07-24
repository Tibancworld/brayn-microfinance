window.Brayn = window.Brayn || {};

(function syncCompactUi() {
  const apply = () => {
    const width = Math.min(window.innerWidth || 9999, screen.width || 9999);
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const compact = width <= 926 || (coarse && (screen.width || 0) <= 926);
    document.documentElement.classList.toggle('is-compact', compact);
    document.documentElement.classList.toggle('is-desktop', !compact);
  };
  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
})();

Brayn.escapeHtml = function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

Brayn.formatKes = function formatKes(value) {
  return `KES ${Number(value || 0).toLocaleString('en-KE')}`;
};

Brayn.api = async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (response.status === 401 && !options.skipAuthRedirect) {
    const onLogin = window.location.pathname === '/login' || window.location.pathname.endsWith('/login');
    if (!onLogin) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/login?next=${next}`;
    }
  }

  if (!response.ok) {
    throw new Error((data && data.error) || `Request failed (${response.status})`);
  }

  return data;
};

Brayn.requireSession = async function requireSession() {
  try {
    const data = await Brayn.api('/api/auth/me', { skipAuthRedirect: true });
    Brayn.currentUser = data.user;
    return data.user;
  } catch {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?next=${next}`;
    return null;
  }
};

Brayn.can = function can(...roles) {
  return !!(Brayn.currentUser && roles.includes(Brayn.currentUser.role));
};

Brayn.mountShell = function mountShell(active, user) {
  const host = document.querySelector('[data-app-shell]');
  if (!host) return;

  const links = [
    { href: '/', key: 'dashboard', label: 'Dashboard' },
    { href: '/loans', key: 'loans', label: 'Loans' },
    { href: '/customers', key: 'customers', label: 'Customers' },
    { href: '/collections', key: 'collections', label: 'Collections' },
    { href: '/payments', key: 'payments', label: 'Payments' },
    { href: '/reports', key: 'reports', label: 'Reports' },
  ];
  links.push({ href: '/account', key: 'account', label: 'Account' });
  if (user?.role === 'admin') {
    links.push({ href: '/settings', key: 'settings', label: 'Settings' });
  }

  host.innerHTML = `
    <header class="topbar">
      <div class="container topbar-inner">
        <a class="brand" href="/">
          <span class="brand-mark" aria-hidden="true">B</span>
          <span class="brand-text">Brayn <span>Microfinance</span></span>
        </a>
        <div class="topbar-actions">
          <div class="notify-wrap">
            <button type="button" class="notify-btn" id="notifyBtn" aria-label="Notifications">
              Alerts <span class="notify-badge" id="notifyBadge" hidden>0</span>
            </button>
            <div class="notify-panel" id="notifyPanel" hidden></div>
          </div>
          <div class="auth-slot topbar-auth" data-auth-slot></div>
          <button type="button" class="nav-toggle" id="navToggle" aria-label="Open menu" aria-expanded="false" aria-controls="mainNav">Menu</button>
        </div>
        <form class="global-search" id="globalSearchForm" role="search">
          <input type="search" id="globalSearchInput" placeholder="Search loans, customers…" autocomplete="off" enterkeyhint="search" />
          <div class="search-results" id="globalSearchResults" hidden></div>
        </form>
        <nav class="nav-links" id="mainNav" aria-label="Main">
          ${links
            .map(
              (link) =>
                `<a href="${link.href}" class="${link.key === active ? 'active' : ''}">${link.label}</a>`
            )
            .join('')}
        </nav>
      </div>
      <div class="nav-scrim" id="navScrim" hidden></div>
      <aside class="mobile-drawer" id="mobileDrawer" aria-hidden="true">
        <div class="nav-drawer-head">
          <strong>Menu</strong>
          <button type="button" class="nav-close" id="navClose" aria-label="Close menu">Close</button>
        </div>
        <nav class="mobile-drawer-nav" id="mobileNav" aria-label="Mobile">
          ${links
            .map(
              (link) =>
                `<a href="${link.href}" class="${link.key === active ? 'active' : ''}">${link.label}</a>`
            )
            .join('')}
        </nav>
        <div class="auth-slot nav-auth" data-auth-slot></div>
      </aside>
    </header>
  `;

  Brayn.mountAuthNav(user);
  Brayn.bindGlobalSearch();
  Brayn.bindNotifications();
  Brayn.bindMobileNav();
};

Brayn.bindMobileNav = function bindMobileNav() {
  const toggle = document.getElementById('navToggle');
  const closeBtn = document.getElementById('navClose');
  const drawer = document.getElementById('mobileDrawer');
  const scrim = document.getElementById('navScrim');
  if (!toggle || !drawer) return;

  const setOpen = (open) => {
    drawer.classList.toggle('open', open);
    document.body.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    toggle.textContent = open ? 'Close' : 'Menu';
    if (scrim) scrim.hidden = !open;
  };

  toggle.addEventListener('click', () => setOpen(!drawer.classList.contains('open')));
  closeBtn?.addEventListener('click', () => setOpen(false));
  scrim?.addEventListener('click', () => setOpen(false));
  drawer.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => setOpen(false));
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
};

Brayn.bindNotifications = async function bindNotifications() {
  const btn = document.getElementById('notifyBtn');
  const badge = document.getElementById('notifyBadge');
  const panel = document.getElementById('notifyPanel');
  if (!btn || !badge || !panel) return;

  try {
    const data = await Brayn.api('/api/notifications');
    const total = Number(data.counts?.total || 0);
    if (total > 0) {
      badge.hidden = false;
      badge.textContent = String(total);
    } else {
      badge.hidden = true;
    }

    const parts = [];
    if (data.counts?.pendingApprovals) {
      parts.push(
        `<a class="notify-item" href="/loans?status=Pending"><strong>${data.counts.pendingApprovals} pending approvals</strong><span>Needs officer review</span></a>`
      );
    }
    (data.overdue || []).forEach((row) => {
      parts.push(
        `<a class="notify-item danger" href="/loan?id=${row.loan_id}"><strong>${Brayn.escapeHtml(row.customer_name)}</strong><span>Overdue ${Brayn.escapeHtml(row.due_date)} · ${Brayn.formatKes(row.amount_due - row.amount_paid)}</span></a>`
      );
    });
    (data.dueSoon || []).forEach((row) => {
      parts.push(
        `<a class="notify-item" href="/loan?id=${row.loan_id}"><strong>${Brayn.escapeHtml(row.customer_name)}</strong><span>Due ${Brayn.escapeHtml(row.due_date)} · ${Brayn.formatKes(row.amount_due - row.amount_paid)}</span></a>`
      );
    });
    panel.innerHTML = parts.length
      ? parts.join('')
      : '<div class="notify-empty">No alerts right now.</div>';
  } catch {
    panel.innerHTML = '<div class="notify-empty">Unable to load alerts.</div>';
  }

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    panel.hidden = !panel.hidden;
  });
  document.addEventListener('click', (event) => {
    if (!panel.contains(event.target) && event.target !== btn) panel.hidden = true;
  });
};

Brayn.bindGlobalSearch = function bindGlobalSearch() {
  const form = document.getElementById('globalSearchForm');
  const input = document.getElementById('globalSearchInput');
  const results = document.getElementById('globalSearchResults');
  if (!form || !input || !results) return;

  let timer = null;
  const hide = () => {
    results.hidden = true;
    results.innerHTML = '';
  };

  const render = (data) => {
    const blocks = [];
    if (data.loans?.length) {
      blocks.push(
        `<div class="search-group"><strong>Loans</strong>${data.loans
          .map(
            (loan) =>
              `<a href="/loan?id=${loan.id}">LN-${String(loan.id).padStart(4, '0')} · ${Brayn.escapeHtml(loan.customer_name)} · ${Brayn.escapeHtml(loan.status)}</a>`
          )
          .join('')}</div>`
      );
    }
    if (data.customers?.length) {
      blocks.push(
        `<div class="search-group"><strong>Customers</strong>${data.customers
          .map(
            (customer) =>
              `<a href="/customer?id=${customer.id}">${Brayn.escapeHtml(customer.name)} · ${Brayn.escapeHtml(customer.phone || '—')}</a>`
          )
          .join('')}</div>`
      );
    }
    if (data.payments?.length) {
      blocks.push(
        `<div class="search-group"><strong>Payments</strong>${data.payments
          .map(
            (payment) =>
              `<a href="${payment.loan_id ? `/loan?id=${payment.loan_id}` : '/payments'}">PY-${String(payment.id).padStart(4, '0')} · ${Brayn.escapeHtml(payment.customer_name)} · ${Brayn.formatKes(payment.amount)}</a>`
          )
          .join('')}</div>`
      );
    }
    if (!blocks.length) {
      results.innerHTML = '<div class="search-empty">No matches found.</div>';
    } else {
      results.innerHTML = blocks.join('');
    }
    results.hidden = false;
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      hide();
      return;
    }
    timer = setTimeout(async () => {
      try {
        const data = await Brayn.api(`/api/search?q=${encodeURIComponent(q)}`);
        render(data);
      } catch {
        hide();
      }
    }, 220);
  });

  form.addEventListener('submit', (event) => event.preventDefault());
  document.addEventListener('click', (event) => {
    if (!form.contains(event.target)) hide();
  });
};

Brayn.mountAuthNav = function mountAuthNav(user) {
  const hosts = document.querySelectorAll('[data-auth-slot]');
  if (!hosts.length || !user) return;
  const markup = `
    <span class="nav-user">${Brayn.escapeHtml(user.username)} · ${Brayn.escapeHtml(user.role)}</span>
    <button type="button" class="btn btn-secondary btn-compact" data-logout-btn>Sign out</button>
  `;
  hosts.forEach((host) => {
    host.innerHTML = markup;
  });
  document.querySelectorAll('[data-logout-btn]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await Brayn.api('/api/auth/logout', { method: 'POST', body: '{}' });
      } finally {
        window.location.href = '/login';
      }
    });
  });
};

Brayn.setText = function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
};

Brayn.statusBadge = function statusBadge(status) {
  const safe = Brayn.escapeHtml(status || '—');
  return `<span class="status status-${safe}">${safe}</span>`;
};

Brayn.downloadExport = function downloadExport(type) {
  window.location.href = `/api/export/${type}`;
};

Brayn.pageState = Brayn.pageState || {};

Brayn.unwrapList = function unwrapList(data) {
  if (Array.isArray(data)) {
    return { items: data, total: data.length, page: 1, pageSize: data.length || 20, totalPages: 1 };
  }
  return {
    items: data.items || [],
    total: Number(data.total || 0),
    page: Number(data.page || 1),
    pageSize: Number(data.pageSize || 20),
    totalPages: Number(data.totalPages || 1),
  };
};

Brayn.renderPager = function renderPager(hostId, meta, onChange) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const page = meta.page || 1;
  const totalPages = meta.totalPages || 1;
  const total = meta.total || 0;
  host.innerHTML = `
    <div class="pager">
      <button type="button" class="btn btn-secondary btn-compact" data-page="prev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
      <span class="pager-meta">Page ${page} of ${totalPages} · ${total} records</span>
      <button type="button" class="btn btn-secondary btn-compact" data-page="next" ${page >= totalPages ? 'disabled' : ''}>Next</button>
    </div>
  `;
  host.onclick = (event) => {
    const button = event.target.closest('button[data-page]');
    if (!button || button.disabled) return;
    const nextPage = button.dataset.page === 'prev' ? page - 1 : page + 1;
    onChange(nextPage);
  };
};
