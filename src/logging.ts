import type { Logger } from './types.ts';

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, context: Record<string, unknown>, payload: Record<string, unknown> | Error): void {
  const base: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    ...context,
  };
  if (payload instanceof Error) {
    base.error = { name: payload.name, message: payload.message, stack: payload.stack };
  } else {
    Object.assign(base, payload);
  }
  // JSON-per-line to stderr. Bun.write returns a Promise; we don't await — log writes
  // are fire-and-forget and ordering between adjacent log lines is best-effort anyway.
  const line = JSON.stringify(base) + '\n';
  void Bun.write(Bun.stderr, line);
}

export function createJsonLogger(context: Record<string, unknown> = {}): Logger {
  const ctx = { ...context };
  return {
    info(event) {
      emit('info', ctx, event);
    },
    warn(event) {
      emit('warn', ctx, event);
    },
    error(event) {
      emit('error', ctx, event);
    },
    child(extra) {
      return createJsonLogger({ ...ctx, ...extra });
    },
  };
}

/** Discards everything. Useful for tests and the programmatic client default. */
export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
