/**
 * Typed result — no silent catches anywhere in Nexus.
 */
export type Ok<T> = { ok: true; value: T };
export type Err<E = NexusError> = { ok: false; error: E };
export type Result<T, E = NexusError> = Ok<T> | Err<E>;

export interface NexusError {
  code: string;
  message: string;
  cause?: string;
}

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = (code: string, message: string, cause?: unknown): Err => ({
  ok: false,
  error: {
    code,
    message,
    cause: cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause),
  },
});

/** Wrap an async operation into a Result instead of throwing. */
export async function tryAsync<T>(code: string, fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(code, e instanceof Error ? e.message : String(e), e);
  }
}
