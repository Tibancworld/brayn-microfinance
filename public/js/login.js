(async function () {
  try {
    await Brayn.api('/api/auth/me', { skipAuthRedirect: true });
    const params = new URLSearchParams(window.location.search);
    window.location.href = params.get('next') || '/';
    return;
  } catch {
    // stay on login
  }

  const form = document.getElementById('loginForm');
  const message = document.getElementById('loginMessage');
  const passwordInput = document.getElementById('passwordInput');
  const togglePassword = document.getElementById('togglePassword');
  const demoHost = document.getElementById('authDemo');
  const demoRow = document.getElementById('authDemoRow');

  togglePassword?.addEventListener('click', () => {
    const hidden = passwordInput.type === 'password';
    passwordInput.type = hidden ? 'text' : 'password';
    togglePassword.textContent = hidden ? 'Hide' : 'Show';
  });

  try {
    const demo = await Brayn.api('/api/auth/demo', { skipAuthRedirect: true });
    if (demo.enabled && Array.isArray(demo.accounts) && demo.accounts.length && demoRow) {
      demo.accounts.forEach((account) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'auth-chip';
        chip.textContent = account.label;
        chip.addEventListener('click', () => {
          form.username.value = account.username || '';
          form.password.value = account.password || '';
          form.username.focus();
        });
        demoRow.appendChild(chip);
      });
      demoHost.hidden = false;
    }
  } catch {
    // demo chips optional
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.textContent = '';
    const submit = form.querySelector('.auth-submit');
    submit.disabled = true;
    submit.textContent = 'Signing in…';

    const data = new FormData(form);
    try {
      await Brayn.api('/api/auth/login', {
        method: 'POST',
        skipAuthRedirect: true,
        body: JSON.stringify({
          username: data.get('username'),
          password: data.get('password'),
        }),
      });
      const params = new URLSearchParams(window.location.search);
      window.location.href = params.get('next') || '/';
    } catch (error) {
      message.textContent = error.message;
      submit.disabled = false;
      submit.textContent = 'Enter workspace';
    }
  });
})();
