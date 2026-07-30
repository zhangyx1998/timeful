/**
 * Whether this browser is the owner, as one reactive fact for the whole page.
 *
 * There is exactly one account and one page, so this is module state rather
 * than something passed down: the navbar, the sidebar's tools group and the
 * sign-in link at the bottom of it all have to agree, and threading a ref
 * through three components so they can agree about a global is ceremony.
 *
 * **Nothing rests on it.** It decides what is rendered, never what is allowed:
 * every admin route is gated by the session cookie regardless, and
 * `fetchIsAdmin` fails closed (ARCHITECTURE.md § Client wrapper), so a guest —
 * or anyone whose status call did not come back cleanly — sees nothing extra.
 *
 * **It is re-probed, never assumed.** Signing in and signing out both ask the
 * server what the answer is now rather than writing down what they expect it
 * to be: a login that half-succeeded, or a logout whose request never left,
 * must not leave the page showing controls it cannot use. That is also what
 * makes both of them work without a reload — the state is reactive, so the
 * tools appear and disappear where they stand.
 */
import { readonly, ref } from "vue";
import { api, fetchIsAdmin } from "./api";

const authed = ref(false);

/** Reactive, read-only: only the two functions below may move it. */
export const isAdmin = readonly(authed);

/** Asks the server. Fails closed, so this can be called from anywhere. */
export async function refreshAdmin(): Promise<boolean> {
  authed.value = await fetchIsAdmin();
  return authed.value;
}

/**
 * Signs out, then re-probes.
 *
 * The logout endpoint answers `{ ok: true }` whatever happened, and a network
 * failure is the interesting case: the cookie may or may not be gone, so the
 * only honest thing to do is ask again rather than assume either way.
 */
export async function adminLogout(): Promise<void> {
  try {
    await api.post("/api/auth/logout");
  } catch {
    // Signing out locally regardless; the re-probe below settles it.
  }
  await refreshAdmin();
}

/** Tests only: put the module back to how it starts. */
export function resetAdminState(): void {
  authed.value = false;
}
