/**
 * Minimal stderr logger (frozen plan §12 logging discipline): diagnostic logs
 * go to stderr ONLY, so the stdio MCP transport can keep stdout
 * protocol-pure. No logging framework — level filter via
 * PHASE_PLAN_LOG_LEVEL.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Readonly<Record<Exclude<LogLevel, "silent">, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function resolveLogLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return "info";
  }
  if (value === "silent" || value === "none" || value === "off") {
    return "silent";
  }
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  // Unrecognized values degrade to the default instead of failing the process;
  // a broken log level must never take down the MCP transport.
  return "info";
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type StderrWriter = (line: string) => void;

export function createLogger(level: LogLevel, write: StderrWriter = defaultStderrWrite): Logger {
  const emit = (threshold: Exclude<LogLevel, "silent">, message: string): void => {
    if (level === "silent") return;
    const configured = LEVEL_ORDER[level];
    if (LEVEL_ORDER[threshold] < configured) return;
    write(`[phase-plan] ${threshold}: ${message}\n`);
  };
  return {
    debug: (message) => emit("debug", message),
    info: (message) => emit("info", message),
    warn: (message) => emit("warn", message),
    error: (message) => emit("error", message),
  };
}

function defaultStderrWrite(line: string): void {
  process.stderr.write(line);
}
