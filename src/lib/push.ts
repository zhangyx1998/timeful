/**
 * The browser half of Web Push. There is deliberately no GET for
 * subscriptions — an endpoint is a secret — so a localStorage map of
 * "event × role" markers is the record of what this browser opted into;
 * `resyncPush` re-registers on load, healing anything the server pruned. The
 * permission prompt fires only from `enablePush`, only ever on a click.
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

// All three gates are real: a non-secure context has no service workers, and
// iOS before home-screen install has no PushManager. Callers hide the bell
// when false, except for the one case `pushBlock` names.
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** The one blocked case worth a control on screen. */
export type PushBlock = "install";

// An iPad wearing a desktop user agent reports itself as a Mac with a
// touchscreen; same sniff as `isMacPlatform` in lib/history.ts.
function isIosLike(): boolean {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/** Already opened from a home-screen icon, one way or the other. */
function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

// iOS delivers push only to a web app added to the home screen — the one
// block the visitor can fix. Every other blocked case shows no bell at all.
export function pushBlock(): PushBlock | null {
  if (typeof window === "undefined" || pushSupported()) return null;
  if (!window.isSecureContext) return null;
  if (!isIosLike() || isStandalone()) return null;
  return "install";
}

/** Permission is refused for good until the visitor changes it themselves. */
export function pushPermissionDenied(): boolean {
  return pushSupported() && Notification.permission === "denied";
}

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

/** The VAPID key in the shape `subscribe` wants. */
function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// One PushSubscription per origin, shared by every event this browser follows;
// an existing subscription is reused rather than re-minted.
async function browserSubscription(): Promise<PushSubscription> {
  await navigator.serviceWorker.register(PUSH_SW_PATH);
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;
  const { key } = await api.get<PushPublicKey>("/api/push/public-key");
  return registration.pushManager.subscribe({
    // Required by every browser anyway, and true besides.
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

export type EnableResult = "on" | "denied" | "failed";

/**
 * The bell was pressed on. The only call site of the permission prompt, and
 * only ever from a click; "denied" is a state to render quietly, not an error.
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
 * The bell was pressed off. The browser's own subscription is kept while any
 * other Timeful event still uses it and withdrawn once nothing does.
 */
export async function disablePush(binding: PushBinding): Promise<void> {
  const markers = readMarkers();
  delete markers[markerKey(binding)];
  writeMarkers(markers);

  try {
    const registration = await navigator.serviceWorker.getRegistration(PUSH_SW_PATH);
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    // `request` rather than `api.del`, which carries no body: the DELETE names
    // the endpoint and role being forgotten.
    await request(eventPushPath(binding.eventId), {
      method: "DELETE",
      body: { role: binding.role, endpoint: subscription.endpoint },
    }).catch(() => undefined);
    if (Object.keys(readMarkers()).length === 0) await subscription.unsubscribe();
  } catch {
    // Best-effort: a leftover server record delivers to a dead subscription,
    // which the push service reports and the server prunes.
  }
}

/** Heals a pruned or rotated subscription on page load; never prompts. */
export async function resyncPush(binding: PushBinding): Promise<void> {
  if (!pushEnabled(binding)) return;
  try {
    await putBinding(binding);
  } catch {
    // Offline, or the event is gone: the next visit tries again.
  }
}
