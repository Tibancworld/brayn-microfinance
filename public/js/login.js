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

  togglePassword?.addEventListener('click', () => {
    const hidden = passwordInput.type === 'password';
    passwordInput.type = hidden ? 'text' : 'password';
    togglePassword.textContent = hidden ? 'Hide' : 'Show';
  });

  document.querySelectorAll('.auth-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      form.username.value = chip.dataset.user;
      form.password.value = chip.dataset.pass;
      form.username.focus();
    });
  });

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
