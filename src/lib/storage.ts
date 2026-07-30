/**
 * The handful of things the event page remembers between visits, and the three
 * lines of defence around `localStorage` that every one of them needs.
 *
 * Private browsing, a full quota and a blocked third-party context all make
 * `localStorage` *throw* rather than return nothing, and none of what is kept
 * here is worth a broken page: a preference that does not persist is a smaller
 * problem than a scheduler that does not mount. So every access is wrapped, and
 * a failure reads as "nothing stored".
 */

/** Every key the app writes, in one place so two of them cannot collide. */
export const STORAGE_KEYS = {
  timezone: "timeful.timezone",
  guestName: "timeful.guestName",
  hour12: "timeful.hour12",
  bestTimes: "timeful.bestTimes",
  theme: "timeful.theme",
} as const;

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing: preferences simply do not persist.
  }
}

export function clearStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Private browsing: there was nothing stored to remove.
  }
}
