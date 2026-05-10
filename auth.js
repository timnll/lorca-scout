// ── Auth ──────────────────────────────────────────────────────────────────────
// Simple password gate — no real security, just access control.

const AUTH_KEY = 'lorcana-scout-auth';

async function checkAuth() {
  const stored = sessionStorage.getItem(AUTH_KEY);
  // If already validated this session, go straight to app
  if (stored === 'ok') { showApp(); return; }

  // Fetch whether a password is required
  try {
    const res = await fetch(`${SERVER}/api/auth/check`);
    const { required, hint } = await res.json();
    if (!required) { sessionStorage.setItem(AUTH_KEY,'ok'); showApp(); return; }
    showLoginScreen(hint || '');
  } catch(e) {
    // Server unreachable — show login anyway (offline mode)
    showLoginScreen('');
  }
}

function showLoginScreen(hint) {
  document.getElementById('appRoot').style.display = 'none';
  const el = document.getElementById('loginScreen');
  el.style.display = 'flex';
  if (hint) document.getElementById('loginHint').textContent = hint;
}

function showApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appRoot').style.display = 'flex';
  initApp();
}

async function submitLogin() {
  const pw = document.getElementById('loginInput').value.trim();
  const errEl = document.getElementById('loginErr');
  errEl.textContent = '';
  if (!pw) return;

  document.getElementById('loginBtn').disabled = true;
  try {
    const res = await fetch(`${SERVER}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    const d = await res.json();
    if (d.ok) {
      sessionStorage.setItem(AUTH_KEY, 'ok');
      showApp();
    } else {
      errEl.textContent = 'Mot de passe incorrect';
      document.getElementById('loginBtn').disabled = false;
      document.getElementById('loginInput').value = '';
      document.getElementById('loginInput').focus();
    }
  } catch(e) {
    errEl.textContent = 'Serveur inaccessible';
    document.getElementById('loginBtn').disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loginInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitLogin();
  });
  checkAuth();
});