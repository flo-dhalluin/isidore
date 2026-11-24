import { loadSettings } from "./config.ts";
import { createApp } from "./server.ts";

async function main(): Promise<void> {
  const settings = loadSettings();
  const { app, capabilities } = await createApp(settings);
  // Warm OpenRouter model capabilities at startup (best-effort, bounded wait
  // so startup never stalls if OpenRouter is temporarily unreachable).
  await Promise.race([
    capabilities.ensureFresh(),
    new Promise((resolve) => setTimeout(resolve, 2_000).unref()),
  ]);
  await app.listen({ host: settings.host, port: settings.port });
  app.log.info(
    `isidore ready: state=${settings.stateDir} workers=${settings.maxWorkers} mode=${settings.piMode}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
