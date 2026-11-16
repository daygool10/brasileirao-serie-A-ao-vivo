/* Brasileirão ao Vivo — frontend
 * Abas: meu-time | ao-vivo | rodada | tabela
 * Polling a cada 30s para atualizar em tempo real.
 */

let session = null;
let currentTab = 'meu-time';
let lastMatches = null;
let lastStandings = null;
let pollTimer = null;
let teamsCache = null;

const REFRESH_MS = 30000;

const STATUS_LABEL = {
  SCHEDULED: 'Agendado',
  TIMED: 'A começar',
  IN_PLAY: 'AO VIVO',
  PAUSED: 'Intervalo',
  FINISHED: 'Encerrado',
  POSTPONED: 'Adiado',
  SUSPENDED: 'Suspenso',
  CANCELED: 'Cancelado',
};

(async function init() {
  try {
    session = await API.session();
    if (!session.logged) return location.href = 'index.html';
  } catch { return location.href = 'index.html'; }

  document.getElementById('user-name').textContent = session.team?.name || session.username;
  if (session.team?.crest) {
    document.getElementById('user-team-crest').innerHTML =
      `<img src="${session.team.crest}" alt="" class="crest-sm">`;
  }

  bindTabs();
  bindUserMenu();
  await refresh();
  startPolling();
})();

function bindTabs() {
  document.querySelectorAll('#nav button').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.tab;
      document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b === btn));
      render();
    });
  });
}

function bindUserMenu() {
  const menu = document.getElementById('user-menu');
  document.getElementById('user-btn').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', () => menu.classList.remove('open'));
  document.getElementById('btn-logout').addEventListener('click', async () => { await API.logout(); location.href = 'index.html'; });
  document.getElementById('btn-change-team').addEventListener('click', openTeamModal);
  document.getElementById('modal-close').addEventListener('click', closeTeamModal);
  document.getElementById('modal-team-save').addEventListener('click', saveTeam);
}

