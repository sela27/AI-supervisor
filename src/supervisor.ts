import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { FastifyServerOptions } from "fastify";

import { buildApp } from "./http/app.js";
import { openStorage } from "./storage.js";

export interface SupervisorOptions {
  /** Directory holding the Supervisor's SQLite database. Created if missing. */
  dataDir: string;
  /** Port to listen on; 0 asks the OS for a free one (used by tests). */
  port: number;
  host: string;
  /** Off by default so tests stay quiet; the real entrypoint turns it on. */
  logger?: FastifyServerOptions["logger"];
}

export interface RunningSupervisor {
  /** Base URL the service is actually listening on, port included. */
  url: string;
  stop(): Promise<void>;
}

export const DATABASE_FILENAME = "supervisor.db";

export async function startSupervisor(options: SupervisorOptions): Promise<RunningSupervisor> {
  const dataDir = resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true });

  const storage = openStorage(join(dataDir, DATABASE_FILENAME));
  const app = buildApp({ storage, logger: options.logger });

  try {
    await app.listen({ port: options.port, host: options.host });
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
