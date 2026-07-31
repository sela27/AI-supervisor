import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { FastifyServerOptions } from "fastify";

import { systemClock, type Clock } from "./clock.js";
import type { SupervisorConfig } from "./config.js";
import { noEvents, type EventSink } from "./events.js";
import { buildApp } from "./http/app.js";
import { createQueueEngine } from "./queue/engine.js";
import type { Runner } from "./runner/runner.js";
import { unavailableRunner } from "./runner/unavailable.js";
import { openStorage } from "./storage.js";

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
   * Where the moments worth telling somebody about go. Nothing consumes them yet;
   * notifications are their own ticket, and this is what they will be built on.
   */
  onEvent?: EventSink;
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
  const engine = createQueueEngine({
    runner: options.runner ?? unavailableRunner(),
    storage,
    clock: options.clock ?? systemClock(),
    onEvent: options.onEvent ?? noEvents,
    attemptBudget: config.attemptBudget,
  });
  const app = buildApp({
    storage,
    engine,
    defaults: config.defaults,
    logger: options.logger,
  });

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    storage.close();
    throw error;
  }

  return {
    url: resolveUrl(app.addresses()),
    stop: async () => {
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
