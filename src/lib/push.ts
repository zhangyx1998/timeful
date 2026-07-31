/**
 * The browser half of Web Push: feature detection, the service worker, the
 * subscription, and what this browser has asked to be told about.
 *
 * The server keeps no list a page could ask for — an endpoint is a secret,
 * so there is deliberately no `GET` for subscriptions — which means the
 * browser itself is the record of what it opted into. That record is a small
 * localStorage map of "event × role" markers beside the platform's own
 * `PushSubscription`. A marker without a live server-side subscription heals
 * itself: `resyncPush` re-registers on page load, so a subscription the
 * server pruned (or an endpoint the push service rotated) comes back without
 * anybody noticing it was gone.
 *
 * The permission prompt fires **only** from `enablePush`, which is only ever
 * called from an explicit click on the bell. Nothing here asks on page load.
 */
import {
  api,
  eventPushPath,
  request,
  type PushPublicKey,
  type PushRole,
} from "./api";

/** What one bell toggles: this browser, one event, one role. */
export interface PushBinding {
  /** The event's uuid — stable across renames, like every stored reference. */
  eventId: string;
  role: PushRole;
  /** The adopted identity; respondent bindings only. */
  userKey?: string;
}

/** The service worker that receives the pushes; see public/push-sw.js. */
export const PUSH_SW_PATH = "/push-sw.js";

const STORAGE_KEY = "timeful.push";

/**
 * Whether this page can offer push at all. All three gates are real: a
 * non-secure context has no service workers, iOS before home-screen install
 * has no `PushManager`, and either can be missing independently. Callers hide
 * the bell entirely when this is false — an explanation of why a feature
 * cannot work is chrome the page does not need.
 */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Permission is refused for good until the visitor changes it themselves. */
export function pushPermissionDenied(): boolean {
  return pushSupported() && Notification.permission === "denied";
}

// ---------------------------------------------------------------------------
// the local record
// ---------------------------------------------------------------------------

function markerKey(binding: PushBinding): string {
  return `${binding.eventId}:${binding.role}`;
}

/** The marker map, or empty when storage is unavailable or corrupt. */
function readMarkers(): Record<string, true> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, true>;
  } catch {
    return {};
  }
}

function writeMarkers(markers: Record<string, true>): void {
  try {
    if (Object.keys(markers).length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(markers));
  } catch {
    // Private mode: the toggle still works for this page's lifetime.
  }
}

/** Whether this browser opted in for this event and role. */
export function pushEnabled(binding: PushBinding): boolean {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  return markerKey(binding) in readMarkers();
}

// ---------------------------------------------------------------------------
// the platform subscription
// ---------------------------------------------------------------------------

/** The VAPID key in the shape `subscribe` wants. */
function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * One `PushSubscription` per origin, shared by every event this browser
 * follows: registering the worker is idempotent, and an existing subscription
 * is reused rather than re-minted.
 */
async function browserSubscription(): Promise<PushSubscription> {
  await navigator.serviceWorker.register(PUSH_SW_PATH);
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;
  const { key } = await api.get<PushPublicKey>("/api/push/public-key");
  return registration.pushManager.subscribe({
    // Required by every browser anyway, and true besides: each push shows a
    // notification, nothing runs silently.
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(key),
  });
}

/** The wire shape of a subscription, for the PUT and DELETE bodies. */
function wireSubscription(subscription: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const json = subscription.toJSON();
  return {
    endpoint: json.endpoint ?? subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
  };
}

/** Registers this browser's subscription with the server for one binding. */
async function putBinding(binding: PushBinding): Promise<void> {
  const subscription = await browserSubscription();
  const { endpoint, keys } = wireSubscription(subscription);
  await api.put(eventPushPath(binding.eventId), {
    role: binding.role,
    ...(binding.userKey === undefined ? {} : { userKey: binding.userKey }),
    endpoint,
    keys,
  });
}

// ---------------------------------------------------------------------------
// the three verbs
// ---------------------------------------------------------------------------

export type EnableResult = "on" | "denied" | "failed";

/**
 * The bell was pressed on. Asks for permission — this is the only call site
 * of the prompt, and it only ever runs from a click — then subscribes and
 * registers. "denied" is a state for the caller to render quietly, not an
 * error.
 */
export async function enablePush(binding: PushBinding): Promise<EnableResult> {
  if (!pushSupported()) return "failed";
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return "denied";
    await putBinding(binding);
  } catch {
    return "failed";
  }
  const markers = readMarkers();
  markers[markerKey(binding)] = true;
  writeMarkers(markers);
  return "on";
}

/**
 * The bell was pressed off. The server forgets this binding; the browser's
 * own subscription is kept while any other Timeful event still uses it and
 * withdrawn once nothing does.
 */
export async function disablePush(binding: PushBinding): Promise<void> {
  const markers = readMarkers();
  delete markers[markerKey(binding)];
  writeMarkers(markers);

  try {
    const registration = await navigator.serviceWorker.getRegistration(PUSH_SW_PATH);
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    // `request` rather than `api.del`, which carries no body: the DELETE
    // names the endpoint being forgotten, and the role that stops hearing.
    await request(eventPushPath(binding.eventId), {
      method: "DELETE",
      body: { role: binding.role, endpoint: subscription.endpoint },
    }).catch(() => undefined);
    if (Object.keys(readMarkers()).length === 0) await subscription.unsubscribe();
  } catch {
    // Unsubscribing is best-effort: the marker is gone, the toggle is off,
    // and a leftover server record delivers to a subscription that no longer
    // exists, which the push service will report and the server will prune.
  }
}

/**
 * Quietly re-registers a binding this browser believes in, healing a pruned
 * or rotated subscription. Called on page load when the marker is set and
 * permission is already granted — it never prompts.
 */
export async function resyncPush(binding: PushBinding): Promise<void> {
  if (!pushEnabled(binding)) return;
  try {
    await putBinding(binding);
  } catch {
    // Offline, or the event is gone: the next visit tries again.
  }
}
