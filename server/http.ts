/** Small helpers shared by the route modules. */

/**
 * An error carrying an HTTP status. Thrown from route handlers; Express 5
 * forwards rejected async handlers to the error middleware in `index.ts`.
 */
export class BadRequest extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "BadRequest";
    this.status = status;
  }
}

/**
 * Narrows an untrusted JSON body to something indexable. Every property read
 * off the result is `unknown` and must go through a validator.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Reads a route parameter. Express types every param as `string | string[]`
 * (a path may repeat a name); none of our routes do, so take the first value.
 */
export function param(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * Marks a route as answering in JSON, for the error middleware.
 *
 * `/api/*` is JSON by its prefix, but the event-scoped endpoints live on the
 * event's own path — `/<slug>/data`, `/<slug>/users/<key>` — which is
 * indistinguishable from a page URL by inspection. Rather than teach the error
 * handler the route table, each JSON route says so as it starts, and a request
 * that merely passed through the router on its way to the page handler never
 * sets it.
 */
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
