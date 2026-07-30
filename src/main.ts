import { loadSupervisorConfig, type SupervisorConfig } from "./config.js";
import { messageOf } from "./errors.js";
import { claudeCodeRunner } from "./runner/claude-code.js";
import { startSupervisor } from "./supervisor.js";

const config = configOrExit();

const supervisor = await startSupervisor({
  config,
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

/** A settings mistake is the user's to fix; a stack trace only buries what to fix. */
function configOrExit(): SupervisorConfig {
  try {
    return loadSupervisorConfig();
  } catch (error) {
    console.error(messageOf(error));
    process.exit(1);
  }
}
