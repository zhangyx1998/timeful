/** Small helpers shared by the route modules. */

/** Express 5 forwards rejected async handlers to the error middleware. */
export class BadRequest extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "BadRequest";
    this.status = status;
  }
}

/** Every property read off the result is `unknown` and must go through a validator. */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Express types params as `string | string[]`; none of our routes repeat a name. */
export function param(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** Event-scoped JSON routes look like page URLs; each marks itself for the error middleware. */
export function jsonRoute<T extends (...args: never[]) => unknown>(handler: T): T {
  return function marked(this: unknown, ...args: never[]) {
    const res = args[1] as { locals: Record<string, unknown> } | undefined;
    if (res?.locals) res.locals.jsonRoute = true;
    return handler.apply(this, args);
  } as T;
}

/** The `status` an error asks for, when it carries a usable one. */
export function statusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null || !("status" in err)) return undefined;
  const status = Number(err.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}
