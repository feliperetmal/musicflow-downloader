import { createWorkerApp } from './app.js';
import { loadConfig } from './config.js';
import { log } from './logger.js';
import { ensureTempDirectories } from './services/cleanup.js';
import { startLocalSpotifyCallbackServer } from './services/spotify-auth.js';

async function main(): Promise<void> {
  const config = loadConfig();
  await ensureTempDirectories(config);

  const { app, queue, authService } = createWorkerApp(config);
  queue.startReaper();

  const callbackServer = startLocalSpotifyCallbackServer(authService, config);

  const server = app.listen(config.port, () => {
    log('info', `MusicFlow Worker v${config.appVersion} iniciado na porta ${config.port}`, {
      concurrency: config.concurrency,
      maxUploadBytes: config.maxUploadBytes,
      maxDurationSeconds: config.maxDurationSeconds,
      spotifyClientConfigured: Boolean(config.spotifyClientId),
      spotifySecretConfigured: Boolean(config.spotifyClientSecret),
      youtubeOfficialApi: Boolean(config.youtubeApiKey),
    });
  });

  const gracefulShutdown = async (signal: string) => {
    log('info', `Encerrando worker (${signal})...`);
    callbackServer?.close();
    server.close();
    await queue.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
}

main().catch((err) => {
  log('error', 'Falha fatal ao iniciar MusicFlow Worker', { error: err });
  process.exit(1);
});
