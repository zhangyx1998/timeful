/**
 * `var/push.json` via the storage layer. Kept out of the event document, which
 * is public to every link-holder; endpoints are treated like session tokens —
 * never logged, never served.
 */
import { readPushStore, updatePushStore } from "../storage.ts";
import type { PushRole, PushSubscriptionRecord } from "../types.ts";

/** Ceiling per event: the endpoint is attacker-suppliable and the route is public by design. */
export const MAX_SUBSCRIPTIONS_PER_EVENT = 200;

/** One browser, one role, one event: the identity a subscription upserts on. */
function matches(
  record: PushSubscriptionRecord,
  eventId: string,
  role: PushRole,
  endpoint: string,
): boolean {
  return (
    record.eventId === eventId && record.role === role && record.endpoint === endpoint
  );
}

/** Upserts; false when the event is at its ceiling and the endpoint is new. */
export async function saveSubscription(
  record: PushSubscriptionRecord,
): Promise<boolean> {
  let saved = false;
  await updatePushStore((store) => {
    const kept = store.subscriptions.filter(
      (entry) => !matches(entry, record.eventId, record.role, record.endpoint),
    );
    const forEvent = kept.filter((entry) => entry.eventId === record.eventId).length;
    if (forEvent >= MAX_SUBSCRIPTIONS_PER_EVENT) return undefined;
    saved = true;
    kept.push(record);
    return { subscriptions: kept };
  });
  return saved;
}

/** Removes one browser's subscription for one role. Idempotent. */
export function removeSubscription(
  eventId: string,
  role: PushRole,
  endpoint: string,
): Promise<unknown> {
  return updatePushStore((store) => {
    const kept = store.subscriptions.filter(
      (entry) => !matches(entry, eventId, role, endpoint),
    );
    if (kept.length === store.subscriptions.length) return undefined;
    return { subscriptions: kept };
  });
}

/** Every subscription that should hear about `eventId` in `role`. */
export async function subscriptionsFor(
  eventId: string,
  role: PushRole,
): Promise<PushSubscriptionRecord[]> {
  const store = await readPushStore();
  return store.subscriptions.filter(
    (entry) => entry.eventId === eventId && entry.role === role,
  );
}

/** Drops dead endpoints across every event — a gone browser is gone for all of them. */
export function pruneEndpoints(endpoints: ReadonlySet<string>): Promise<unknown> {
  if (endpoints.size === 0) return Promise.resolve();
  return updatePushStore((store) => {
    const kept = store.subscriptions.filter((entry) => !endpoints.has(entry.endpoint));
    if (kept.length === store.subscriptions.length) return undefined;
    return { subscriptions: kept };
  });
}

/** Drops every subscription for a deleted event. */
export function dropEventSubscriptions(eventId: string): Promise<unknown> {
  return updatePushStore((store) => {
    const kept = store.subscriptions.filter((entry) => entry.eventId !== eventId);
    if (kept.length === store.subscriptions.length) return undefined;
    return { subscriptions: kept };
  });
}
