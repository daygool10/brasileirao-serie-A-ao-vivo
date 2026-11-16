// Backend Brasileirão ao Vivo — Express + PostgreSQL + API de futebol (football-data.org)
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------------
// Provedor de dados em tempo real.
// Usamos football-data.org (API pública com plano gratuito, cobre o
// Brasileirão Série A via competição BSA). Como o GE/Google não expõem
// API pública oficial, esta é a fonte confiável e gratuita mais próxima.
// Basta obter um token em https://www.football-data.org/client/register
// e definir FOOTBALL_API_TOKEN. Sem token, o backend serve um mock para
// que a aplicação continue funcional em demonstração.
// ------------------------------------------------------------------
const FOOTBALL_API_BASE = process.env.FOOTBALL_API_BASE || 'https://api.football-data.org/v4';
const FOOTBALL_API_TOKEN = process.env.FOOTBALL_API_TOKEN || '';
const COMPETITION = process.env.COMPETITION_CODE || 'BSA'; // BSA = Brasileirão Série A

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30000); // 30s em jogos ao vivo
const cache = new Map(); // key -> { ts, data }

async function fetchFootball(path) {
  const now = Date.now();
  const hit = cache.get(path);
  if (hit && now - hit.ts < CACHE_TTL_MS) return hit.data;

  if (!FOOTBALL_API_TOKEN) {
    return mockFootball(path);
  }

  let res;
  try {
    res = await fetch(`${FOOTBALL_API_BASE}${path}`, {
      headers: {
        'X-Auth-Token': FOOTBALL_API_TOKEN,
        // A football-data.org rejeita (403) requisições sem User-Agent de navegador.
        'User-Agent': 'Mozilla/5.0 (compatible; BrasileiraoAoVivo/1.0)',
        'Accept': 'application/json',
      },
    });
  } catch (e) {
    console.warn(`fetchFootball ${path} falhou (${e.message}) - usando mock`);
    return mockFootball(path);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`API futebol ${res.status}: ${text.slice(0, 200)} - usando mock`);
    return mockFootball(path);
  }
  const data = await res.json();
  cache.set(path, { ts: now, data });
  return data;
}

// Mock realista para rodar sem token ----------------------------------
function mockFootball(path) {
  const teams = [
    { id: 1783, name: 'Flamengo', shortName: 'Flamengo', tla: 'FLA', crest: 'https://crests.football-data.org/1783.png' },
    { id: 1776, name: 'São Paulo', shortName: 'São Paulo', tla: 'SAO', crest: 'https://crests.football-data.org/1776.png' },
    { id: 1779, name: 'Corinthians', shortName: 'Corinthians', tla: 'COR', crest: 'https://crests.football-data.org/1779.png' },
    { id: 1765, name: 'Palmeiras', shortName: 'Palmeiras', tla: 'PAL', crest: 'https://crests.football-data.org/1765.png' },
    { id: 1766, name: 'Atlético Mineiro', shortName: 'Atlético-MG', tla: 'CAM', crest: 'https://crests.football-data.org/1766.png' },
    { id: 1767, name: 'Grêmio', shortName: 'Grêmio', tla: 'GRE', crest: 'https://crests.football-data.org/1767.png' },
    { id: 1768, name: 'Internacional', shortName: 'Internacional', tla: 'INT', crest: 'https://crests.football-data.org/1768.png' },
    { id: 1770, name: 'Botafogo', shortName: 'Botafogo', tla: 'BOT', crest: 'https://crests.football-data.org/1770.png' },
  ];
  const now = new Date();
  const iso = d => d.toISOString();

  if (path.includes('/teams')) {
    return {
      teams: teams.map(t => ({
        id: t.id, name: t.name, shortName: t.shortName, tla: t.tla, crest: t.crest,
      })),
    };
  }
  if (path.includes('/standings')) {
    return {
      competition: { name: 'Brasileirão Série A' },
      standings: [{
        type: 'TOTAL',
        table: teams.map((t, i) => ({
          position: i + 1,
          team: t,
          playedGames: 10 + i,
          won: 7 - (i % 4), drawn: 2, lost: 1 + (i % 4),
          points: 23 - i,
          goalsFor: 22 - i, goalsAgainst: 8 + i, goalDifference: (22 - i) - (8 + i),
        })),
      }],
    };
  }
  if (path.includes('/matches')) {
    const make = (offsetMin, status, home, away, hs, as) => ({
      id: Math.floor(Math.random() * 1e6),
      utcDate: iso(new Date(now.getTime() - offsetMin * 60000)),
      status,
      minute: status === 'IN_PLAY' ? 67 : null,
      competition: { name: 'Brasileirão Série A' },
      homeTeam: home, awayTeam: away,
      score: {
        fullTime: { home: hs, away: as },
        halfTime: { home: hs != null ? Math.floor(hs / 2) : null, away: as != null ? Math.floor(as / 2) : null },
      },
    });
    const matches = [
      make(10, 'IN_PLAY', teams[0], teams[1], 2, 1),
      make(15, 'IN_PLAY', teams[2], teams[3], 0, 0),
      make(180, 'FINISHED', teams[4], teams[5], 3, 1),
      make(200, 'FINISHED', teams[6], teams[7], 1, 2),
      make(-120, 'TIMED', teams[1], teams[2], null, null),
    ];
    return { matches };
  }
  return {};
}

