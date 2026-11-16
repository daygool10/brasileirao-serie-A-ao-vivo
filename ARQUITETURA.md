# Copa 2026 — Como o código funciona (detalhado)

Este documento explica **cada parte** do projeto: a estrutura geral, os 3 containers, o que cada arquivo faz e como os dados fluem entre o navegador, o backend e o banco.

---

## 1. Visão geral da arquitetura

```
            ┌─────────────────────────────────────────────────┐
            │                  NAVEGADOR                      │
            │   http://localhost:8080  (HTML + CSS + JS)      │
            └───────────────┬─────────────────────────────────┘
                            │  (fetch /api/...)
                            ▼
   ┌──────────────────────────────────────────┐
   │  CONTAINER frontend  (nginx:1.27-alpine) │
   │  - Serve arquivos estáticos de /public   │
   │  - Faz proxy de /api/* → backend:3000    │
   └───────────────┬──────────────────────────┘
                   │  rede interna "appnet"
                   ▼
   ┌──────────────────────────────────────────┐
   │  CONTAINER backend   (node:20-alpine)    │
   │  - Express + express-session             │
   │  - bcryptjs para senhas                  │
   │  - pg para PostgreSQL                    │
   │  - Rotas /api/*                          │
   └───────────────┬──────────────────────────┘
                   │  TCP 5432
                   ▼
   ┌──────────────────────────────────────────┐
   │  CONTAINER db        (postgres:16-alpine)│
   │  - Volume "db-data" persiste os dados    │
   │  - Tabelas: users, user_state,           │
   │    eliminated, matches, session          │
   └──────────────────────────────────────────┘
```

**Por que assim?** Separar em 3 containers permite:
- atualizar/reiniciar cada camada de forma independente,
- escalar o backend horizontalmente no futuro,
- garantir que dados do banco sobrevivam a `docker compose down` (volume nomeado).

---

## 2. `docker-compose.yml` — orquestração

Define os 3 serviços e como eles se conectam:

- **`db`**
  - Imagem `postgres:16-alpine`.
  - Variáveis `POSTGRES_USER/PASSWORD/DB` criam o banco no primeiro boot.
  - **Volume `db-data`** montado em `/var/lib/postgresql/data` → os dados persistem mesmo se o container for destruído.
  - **`healthcheck`** com `pg_isready` informa ao Compose quando o banco está pronto para aceitar conexões.

- **`backend`**
  - `build: ./backend` → compila a imagem usando o `Dockerfile` da pasta.
  - Recebe `DB_HOST=db` (nome do serviço vira hostname dentro da rede `appnet`).
  - `depends_on: db: condition: service_healthy` → só sobe depois que o Postgres responder ao healthcheck.
  - **Não expõe porta para o host** — só é acessível pelo frontend através da rede interna.

- **`frontend`**
  - `build: ./frontend` → Nginx com os arquivos estáticos.
  - **Única porta publicada** para o host: `${FRONTEND_PORT:-8080}:80`.
  - `depends_on: backend` para garantir ordem de boot.

- **`networks: appnet`** → rede bridge isolada onde os 3 containers se enxergam pelos nomes (`db`, `backend`, `frontend`).

- **`volumes: db-data`** → volume gerenciado pelo Docker (não some com `down`, só com `down -v`).

---

## 3. Container `db` (PostgreSQL)

Não tem código próprio — usa a imagem oficial. O backend cria as tabelas no primeiro boot via `initDb()` (ver seção 4).

### Tabelas

| Tabela | Propósito |
|---|---|
| `users` | Cadastro de login. Guarda `username` e `password_hash` (bcrypt). |
| `user_state` | Estado atual do bracket de cada usuário, em `JSONB`. Um registro por usuário (PK = `user_id`). Atualizado via `UPSERT`. |
| `eliminated` | Times eliminados por fase, para cada usuário. Várias linhas por usuário/fase. |
| `matches` | Histórico de partidas salvas (placar, pênaltis, vencedor). |
| `session` | Tabela usada por `connect-pg-simple` para guardar as sessões do Express (cookies). |

---

## 4. Container `backend` (Node.js + Express)

