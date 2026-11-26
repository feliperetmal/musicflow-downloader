# MusicFlow Downloader 4.1 — Guia de Produção (Render Free) e Hospedagem

Este guia documenta a hospedagem gratuita do backend do **MusicFlow Downloader** no **Render Free (`plan: free`)** integrado ao frontend estático no **GitHub Pages**, com otimizações para 512 MB de RAM e 0.1 vCPU e documentação honesta de todas as limitações do plano gratuito.

---

## 1. Arquitetura de Produção

- **Frontend (GitHub Pages — Estático HTTPS)**: `https://feliperetmal.github.io/musicflow-downloader/`
  - Usa exclusivamente a variável pública de build `NEXT_PUBLIC_API_URL` (configurada no GitHub Actions).
  - Nenhum segredo administrativo (`WORKER_API_SECRET`, `SPOTIFY_CLIENT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY`) é exposto ao navegador ou salvo em `localStorage`.
- **Backend Worker (Docker HTTPS no Render Free)**: Node.js 20 + FFmpeg + FFprobe + `yt-dlp`.
  - Sessões individuais assinadas com HMAC-SHA256 (`POST /auth/session`, TTL 2h com rotação automática).
  - Isolamento estrito por usuário (`ownerId`) em uploads, jobs, SSE, downloads e ZIPs.
  - Tickets temporários assinados (HMAC, TTL 30 min) para downloads diretos compatíveis com **iPhone Safari** sem expor credenciais em query strings.
  - Otimizado para **512 MB RAM / 0.1 vCPU**: `WORKER_CONCURRENCY=1`, `FFMPEG_THREADS=1`, `TEMP_FILE_TTL_MINUTES=30`, `NODE_OPTIONS=--max-old-space-size=384`, cache LRU limitado (`MAX_METADATA_CACHE_ENTRIES=50`), limpeza automática de saídas excedentes (`MAX_STORED_OUTPUT_FILES=40`) e limite seguro de lote (`MAX_BATCH_JOBS=50`).

---

## 2. Limitações Reais do Render Free (Leia Antes de Usar)

O arquivo `render.yaml` está configurado exclusivamente com **`plan: free`** (US\$ 0/mês, sem contratação automática de plano pago):

| Recurso | Limite no Render Free | Impacto Real no MusicFlow |
| :--- | :--- | :--- |
| **Memória RAM / CPU** | **512 MB RAM / 0.1 vCPU** | Processamento em fila de 1 tarefa por vez (`WORKER_CONCURRENCY=1`, `FFMPEG_THREADS=1`), mantendo a qualidade solicitada (MP3/MP4) sem causar queda por falta de memória (OOM). Lotes ZIP são limitados a **50 faixas por vez** (`MAX_BATCH_JOBS=50`). |
| **Horas Gratuitas** | **750 horas/mês** por workspace | Suficiente para 1 serviço web rodando durante todo o mês (não adicione outros serviços no mesmo workspace). |
| **Hibernação (*Spin-down*)** | **Após 15 minutos** sem tráfego HTTP | O serviço hiberna automaticamente. A próxima requisição acorda o container em **~50–60 segundos** (*cold start*). O frontend já faz retry automático em `502/503/504` e avisa quando o servidor está acordando. |
| **Armazenamento Efêmero** | **Sem disco persistente** | **Todo arquivo local é apagado** quando o container hiberna, reinicia ou faz redeploy. Isso significa que **sessões Spotify salvas em disco (`.spotify-sessions.json`), jobs em andamento e arquivos temporários são perdidos após hibernação/reinício**, exigindo novo clique em **Conectar Spotify** (sem prometer continuidade após reinício sem banco externo). |
| **Cartão de Crédito** | **Não exigido inicialmente** no Render Free | Se os limites mensais (horas gratuitas ou banda) forem excedidos sem cartão cadastrado, o Render suspende o serviço em vez de cobrar. *Nota:* em alguns casos específicos de verificação anti-abuso de conta, o provedor pode solicitar validação de identidade/cartão; caso ocorra, veja as alternativas abaixo. |

