import { loadSupervisorConfig, type SupervisorConfig } from "./config.js";
import { messageOf } from "./errors.js";
import { deliver } from "./notifications/sink.js";
import { webhookNotifier } from "./notifications/webhook.js";
import { claudeCodeRunner } from "./runner/claude-code.js";
import { startSupervisor } from "./supervisor.js";

const config = configOrExit();
const notifier = webhookNotifier(config.notifications.webhook);

const supervisor = await startSupervisor({
  config,
  logger: { level: config.logLevel },
  // The one place a real Claude Code Run is ever launched from.
  runner: claudeCodeRunner(config.runner),
  notifier,
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

/**
 * The Supervisor going down under itself, as distinct from a run stopping under
 * it. Nothing is left standing to report this — not the API, not the dashboard —
 * so this is the one notification worth waiting for: the process holds on until
 * it has been said, or until saying it has plainly failed.
 */
for (const collapse of ["uncaughtException", "unhandledRejection"] as const) {
  process.once(collapse, (error: unknown) => {
    // The whole thing to the container's log, where there is room for a stack;
    // the notification carries only what is worth reading on a phone.
    console.error("The Supervisor is going down:", error);

    void deliver(config.notifications, notifier, {
      type: "supervisor-crashed",
      error: messageOf(error),
    })
      .catch(() => {})
      .then(() => process.exit(1));
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
