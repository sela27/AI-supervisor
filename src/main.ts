import { loadSupervisorConfig } from "./config.js";
import { startSupervisor } from "./supervisor.js";

const config = loadSupervisorConfig();

const supervisor = await startSupervisor({
  ...config,
  logger: { level: config.logLevel },
});

console.log(`Supervisor listening on ${supervisor.url} (data: ${config.dataDir})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void supervisor.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("Failed to shut down cleanly:", error);
        process.exit(1);
      },
    );
  });
}