---

## 3. Passo a Passo — Importar o Blueprint no Render Free

### Passo 3.1: Criar o Backend via Blueprint (`render.yaml`)
1. Acesse [dashboard.render.com/blueprints](https://dashboard.render.com/blueprints) e faça login com sua conta GitHub.
2. Clique em **New Blueprint Instance** e selecione o repositório `feliperetmal/musicflow-downloader` (branch `main`).
3. Confirme na tela de revisão que o serviço `musicflow-worker` aparece no plano **`Free` (\$0/month)** (não altere para Starter).
4. Preencha apenas as 2 variáveis marcadas como `sync: false`:
   - `SPOTIFY_CLIENT_SECRET`: *(cole o Client Secret privado do app `24` no Spotify Developer Dashboard)*
   - `SPOTIFY_REDIRECT_URI`: `https://<SEU-SERVICO>.onrender.com/auth/spotify/callback` *(ajuste `<SEU-SERVICO>` para o subdomínio atribuído pelo Render, ex.: `musicflow-worker.onrender.com`)*
5. Clique em **Apply** e aguarde a compilação do `Dockerfile` (pode levar 3–5 minutos no primeiro build).
6. Confirme que o backend responde em HTTPS:
   - `https://<SEU-SERVICO>.onrender.com/health`
   - `https://<SEU-SERVICO>.onrender.com/ready`

### Passo 3.2: Cadastrar a Redirect URI no Spotify Developer Dashboard
1. Acesse [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) e abra o aplicativo **`24`** (`c18da041f1b648ed9fdec51b82717160`).
2. Em **Settings → Redirect URIs**, cadastre exatamente:
   - `https://<SEU-SERVICO>.onrender.com/auth/spotify/callback` *(Produção HTTPS)*
   - `http://127.0.0.1:8888/callback` *(Desenvolvimento local)*
3. Clique em **Save**.
4. Enquanto o app estiver em **Development Mode**, certifique-se de que seu e-mail Spotify esteja listado em **Settings → User Management**.

### Passo 3.3: Conectar o GitHub Pages ao Backend HTTPS
1. No GitHub, abra `feliperetmal/musicflow-downloader` → **Settings → Secrets and variables → Actions**.
2. Na aba **Variables**, clique em **New repository variable**:
   - **Name:** `NEXT_PUBLIC_API_URL`
   - **Value:** `https://<SEU-SERVICO>.onrender.com` *(sem barra `/` no final)*
3. Acesse a aba **Actions** → **CI & Deploy MusicFlow to GitHub Pages** → **Run workflow** (branch `main`).
4. Aguarde o deploy concluir e acesse: `https://feliperetmal.github.io/musicflow-downloader/`.

---

## 4. Alternativas de Hospedagem (Caso Precise de Persistência ou Sem Hibernação)

| Provedor | Custo | Recursos | Diferencial |
| :--- | :--- | :--- | :--- |
| **Render Free** *(padrão no `render.yaml`)* | **\$0/mês** | 512 MB RAM / 0.1 vCPU | Gratuito sem cartão inicial; hiberna em 15 min e tem disco efêmero. |
| **Oracle Cloud Always Free (ARM)** | **\$0/mês** *(exige cartão p/ validação)* | Até 4 OCPU / 24 GB RAM / 200 GB disco | Disco persistente real e sem hibernação, mas exige cartão na criação da conta. |
| **Railway.app (Hobby)** | **\$5/mês** | CPU/RAM sob demanda | Sem hibernação; bom para picos de FFmpeg. |
| **Hetzner Cloud VPS (CX22)** | **~€3,79/mês (~R\$ 24)** | 2 vCPU / 4 GB RAM / 40 GB SSD | Disco persistente real (sessões Spotify preservadas por até 180 dias) e suporte completo a playlists de 500–1.000 músicas. |
