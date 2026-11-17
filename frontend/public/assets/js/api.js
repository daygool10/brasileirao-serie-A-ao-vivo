// Wrappers das chamadas à API Node/Express
// Em produção (GitHub Pages), o backend roda no Render. Em local (Docker), usa /api.
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? '/api'
  : 'https://brasileirao-serie-a-ao-vivo.onrender.com/api';

const API = (() => {
  async function call(path, opts = {}) {
    const res = await fetch(`${API_BASE}/${path}`, {
      method: opts.method || 'GET',
      credentials: 'include',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
    return data;
  }

  return {
    register: (username, password, team) => call('register', { method: 'POST', body: { username, password, team } }),
    login:    (username, password) => call('login',    { method: 'POST', body: { username, password } }),
    logout:   () => call('logout', { method: 'POST' }),
    session:  () => call('session'),
    setTeam:  (team) => call('team', { method: 'POST', body: { team } }),
    teams:    () => call('teams'),
    standings:() => call('standings'),
    matches:  (days = 3) => call(`matches?days=${days}`),
  };
})();
