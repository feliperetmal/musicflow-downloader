# MusicFlow Downloader 4.1 — Guia de Hospedagem 100% Gratuita (SEM Cartão de Crédito)

Este guia documenta a forma **mais fácil, rápida e 100% gratuita (sem pedir cartão de crédito)** de colocar o backend do **MusicFlow Downloader** online em HTTPS conectado ao GitHub Pages (`https://feliperetmal.github.io/musicflow-downloader/`).

---

## ⭐ Método #1 (Recomendado): Hugging Face Spaces — Docker Gratuito, SEM Cartão, 16 GB RAM

Enquanto Render (via Blueprint) e Koyeb frequentemente exigem cartão de crédito para verificação, o **Hugging Face Spaces (Docker SDK — `CPU Basic`)** oferece gratuitamente e **sem cartão de crédito**:

- **Hardware**: **2 vCPU + 16 GB de RAM** (32× mais memória que o Render Free — ideal para FFmpeg, `yt-dlp` e lotes ZIP).
- **Custo**: **\$0/mês**, **sem cartão de crédito**.
- **HTTPS automático**: `https://<SEU-USUARIO>-musicflow-worker.hf.space`.
- **Hibernação generosa**: só hiberna após **48 horas** sem uso (contra 15 minutos do Render) e acorda automaticamente ao receber acesso.
- **Zero-Config no código**: o MusicFlow detecta `SPACE_ID` e `SPACE_HOST` automaticamente, configurando `PORT=7860`, `CORS_ORIGIN=https://feliperetmal.github.io`, `FRONTEND_BASE_URL` e `SPOTIFY_REDIRECT_URI=https://<SPACE_HOST>/auth/spotify/callback` sem precisar preencher dezenas de variáveis!

### Passo a Passo (3 minutos):

#### Passo 1: Criar o Space gratuito no Hugging Face
1. Crie sua conta gratuita em [huggingface.co/join](https://huggingface.co/join) (**não pede cartão de crédito**).
2. Acesse [huggingface.co/new-space](https://huggingface.co/new-space):
   - **Space name**: `musicflow-worker`
   - **Space SDK**: **Docker** → selecione **Blank**
   - **Space hardware**: **CPU basic · 2 vCPU · 16 GB · FREE**
   - **Visibility**: **Public**
   - Clique em **Create Space**.
3. O endereço HTTPS do seu backend será:
   `https://<SEU-USUARIO-HF>-musicflow-worker.hf.space`

#### Passo 2: Gerar Token e Ativar Sync Automático pelo GitHub Actions
1. Acesse [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) → **Create new token** → tipo **Write** → copie o token (`hf_...`).
2. No seu repositório GitHub (`feliperetmal/musicflow-downloader`) → **Settings → Secrets and variables → Actions**:
   - Na aba **Secrets**, clique em **New repository secret**:
     - **Name:** `HF_TOKEN`
     - **Value:** *(cole o token `hf_...`)*
   - Na aba **Variables**, adicione **2 variáveis**:
     - **Name:** `HF_SPACE_ID` → **Value:** `<SEU-USUARIO-HF>/musicflow-worker`
     - **Name:** `NEXT_PUBLIC_API_URL` → **Value:** `https://<SEU-USUARIO-HF>-musicflow-worker.hf.space`
3. No GitHub, vá em **Actions**:
   - Execute **Sync Backend to Hugging Face Space** → **Run workflow** (envia o código e o `Dockerfile` para o Hugging Face compilar automaticamente).
   - Execute **CI & Deploy MusicFlow to GitHub Pages** → **Run workflow** (conecta o site `https://feliperetmal.github.io/musicflow-downloader/` ao seu backend HTTPS).
4. *(Opcional — Segredos no Space)*: No seu Space em **Settings → Variables and secrets**, adicione como **New secret**:
   - `SPOTIFY_CLIENT_SECRET`: *(seu segredo privado do app `24` no Spotify)*
   - `SESSION_SECRET`: *(uma senha longa aleatória para manter sessões válidas)*

#### Passo 3: Cadastrar a Redirect URI no Spotify Developer Dashboard
1. Acesse [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) → app **`24`** (`c18da041f1b648ed9fdec51b82717160`) → **Settings → Redirect URIs**.
2. Adicione exatamente:
   - `https://<SEU-USUARIO-HF>-musicflow-worker.hf.space/auth/spotify/callback`
3. Salve (**Save**) e confirme que seu e-mail Spotify está em **User Management** (Development Mode).

---

## Observação Importante sobre Armazenamento Efêmero (Planos Gratuitos)

No plano gratuito do Hugging Face Spaces (e do Render Free), o disco do container é **efêmero**:
- Se o container hibernar (após 48h sem uso no Hugging Face ou 15 min no Render) ou reiniciar, arquivos temporários, jobs em andamento e sessões salvas em disco (`.spotify-sessions.json`) são limpos.
- Basta clicar novamente em **Conectar Spotify** quando o servidor acordar (o botão funciona em 1 clique sem pedir configuração técnica).

---

## Método #2 (Alternativa): Render Manual (SEM Blueprint)

Caso tente o Render novamente: **não use "New Blueprint Instance"**, pois o fluxo de Blueprint costuma exigir validação de cartão em contas novas. Em vez disso:
1. No painel do Render, clique em **New + → Web Service** (manual).
2. Conecte `feliperetmal/musicflow-downloader`, escolha **Docker** e selecione **Free (\$0/month)**.
3. Configure manualmente as variáveis `NODE_ENV=production`, `PORT=4000`, `CORS_ORIGIN=https://feliperetmal.github.io`, `FRONTEND_BASE_URL=https://feliperetmal.github.io/musicflow-downloader`, `SPOTIFY_CLIENT_ID=c18da041f1b648ed9fdec51b82717160`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI=https://<SEU-APP>.onrender.com/auth/spotify/callback`, `WORKER_CONCURRENCY=1`, `FFMPEG_THREADS=1`, `TEMP_FILE_TTL_MINUTES=30`.

---

## Comparativo Rápido

| Plataforma | Cartão de Crédito? | RAM / CPU | Hibernação | Ideal para MusicFlow? |
| :--- | :--- | :--- | :--- | :--- |
| **Hugging Face Spaces (Docker)** | **NÃO** | **16 GB RAM / 2 vCPU** | 48 horas | ⭐ **Sim — melhor opção 100% gratuita e rápida** |
| **Render Free (Manual / Blueprint)** | Blueprint pode exigir | 512 MB RAM / 0.1 vCPU | 15 minutos | Limitado para playlists grandes |
| **Koyeb Free** | **SIM** (bloqueio de \$29) | 512 MB RAM / 0.1 vCPU | Escala a zero | Evitar se não quiser cadastrar cartão |
| **Hetzner Cloud VPS** | Sim (~€3,79/mês) | 4 GB RAM / 2 vCPU | Nunca hiberna | Melhor opção paga (com disco persistente real) |
