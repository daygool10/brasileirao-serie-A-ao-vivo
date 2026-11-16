# Brasileirao ao Vivo

App web (Docker Compose) para acompanhar o Campeonato Brasileiro Serie A em tempo real: resultados do seu time, jogos ao vivo, rodada e tabela sempre atualizada.

## Stack

- Backend: Node.js + Express + PostgreSQL
- Frontend: HTML/CSS/JS puro servido por Nginx
- Dados em tempo real: football-data.org (competicao BSA)

## Como funciona

1. No cadastro, o usuario escolhe o seu time - fica salvo no perfil e na sessao.
2. No login, o usuario entra com usuario e senha; o time e lido do perfil.
3. O app tem 4 abas:
   - Meu time: posicao na tabela + jogos do clube
   - Ao vivo: todos os jogos acontecendo agora
   - Rodada: jogos de ontem a +3 dias
   - Tabela: classificacao completa com o seu time destacado
4. Dados atualizados automaticamente a cada 30s (polling) e ao voltar o foco na aba.

## Sobre a fonte de dados

O GE/Globo e o Google nao oferecem API publica oficial para consumo direto. Por isso usamos a football-data.org, que:

- oferece plano gratuito
- cobre o Brasileirao Serie A (BSA)
- retorna status ao vivo (IN_PLAY, PAUSED, FINISHED), placar, minuto e classificacao

Sem token, o backend roda com dados mock para voce testar offline.

### Obtendo o token gratuito

1. Cadastre em https://www.football-data.org/client/register
2. Copie o token e coloque no .env como FOOTBALL_API_TOKEN=...
3. Reinicie: docker compose up -d --build

## Subindo

    cp .env.example .env
    # edite .env se quiser colocar o FOOTBALL_API_TOKEN
    docker compose up -d --build

Acesse http://localhost:8080

## Variaveis de ambiente

| Variavel | Descricao | Default |
|---|---|---|
| DB_USER / DB_PASSWORD / DB_NAME | Credenciais do Postgres | copa |
| SESSION_SECRET | Segredo das sessoes | - |
| FRONTEND_PORT | Porta publica do app | 8080 |
| FRONTEND_ORIGIN | Origem permitida no CORS | http://localhost:8080 |
| FOOTBALL_API_TOKEN | Token football-data.org (opcional) | - |
| COMPETITION_CODE | Codigo da competicao | BSA |
| CACHE_TTL_MS | TTL do cache em ms | 30000 |

## Endpoints

| Metodo | Rota | Auth | Descricao |
|---|---|---|---|
| POST | /api/register | - | Cria usuario (username, password, team) |
| POST | /api/login | - | Login (username, password) |
| POST | /api/logout | sim | Encerra sessao |
| GET | /api/session | - | Estado da sessao (usuario + time) |
| POST | /api/team | sim | Trocar time |
| GET | /api/teams | - | Lista de times do Brasileirao |
| GET | /api/matches?days=3 | sim | Jogos da janela + live + mine |
| GET | /api/standings | sim | Tabela de classificacao |
| GET | /api/health | - | Healthcheck |
# brasileirao-serie-A-ao-vivo
