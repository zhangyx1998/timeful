/**
 * The push subscription store: `var/push.json` through the storage layer.
 *
 * One file for all events rather than a field on the event document, because
 * the event document is public to every link-holder — it is inlined into the
 * SSR page byte for byte — and an endpoint URL is a capability to message
 * somebody's browser. Keeping subscriptions out of the document means no new
 * exception to `publicEvent` and nothing new that could leak through it.
 *
 * Endpoints are treated like session tokens: stored, matched, pruned — never
 * logged, never served.
 */
import { readPushStore, updatePushStore } from "../storage.ts";
import type { PushRole, PushSubscriptionRecord } from "../types.ts";

/**
 * A ceiling per event, so a link-holder cannot grow `var/push.json` without
 * bound: the endpoint is attacker-suppliable and the route is public by
 * design. Generous — an event with two hundred subscribed browsers is a
 * hundred-person event where everybody subscribed twice.
 */
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

/**
 * Adds or replaces a subscription. Returns false when the event is at its
 * ceiling and this endpoint is not already among the subscribers.
 */
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

/**
 * Drops endpoints a push service has declared dead (404/410 on delivery) —
 * across every event, because a gone browser is gone for all of them.
 */
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
