/**
 * Copying text to the clipboard, for the two places that hand out event URLs:
 * the admin's event list and the event page's copy-link button.
 *
 * `navigator.clipboard` only exists in a secure context, and a self-hosted
 * Timeful is often reached over plain http on a LAN, so the legacy
 * `execCommand("copy")` path is a real fallback rather than dead weight.
 * Returns whether the text made it — callers use that to decide whether to
 * claim success.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