### `backend/Dockerfile`

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev    # instala só dependências de produção
COPY server.js ./
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
```

Imagem pequena (Alpine), instala dependências antes de copiar o código (cache de camada eficiente).

### `backend/server.js` — explicação por blocos

**1) Pool de conexões com o Postgres**

```js
const pool = new Pool({ host: process.env.DB_HOST, ... });
```

Um pool reaproveita conexões TCP com o banco — muito mais rápido que abrir/fechar a cada request.

**2) `initDb()`**

- Tenta `SELECT 1` em loop (até 30s) esperando o Postgres ficar pronto. Necessário porque mesmo com `healthcheck` o backend pode tentar antes do banco aceitar consultas.
- Em seguida executa `CREATE TABLE IF NOT EXISTS ...` para todas as tabelas. **Idempotente**: pode rodar várias vezes sem erro.

**3) Middlewares globais**

- `express.json({ limit: '256kb' })` → faz parse de JSON no `req.body`.
- `cors({ origin: FRONTEND_ORIGIN, credentials: true })` → libera o frontend (mesma origem via proxy, mas mantém CORS por segurança) e permite envio de cookies.
- `express-session` com **store em Postgres** (`connect-pg-simple`):
  - As sessões ficam na tabela `session`, não em memória → sobrevivem a reinício do container.
  - Cookie: `httpOnly`, `sameSite=lax`, validade 7 dias.

**4) `requireAuth`**

Middleware simples: se não houver `req.session.userId`, responde `401`. Usado para proteger todas as rotas de dados.

**5) Rotas de autenticação**

| Método | Rota | O que faz |
|---|---|---|
| POST | `/api/register` | Valida tamanho, gera hash com `bcryptjs`, insere em `users`. Em caso de duplicado (`23505`) retorna 409. Já loga o usuário (cria sessão). |
| POST | `/api/login` | Busca por `username`, compara hash com `bcrypt.compareSync`. Cria sessão. |
| POST | `/api/logout` | `req.session.destroy()`. |
| GET  | `/api/session` | Diz se há sessão ativa e quem é. |

**6) Rotas de estado do bracket**

- `GET /api/state` → devolve o `state_json` salvo (ou `null`).
- `POST /api/state` → faz **`UPSERT`**: insere se não existir, atualiza se já existir, sempre tocando `updated_at`.

**7) Rotas de eliminados**

- `GET /api/eliminated` → lista por usuário, ordenada por `id`.
- `POST /api/eliminated` → recebe `{ phase, teams[] }` e faz **transação**: apaga os antigos da fase e insere os novos. Se algo falhar, faz `ROLLBACK` (garante consistência).

**8) Rotas de partidas**

- `POST /api/save_match` → insere uma linha em `matches` com placar/pênaltis/vencedor.

**9) Health e boot**

- `GET /api/health` → usado para monitoramento.
- `initDb().then(() => app.listen(PORT))` → o servidor **só sobe depois** que o banco está pronto e as tabelas existem.

---

## 5. Container `frontend` (Nginx + estático)

### `frontend/Dockerfile`

```dockerfile
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public /usr/share/nginx/html
EXPOSE 80
```

Imagem Nginx oficial, recebe a configuração e os arquivos estáticos.

### `frontend/nginx.conf`

```nginx
location /api/ {
  proxy_pass http://backend:3000;     # nome do serviço no compose
  proxy_set_header Host $host;
  ...
}
location / {
  try_files $uri $uri/ /index.html;   # fallback estilo SPA
}
```

Pontos-chave:

- **`/api/*` é encaminhado para o backend** dentro da rede `appnet`. Do ponto de vista do navegador, frontend e backend são **a mesma origem (`localhost:8080`)** → cookies de sessão funcionam sem dor de cabeça com CORS/SameSite.
- `try_files ... /index.html` permite recarregar qualquer rota sem 404.

### `frontend/public/`

Site estático (HTML + CSS + JS puro). Os scripts mais importantes:

- **`assets/js/api.js`** — wrapper de `fetch` para as rotas do backend (login, estado, eliminados, partidas). Sempre usa `credentials: 'include'` para mandar o cookie de sessão.
- **`assets/js/data.js`** — lista de seleções/times e configuração estática da Copa.
- **`assets/js/app.js`** — toda a lógica de UI: monta os grupos, calcula classificações, gerencia a chave eliminatória (oitavas → quartas → semifinal → final/3º lugar) e sincroniza o estado com o backend via `api.js`.
- **`index.html`** — tela inicial / login.
- **`app.html`** — tela do aplicativo após login.

---

## 6. Fluxo de uma ação completa (exemplo: salvar uma partida)

1. Usuário clica em **Salvar partida** em `app.html`.
2. `app.js` chama uma função em `api.js`, que faz:
   ```js
   fetch('/api/save_match', {
     method: 'POST',
     credentials: 'include',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ phase, match_key, team_a, team_b, ... })
   })
   ```
3. O **Nginx** recebe em `localhost:8080/api/save_match` e, pela regra `location /api/`, encaminha para `http://backend:3000/api/save_match`.
4. O **backend** recebe a request:
   - `express-session` lê o cookie e busca a sessão na tabela `session`.
   - `requireAuth` valida que existe `req.session.userId`.
   - O handler executa `INSERT INTO matches ...` usando o `pool`.
5. O **Postgres** grava no arquivo dentro do volume `db-data` e responde ao backend.
6. O backend devolve `{ ok: true }` → Nginx repassa → JS atualiza a UI.

---

## 7. Segurança — o que já está coberto e o que melhorar

**Já implementado**

- Senhas armazenadas com **bcrypt** (nunca em texto puro).
- Cookies de sessão `httpOnly` (JS não consegue ler) e `sameSite=lax`.
- SQL com **parâmetros** (`$1, $2, ...`) → previne SQL injection.
- Transação no salvamento de eliminados.
- Backend e DB **sem porta exposta para o host** — só o frontend é público.

**Para produção, considere**

- Trocar `SESSION_SECRET` e `DB_PASSWORD` por valores longos e aleatórios.
- Servir via HTTPS (Nginx/Caddy/Traefik na frente) e marcar o cookie como `secure: true`.
- Rate-limit em `/api/login` e `/api/register` (ex.: `express-rate-limit`).
- Backup periódico do volume `db-data` (`pg_dump`).

---

## 8. Resumo dos arquivos

```
docker-compose.yml          → orquestra db + backend + frontend, define rede e volume
.env.example                → modelo das variáveis sensíveis

backend/Dockerfile          → imagem Node.js com o server.js
backend/package.json        → dependências (express, pg, bcryptjs, ...)
backend/server.js           → API REST, sessões, criação de tabelas

frontend/Dockerfile         → imagem Nginx com os estáticos
frontend/nginx.conf         → proxy /api/* → backend, fallback SPA
frontend/public/index.html  → tela de login
frontend/public/app.html    → tela do app
frontend/public/assets/js/  → api.js (fetch), data.js (dados), app.js (lógica)
frontend/public/assets/css/ → estilos
```

Com isso você tem o mapa completo: cada container, cada arquivo e cada rota.
