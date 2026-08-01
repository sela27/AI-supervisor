import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { FastifyServerOptions } from "fastify";

import { systemClock, type Clock } from "./clock.js";
import type { SupervisorConfig } from "./config.js";
import { buildApp } from "./http/app.js";
import type { Notifier } from "./notifications/notifier.js";
import { notifyOn } from "./notifications/sink.js";
import { webhookNotifier } from "./notifications/webhook.js";
import { createQueueEngine } from "./queue/engine.js";
import type { Runner } from "./runner/runner.js";
import { unavailableRunner } from "./runner/unavailable.js";
import { openStorage } from "./storage.js";
import { ghCli, type GhCommand } from "./tickets/gh.js";
import { openTicketSource } from "./tickets/source.js";

export interface SupervisorOptions {
  /** Everything the instance was configured with, file and environment together. */
  config: SupervisorConfig;
  /** Off by default so tests stay quiet; the real entrypoint turns it on. */
  logger?: FastifyServerOptions["logger"];
  /** Executes one Attempt. Tests substitute a fake so no Claude Code is launched. */
  runner?: Runner;
  /**
   * Time, which a usage-limit wait is made of. Real time unless a test hands over
   * a clock it can move itself — a weekly limit is not something to sit through.
   */
  clock?: Clock;
  /**
   * What carries a notification to a phone. The configured webhook unless a test
   * hands over one of its own — which is how a suite reads everything the
   * Supervisor said without a byte of it leaving the machine.
   */
  notifier?: Notifier;
  /**
   * How the Supervisor talks to GitHub. The real `gh` CLI unless a test hands
   * over one of its own, so a suite never reaches a live repository.
   */
  gh?: GhCommand;
}

export interface RunningSupervisor {
  /** Base URL the service is actually listening on, port included. */
  url: string;
  stop(): Promise<void>;
}

export const DATABASE_FILENAME = "supervisor.db";

export async function startSupervisor(options: SupervisorOptions): Promise<RunningSupervisor> {
  const { config } = options;
  const dataDir = resolve(config.dataDir);
  mkdirSync(dataDir, { recursive: true });

  const storage = openStorage(join(dataDir, DATABASE_FILENAME));
  const gh = options.gh ?? ghCli();
  const engine = createQueueEngine({
    runner: options.runner ?? unavailableRunner(),
    openSource: (selection) => openTicketSource(selection, gh),
    storage,
    clock: options.clock ?? systemClock(),
    // Whether an Event is worth telling anybody about is the settings' business
    // either way; only the delivery is ever stood in for.
    onEvent: notifyOn(
      config.notifications,
      options.notifier ?? webhookNotifier(config.notifications.webhook),
    ),
    attemptBudget: config.attemptBudget,
    review: config.review,
    safety: config.safety,
  });
  const app = buildApp({
    storage,
    engine,
    defaults: config.defaults,
    gh,
    logger: options.logger,
  });

  try {
    // Before the first request can be answered, so that whatever this instance
    // says about its queue is the truth from the moment it says anything at all.
    await engine.recover();
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    storage.close();
    throw error;
  }

  return {
    url: resolveUrl(app.addresses()),
    stop: async () => {
      // The run first: it is the one thing here that would go on writing to
      // storage after storage had been closed under it.
      engine.shutDown();
      await app.close();
      storage.close();
    },
  };
}

function resolveUrl(addresses: { address: string; port: number }[]): string {
  const address = addresses[0];
  if (!address) {
    throw new Error("Supervisor started but is not listening on any address");
  }
  return `http://${dialableHost(address.address)}:${address.port}`;
}

function dialableHost(address: string): string {
  // Wildcard binds are not dialable; report a concrete loopback host instead.
  if (address === "0.0.0.0" || address === "::") return "127.0.0.1";
  return address.includes(":") ? `[${address}]` : address;
}
