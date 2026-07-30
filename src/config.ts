export interface SupervisorConfig {
  dataDir: string;
  port: number;
  host: string;
  logLevel: string;
}

const DEFAULTS: SupervisorConfig = {
  dataDir: "./data",
  port: 4317,
  host: "0.0.0.0",
  logLevel: "info",
};

/** Reads the Supervisor's settings from the environment. The only place env vars are read. */
export function loadSupervisorConfig(): SupervisorConfig {
  const env = process.env;
  return {
    dataDir: env.SUPERVISOR_DATA_DIR ?? DEFAULTS.dataDir,
    port: parsePort(env.SUPERVISOR_PORT) ?? DEFAULTS.port,
    host: env.SUPERVISOR_HOST ?? DEFAULTS.host,
    logLevel: env.SUPERVISOR_LOG_LEVEL ?? DEFAULTS.logLevel,
  };
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`SUPERVISOR_PORT must be an integer between 0 and 65535, got "${value}"`);
  }
  return port;
}