async function refresh() {
  setStatus('Atualizando…', false);
  try {
    const [m, s] = await Promise.all([API.matches(3), API.standings()]);
    lastMatches = m;
    lastStandings = s;
    render();
    const liveCount = (m.live || []).length;
    setStatus(
      liveCount
        ? `${liveCount} jogo(s) ao vivo • atualizado ${formatTime(new Date())}`
        : `Atualizado ${formatTime(new Date())}`,
      liveCount > 0
    );
  } catch (e) {
    setStatus('Falha ao atualizar: ' + e.message, false);
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
}

function render() {
  const main = document.getElementById('main');
  if (!lastMatches || !lastStandings) return;
  if (currentTab === 'meu-time') return renderMyTeam(main);
  if (currentTab === 'ao-vivo')  return renderLive(main);
  if (currentTab === 'rodada')   return renderRound(main);
  if (currentTab === 'tabela')   return renderStandings(main);
}

// ---------- Abas ----------
function renderMyTeam(main) {
  const teamId = session.team?.id;
  const row = lastStandings.table.find(r => r.team.id === teamId);
  const myMatches = lastMatches.matches.filter(m => m.isUserTeam);

  main.innerHTML = `
    <h1 class="page-title">${session.team?.name || 'Meu time'}</h1>
    <p class="page-sub">Resultados do seu clube em tempo real.</p>
    ${row ? renderTeamSummaryCard(row) : ''}
    <h2 class="section-title">Jogos do time</h2>
    <div class="matches-list" id="mine-list">
      ${myMatches.length ? myMatches.map(renderMatchCard).join('') : '<p class="empty">Nenhum jogo na janela atual.</p>'}
    </div>
  `;
}

function renderLive(main) {
  const live = lastMatches.live || [];
  main.innerHTML = `
    <h1 class="page-title">Jogos ao vivo</h1>
    <p class="page-sub">Todos os jogos rolando agora no Brasileirão.</p>
    <div class="matches-list">
      ${live.length ? live.map(renderMatchCard).join('') : '<p class="empty">Nenhum jogo ao vivo no momento.</p>'}
    </div>
  `;
}

function renderRound(main) {
  main.innerHTML = `
    <h1 class="page-title">Rodada</h1>
    <p class="page-sub">Jogos de ontem a +3 dias (atualiza a cada 30s).</p>
    <div class="matches-list">
      ${lastMatches.matches.length ? lastMatches.matches.map(renderMatchCard).join('') : '<p class="empty">Nenhum jogo nesta janela.</p>'}
    </div>
  `;
}

function renderStandings(main) {
  const rows = lastStandings.table;
  main.innerHTML = `
    <h1 class="page-title">Tabela do Brasileirão</h1>
    <p class="page-sub">Atualizada ${formatTime(new Date(lastStandings.updatedAt))} • posição do seu time em destaque.</p>
    <div class="table-wrap">
      <table class="standings">
        <thead>
          <tr>
            <th>#</th><th>Time</th>
            <th>P</th><th>J</th><th>V</th><th>E</th><th>D</th><th>GP</th><th>GC</th><th>SG</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr class="${r.isUserTeam ? 'is-mine' : ''}">
              <td>${r.position}</td>
              <td class="team-cell">
                ${r.team.crest ? `<img src="${r.team.crest}" class="crest-xs" alt="">` : ''}
                ${r.team.name}
              </td>
              <td><b>${r.points}</b></td>
              <td>${r.playedGames}</td>
              <td>${r.won ?? 0}</td>
              <td>${r.drawn ?? r.empates ?? 0}</td>
              <td>${r.lost ?? 0}</td>
              <td>${r.goalsFor}</td>
              <td>${r.goalsAgainst}</td>
              <td>${r.goalDifference > 0 ? '+' : ''}${r.goalDifference}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderTeamSummaryCard(row) {
  return `
    <div class="team-summary">
      <div class="team-summary-crest">
        ${row.team.crest ? `<img src="${row.team.crest}" alt="">` : ''}
      </div>
      <div>
        <div class="team-summary-pos">${row.position}º lugar</div>
        <div class="team-summary-points">${row.points} pontos</div>
        <div class="team-summary-detail">${row.playedGames} jogos • ${row.won}V ${row.drawn}E ${row.lost}D • SG ${row.goalDifference > 0 ? '+' : ''}${row.goalDifference}</div>
      </div>
    </div>
  `;
}

function renderMatchCard(m) {
  const live = m.status === 'IN_PLAY' || m.status === 'PAUSED';
  const finished = m.status === 'FINISHED';
  const scoreHome = m.score.home;
  const scoreAway = m.score.away;
  const showScore = scoreHome != null && scoreAway != null;
  return `
    <div class="match-card-live ${live ? 'is-live' : ''} ${m.isUserTeam ? 'is-mine' : ''}">
      <div class="match-meta">
        <span class="match-status status-${m.status}">
          ${live ? `<span class="live-dot"></span> ${STATUS_LABEL[m.status]}${m.minute ? ' ' + m.minute + "'" : ''}` : STATUS_LABEL[m.status] || m.status}
        </span>
        <span class="match-time">${formatDate(m.utcDate)}</span>
      </div>
      <div class="match-teams">
        <div class="side ${m.isUserTeam && isHomeUser(m) ? 'is-mine-team' : ''}">
          ${m.homeTeam.crest ? `<img src="${m.homeTeam.crest}" class="crest-sm" alt="">` : ''}
          <span>${m.homeTeam.name}</span>
        </div>
        <div class="score ${live ? 'live-score' : ''}">
          ${showScore ? `${scoreHome} <span class="score-sep">x</span> ${scoreAway}` : '–'}
        </div>
        <div class="side right ${m.isUserTeam && !isHomeUser(m) ? 'is-mine-team' : ''}">
          <span>${m.awayTeam.name}</span>
          ${m.awayTeam.crest ? `<img src="${m.awayTeam.crest}" class="crest-sm" alt="">` : ''}
        </div>
      </div>
    </div>
  `;
}

function isHomeUser(m) {
  return session.team?.id === m.homeTeam.id;
}

// ---------- Modal trocar time ----------
async function openTeamModal() {
  document.getElementById('user-menu').classList.remove('open');
  document.getElementById('modal').classList.add('show');
  const select = document.getElementById('modal-team-select');
  if (teamsCache) return fillTeamSelect(select);
  select.innerHTML = '<option>Carregando…</option>';
  try {
    const r = await API.teams();
    teamsCache = r.teams || [];
    fillTeamSelect(select);
  } catch (e) {
    select.innerHTML = `<option>Erro: ${e.message}</option>`;
  }
}

function fillTeamSelect(select) {
  select.innerHTML = teamsCache.map(t =>
    `<option value="${t.id}" ${t.id === session.team?.id ? 'selected' : ''}>${t.name}</option>`
  ).join('');
}

function closeTeamModal() {
  document.getElementById('modal').classList.remove('show');
}

async function saveTeam() {
  const select = document.getElementById('modal-team-select');
  const id = Number(select.value);
  const team = teamsCache.find(t => t.id === id);
  if (!team) return toast('Selecione um time');
  try {
    const r = await API.setTeam({ id: team.id, name: team.name, crest: team.crest });
    session = r;
    document.getElementById('user-name').textContent = team.name;
    document.getElementById('user-team-crest').innerHTML =
      team.crest ? `<img src="${team.crest}" class="crest-sm" alt="">` : '';
    closeTeamModal();
    toast('Time atualizado!');
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

// ---------- Helpers ----------
function setStatus(text, live) {
  document.getElementById('status-text').textContent = text;
  document.getElementById('live-dot').classList.toggle('on', !!live);
}

function formatTime(d) {
  return new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
