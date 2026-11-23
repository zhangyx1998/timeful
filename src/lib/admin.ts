/**
 * Whether this browser is the owner, as one reactive module-level fact.
 * It decides what is rendered, never what is allowed: every admin route is
 * gated by the session cookie regardless, and `fetchIsAdmin` fails closed
 * (ARCHITECTURE.md § Client wrapper). Re-probed, never assumed: sign-in and
 * sign-out both ask the server what the answer is now.
 */
import { readonly, ref } from "vue";
import { api, fetchAdminStatus, PASSWORD_ONLY, type LoginMethods } from "./api";

const authed = ref(false);
const methods = ref<LoginMethods>(PASSWORD_ONLY);

/** Reactive, read-only: only the two functions below may move it. */
export const isAdmin = readonly(authed);

/** How the owner may sign in here, from the same probe. */
export const loginMethods = readonly(methods);

/** Asks the server. Fails closed, so this can be called from anywhere. */
export async function refreshAdmin(): Promise<boolean> {
  const status = await fetchAdminStatus();
  authed.value = status.authed;
  methods.value = status.login;
  return authed.value;
}

// After a failed logout the cookie may or may not be gone; the re-probe settles it.
export async function adminLogout(): Promise<void> {
  try {
    await api.post("/api/auth/logout");
  } catch {
    // Signing out locally regardless; the re-probe below settles it.
  }
  await refreshAdmin();
}
