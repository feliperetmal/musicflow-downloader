# MusicFlow Downloader v3.0

Plataforma full-stack para análise de links do **YouTube**, **YouTube Music**, **YouTube Shorts** e **Spotify**, listagem e exportação de playlists com suporte RTL/hebraico, autenticação Spotify OAuth 2.0 (PKCE) e conversão/download real de áudio e vídeo autorizados em **MP3** e **MP4** com **FFmpeg** e **FFprobe**.

## Arquitetura do Projeto

```text
├── apps/
│   ├── web/        # Frontend Next.js 15 (App Router, Tailwind CSS, Lucide) + BFF API + /admin/diagnostics
│   └── worker/     # Worker dedicado Node.js + TypeScript + FFmpeg/FFprobe + Fila paralela + SSE + Callback OAuth 127.0.0.1:8888
├── packages/
│   └── shared/     # Contratos TypeScript, parser de URLs, matcher de arquivos, exportadores (CSV/JSON/M3U) e validação
├── scripts/
│   └── dev.mjs     # Executor local simultâneo (web + worker)
├── vercel.json     # Configuração de deploy do frontend na Vercel
└── .env.example    # Modelo de variáveis de ambiente
```

### Diagnóstico e Correções da Versão 3.0

1. **YouTube HTTP 403 (Causa Raiz e Correção):**
   - Streams adaptativos `googlevideo.com` do cliente `IOS` retornam `HTTP 403` quando requisitados sem cabeçalho `Range:` (o que ocorria quando `content_length` não era informado previamente ou em certos Shorts).
   - O worker agora envia **sempre** requisições em blocos `Range: bytes=...` com `User-Agent` compatível, lê `Content-Range` dinamicamente quando o tamanho total não é conhecido antecipadamente, executa **probe de disponibilidade (`bytes=0-0`)** antes de exibir botões de download e diferencia falhas permanentes (`401`, `403`, `404`) de erros transitórios (`429`, `5xx`, timeout) com *exponential backoff + jitter*.
2. **Spotify Web API (Atualização Fevereiro/2026 + OAuth PKCE):**
   - Atualizado para `GET /v1/playlists/{playlist_id}` e `GET /v1/playlists/{playlist_id}/items` com paginação automática (`limit=50`, `offset`), preservação da ordem original, progresso em tempo real (`Carregando músicas: 50 de 213`) e suporte completo a caracteres Unicode/hebraico (`dir="auto"`).
   - Autenticação via **Authorization Code + PKCE** (`http://127.0.0.1:8888/callback`), proteção CSRF com `state`, renovação automática de tokens e sessão armazenada exclusivamente no servidor via cookie `HttpOnly`.
   - Tratamento explícito de restrições do **Development Mode** (conta Premium exigida ao proprietário do app, limite de 5 usuários na allowlist e erro `HTTP 403` em playlists de terceiros não colaboradas), sem mascarar limitações com previews incompletos de Embed.
3. **Painel `/admin/diagnostics`:**
   - Exibe estado da Spotify Web API, validade do token do usuário (sem expor segredos), permissões, saúde do worker FFmpeg/FFprobe, filas, latências médias e erros HTTP recentes.

## Instalação e Execução Local

### Pré-requisitos
- **Node.js 20+**
- `ffmpeg-static` e `ffprobe-static` empacotados em `@musicflow/worker`.

### Passo a passo

1. Instale as dependências na raiz do monorepo:
   ```bash
   npm install
   ```

2. Copie o arquivo de variáveis de ambiente:
   ```bash
   cp .env.example .env
   ```
   *(No Windows PowerShell: `Copy-Item .env.example .env`)*

3. Preencha no `.env`:
   - `SPOTIFY_CLIENT_ID=c18da041f1b648ed9fdec51b82717160`
   - `SPOTIFY_CLIENT_SECRET=<seu segredo rotacionado no Dashboard>` (mantido somente no servidor; nunca no frontend/GitHub)
   - `SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback`
   - `SPOTIFY_SCOPES=playlist-read-private playlist-read-collaborative`
   - `WORKER_API_SECRET=<segredo aleatório forte>`
   - `ADMIN_DIAGNOSTICS_SECRET=<opcional para proteger /admin/diagnostics>`

4. Compile os pacotes e inicie em modo desenvolvimento:
   ```bash
   npm --workspace=@musicflow/shared run build
   npm run dev
   ```
   - Frontend: `http://localhost:3000`
   - Diagnóstico: `http://localhost:3000/admin/diagnostics`
   - Worker: `http://localhost:4000/health`
   - Callback OAuth local: `http://127.0.0.1:8888/callback`

## Testes Automatizados e Verificação

```bash
npm --workspace=@musicflow/shared run build
npm run typecheck
npm test
npm run build
```

## Deploy em Produção

1. **Worker (`apps/worker`):** publique em Railway, Render, Fly.io ou VPS Docker com disco temporário (`TEMP_DIR`), definindo `PORT`, `CORS_ORIGIN`, `FRONTEND_BASE_URL` (HTTPS da Vercel), `WORKER_API_SECRET`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI` (HTTPS cadastrado no Spotify Dashboard apontando para `/auth/spotify/callback`) e `YOUTUBE_API_KEY` (opcional).
2. **Frontend (`apps/web`):** publique na **Vercel** (usando `vercel.json` na raiz) com `WORKER_BASE_URL`, `WORKER_API_SECRET` e `ADMIN_DIAGNOSTICS_SECRET`.
