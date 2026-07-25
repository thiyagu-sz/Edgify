import * as Sentry from "@sentry/nextjs";

/**
 * The single logging entry point for the app (AGENTS.md: "No console.log in committed code").
 *
 * Writes one structured JSON line per event to stdout/stderr — Cloud Run captures both as
 * logs — and forwards errors to Sentry. The user never sees any of this; it is the "you see
 * everything" half of docs/04-resilience.md §8. Never log secrets or raw document text.
 */

export type LogFields = Record<string, unknown>;

function serializeError(error: unknown): LogFields | undefined {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { value: String(error) };
}

function emit(
  stream: NodeJS.WriteStream,
  level: string,
  message: string,
  fields?: LogFields,
): void {
  const line =
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...fields,
    }) + "\n";
  stream.write(line);
}

export const log = {
  debug(message: string, fields?: LogFields): void {
    emit(process.stdout, "debug", message, fields);
  },
  info(message: string, fields?: LogFields): void {
    emit(process.stdout, "info", message, fields);
  },
  warn(message: string, fields?: LogFields): void {
    emit(process.stderr, "warn", message, fields);
  },
  /**
   * Log an error to stderr AND forward it to Sentry. Pass the caught value as `error` so the
   * stack is preserved; `fields` adds structured context (operation, userId, tier, …).
   */
  error(message: string, error?: unknown, fields?: LogFields): void {
    emit(process.stderr, "error", message, {
      ...fields,
      error: serializeError(error),
    });
    Sentry.captureException(error ?? new Error(message), {
      extra: { message, ...(fields ?? {}) },
    });
  },
};
