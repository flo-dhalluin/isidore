import { loadSettings } from "./config.ts";
import { createApp } from "./server.ts";

async function main(): Promise<void> {
  const settings = loadSettings();
  const { app } = await createApp(settings);
  await app.listen({ host: settings.host, port: settings.port });
  app.log.info(
    `isidore ready: state=${settings.stateDir} workers=${settings.maxWorkers} mode=${settings.piMode}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
