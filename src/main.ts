import { loadSupervisorConfig } from "./config.js";
import { claudeCodeRunner } from "./runner/claude-code.js";
import { startSupervisor } from "./supervisor.js";

const config = loadSupervisorConfig();

const supervisor = await startSupervisor({
  dataDir: config.dataDir,
  port: config.port,
  host: config.host,
  logger: { level: config.logLevel },
  // The one place a real Claude Code Run is ever launched from.
  runner: claudeCodeRunner(config.runner),
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
