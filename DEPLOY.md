# MusicFlow Downloader 4.1 — Guia de Produção, Segurança e Hospedagem Cloud

Este guia documenta a arquitetura de produção do **MusicFlow Downloader 4.1**, eliminando completamente a dependência do computador local (`localhost:4000`) e qualquer configuração manual por visitantes.

---

## 1. Arquitetura de Produção

- **Frontend (GitHub Pages — Estático HTTPS)**: `https://feliperetmal.github.io/musicflow-downloader/`
  - Usa exclusivamente a variável de build `NEXT_PUBLIC_API_URL` (definida pelo administrador no GitHub Actions).
  - Nenhum segredo administrativo (`WORKER_API_SECRET`, `SPOTIFY_CLIENT_SECRET`, `SESSION_SECRET`) é exposto ao navegador ou salvo em `localStorage`.
- **Backend Worker (Docker HTTPS em Cloud/VPS)**: Node.js 20 + FFmpeg + FFprobe + `yt-dlp`.
  - Sessões individuais de clientes assinadas com HMAC-SHA256 (`POST /auth/session`, TTL 2h com rotação automática).
  - Isolamento estrito por usuário (`ownerId`) em uploads, jobs, SSE, downloads e ZIPs.
  - Tickets temporários assinados (HMAC, TTL 30 min) para downloads diretos compatíveis com **iPhone Safari** sem expor tokens permanentes em query strings.
  - Tokens OAuth do Spotify persistidos com criptografia **AES-256-GCM** e escrita atômica em disco.
  - CORS estrito somente para a origem configurada em `CORS_ORIGIN` (`https://feliperetmal.github.io`), sem confiança no sufixo `.github.io` para autenticação.

---

## 2. Comparativo de Hospedagem Econômica para o Backend (Docker + FFmpeg)

| Provedor | Plano Recomendado | Custo Mensal | CPU / RAM | Armazenamento | Observações |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Render.com** (`render.yaml` pronto) | Free (testes) / Starter (produção) | \$0 (hiberna após 15 min) / **\$7/mês** | 0.5 vCPU / 512 MB RAM | Disco efêmero | Deploy em 1 clique via `render.yaml`, HTTPS automático, `/ready` nativo. |
| **Railway.app** | Hobby | **\$5/mês** (créditos incluídos) | Sob demanda até 8 GB RAM | Disco efêmero ou volume | Excelente para picos de FFmpeg e builds Docker automáticos via GitHub. |
| **Fly.io** | Shared CPU 1x + 512 MB | **~US\$ 3,50–5,50/mês** | 1 shared vCPU / 512 MB | Volume opcional (1 GB grátis/barato) | Baixa latência (região `gru` São Paulo disponível), HTTPS automático. |
| **Hetzner Cloud VPS** | CX22 (ou CPX11) | **~€3,79/mês (~R\$ 24)** | 2 vCPU / 4 GB RAM | 40 GB SSD NVMe + 20 TB tráfego | Melhor custo-benefício para playlists grandes (200–1.000 músicas) e volume persistente. |

---

## 3. Passo a Passo Completo de Deploy (Render — Mais Rápido)

### Passo 3.1: Publicar o Backend Docker no Render
1. Acesse [dashboard.render.com/blueprints](https://dashboard.render.com/blueprints) e conecte o repositório `feliperetmal/musicflow-downloader`.
2. O Render lerá automaticamente o arquivo `render.yaml` na raiz do repositório.
3. Preencha as 2 variáveis marcadas como privadas no painel do Render:
   - `SPOTIFY_CLIENT_SECRET`: *(obtido no Spotify Developer Dashboard do app `24`)*
   - `SPOTIFY_REDIRECT_URI`: `https://<SEU-SERVICO>.onrender.com/auth/spotify/callback`
4. Clique em **Apply** e aguarde o build do container Docker terminar.
5. Verifique os endpoints de saúde no navegador:
   - `https://<SEU-SERVICO>.onrender.com/health`
   - `https://<SEU-SERVICO>.onrender.com/ready`

### Passo 3.2: Cadastrar a Redirect URI no Spotify Developer Dashboard
1. Acesse [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) e abra o aplicativo **`24`** (`c18da041f1b648ed9fdec51b82717160`).
2. Em **Settings → Redirect URIs**, deixe cadastrado exatamente:
   - `https://<SEU-SERVICO>.onrender.com/auth/spotify/callback` *(Produção HTTPS)*
   - `http://127.0.0.1:8888/callback` *(Desenvolvimento local)*
3. Clique em **Save**.
4. **Atenção ao Development Mode:** Enquanto o aplicativo estiver em Development Mode no Spotify, adicione os e-mails das contas Spotify autorizadas em **Settings → User Management**.

### Passo 3.3: Conectar o Frontend (GitHub Pages) ao Backend HTTPS
1. No GitHub, abra `feliperetmal/musicflow-downloader` → **Settings → Secrets and variables → Actions**.
2. Na aba **Variables** (recomendado para URLs públicas), clique em **New repository variable**:
   - **Name:** `NEXT_PUBLIC_API_URL`
   - **Value:** `https://<SEU-SERVICO>.onrender.com` *(sem barra final)*
3. Execute o workflow **CI & Deploy MusicFlow to GitHub Pages** (na aba **Actions → Run workflow**) ou faça um `git push` na branch `main`.
4. O workflow executa typecheck, testes, compilação estática, auditoria de segurança do bundle (impedindo vazamento de segredos ou `localhost:4000`) e publica em:
   `https://feliperetmal.github.io/musicflow-downloader/`