// ------------------------------------------------------------------
// Banco
// ------------------------------------------------------------------
const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'copa',
  password: process.env.DB_PASSWORD || 'copa',
  database: process.env.DB_NAME || 'copa',
  ssl: process.env.DB_HOST.includes('render.com') ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  for (let i = 0; i < 30; i++) {
    try { await pool.query('SELECT 1'); break; }
    catch (e) { console.log('Aguardando Postgres...', e.code); await new Promise(r => setTimeout(r, 1000)); }
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      team_id INTEGER,
      team_name TEXT,
      team_crest TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id INTEGER;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team_name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team_crest TEXT;
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `);
  console.log('DB pronto.');
}

const app = express();
app.use(express.json({ limit: '256kb' }));

const ORIGIN = process.env.FRONTEND_ORIGIN || true;
app.use(cors({ origin: ORIGIN, credentials: true }));

app.use(session({
  store: new PgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'troque-este-segredo-em-producao',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
  next();
}

function sessionPayload(req) {
  return {
    logged: !!req.session.userId,
    username: req.session.username || null,
    team: req.session.team || null,
  };
}

// ---------- Auth ----------
// O cadastro e o login exigem a escolha do time, que é persistido no banco
// e na sessão. O time é usado para filtrar "Meu time" e destacar os jogos.
app.post('/api/register', async (req, res) => {
  const { username, password, team } = req.body || {};
  if (!username || !password || username.length < 3 || password.length < 4)
    return res.status(400).json({ error: 'Usuário (mín 3) e senha (mín 4) obrigatórios' });
  if (!team || !team.id || !team.name)
    return res.status(400).json({ error: 'Escolha o seu time para continuar' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = await pool.query(
      'INSERT INTO users (username, password_hash, team_id, team_name, team_crest) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [username, hash, team.id, team.name, team.crest || null]
    );
    req.session.userId = r.rows[0].id;
    req.session.username = username;
    req.session.team = { id: team.id, name: team.name, crest: team.crest || null };
    res.json({ ok: true, ...sessionPayload(req) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Usuário já existe' });
    console.error(e);
    res.status(500).json({ error: 'Erro ao registrar' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const r = await pool.query('SELECT id, username, password_hash, team_id, team_name, team_crest FROM users WHERE username=$1', [username || '']);
  const row = r.rows[0];
  if (!row || !bcrypt.compareSync(password || '', row.password_hash))
    return res.status(401).json({ error: 'Credenciais inválidas' });
  req.session.userId = row.id;
  req.session.username = row.username;
  req.session.team = row.team_id ? { id: row.team_id, name: row.team_name, crest: row.team_crest } : null;
  res.json({ ok: true, ...sessionPayload(req) });
});

// Permite trocar o time depois (ex.: usuário mudou de ideia).
app.post('/api/team', requireAuth, async (req, res) => {
  const { team } = req.body || {};
  if (!team || !team.id || !team.name) return res.status(400).json({ error: 'Time inválido' });
  await pool.query('UPDATE users SET team_id=$1, team_name=$2, team_crest=$3 WHERE id=$4',
    [team.id, team.name, team.crest || null, req.session.userId]);
  req.session.team = { id: team.id, name: team.name, crest: team.crest || null };
  res.json({ ok: true, ...sessionPayload(req) });
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get('/api/session', (req, res) => {
  res.json(sessionPayload(req));
});

// ---------- Dados de futebol (proxy com cache) ----------
// Times do Brasileirão — usado na tela de login para escolher o time.
app.get('/api/teams', async (req, res) => {
  try {
    const data = await fetchFootball(`/competitions/${COMPETITION}/teams?season=${new Date().getFullYear()}`);
    const teams = (data.teams || []).map(t => ({
      id: t.id, name: t.name, shortName: t.shortName, tla: t.tla, crest: t.crest,
    })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    res.json({ teams });
  } catch (e) {
    console.error('teams', e.message);
    res.status(502).json({ error: 'Falha ao obter times', detail: e.message });
  }
});

// Tabela de classificação sempre atualizada.
app.get('/api/standings', requireAuth, async (req, res) => {
  try {
    const data = await fetchFootball(`/competitions/${COMPETITION}/standings?season=${new Date().getFullYear()}`);
    const total = (data.standings || []).find(s => s.type === 'TOTAL') || (data.standings || [])[0];
    // Diagnóstico: mostra o primeiro registro bruto para conferir os nomes dos campos da API.
    if (total?.table?.[0]) console.log('standings raw row:', JSON.stringify(total.table[0]));
    const table = (total?.table || []).map(row => ({
      position: row.position,
      team: { id: row.team.id, name: row.team.shortName || row.team.name, crest: row.team.crest },
      playedGames: row.playedGames,
      won: row.won ?? 0, drawn: row.drawn ?? 0, lost: row.lost ?? 0,
      points: row.points,
      goalsFor: row.goalsFor, goalsAgainst: row.goalsAgainst, goalDifference: row.goalDifference,
      isUserTeam: req.session.team && row.team.id === req.session.team.id,
    }));
    res.json({ table, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('standings', e.message);
    res.status(502).json({ error: 'Falha ao obter tabela', detail: e.message });
  }
});

// Jogos: ao vivo + próximos. Por padrão pega uma janela de -1 a +7 dias.
app.get('/api/matches', requireAuth, async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days || 3), 14);
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().slice(0, 10);
    const qs = `?dateFrom=${fmt(from)}&dateTo=${fmt(to)}&season=${new Date().getFullYear()}`;
    const data = await fetchFootball(`/competitions/${COMPETITION}/matches${qs}`);

    const teamId = req.session.team?.id;
    const isMine = m => teamId && (m.homeTeam?.id === teamId || m.awayTeam?.id === teamId);

    const matches = (data.matches || []).map(m => ({
      id: m.id,
      utcDate: m.utcDate,
      status: m.status, // SCHEDULED | TIMED | IN_PLAY | PAUSED | FINISHED
      minute: m.minute ?? null,
      homeTeam: { id: m.homeTeam?.id, name: m.homeTeam?.shortName || m.homeTeam?.name, crest: m.homeTeam?.crest },
      awayTeam: { id: m.awayTeam?.id, name: m.awayTeam?.shortName || m.awayTeam?.name, crest: m.awayTeam?.crest },
      score: {
        home: m.score?.fullTime?.home ?? null,
        away: m.score?.fullTime?.away ?? null,
      },
      isUserTeam: isMine(m),
    })).sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

    const live = matches.filter(m => m.status === 'IN_PLAY' || m.status === 'PAUSED');
    const mine = matches.filter(m => m.isUserTeam);
    res.json({ matches, live, mine, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('matches', e.message);
    res.status(502).json({ error: 'Falha ao obter jogos', detail: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, provider: FOOTBALL_API_TOKEN ? 'football-data.org' : 'mock' }));

initDb().then(() => {
  app.listen(PORT, () => console.log(`Backend em http://localhost:${PORT}`));
}).catch(e => { console.error('Falha ao iniciar DB', e); process.exit(1); });
