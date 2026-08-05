/**
 * The states around a copy: what was just claimed, and for how long.
 *
 * `clipboard.ts` answers whether the text made it; this holds the answer up
 * for a moment so a control can say so — and says failure as plainly as
 * success, because on the plain-http LAN deployments this app is built for
 * the copy genuinely can fail, and a control that swallows that leaves the
 * host pasting nothing. Extracted from `CopyLinkButton` so the invite dialog
 * shows the identical "Copied"/"Couldn't copy" semantics rather than a
 * re-implementation of them.
 */
import { onBeforeUnmount, ref, type Ref } from "vue";
import { copyText } from "./clipboard";

/** How long a verdict stays on screen before the control goes idle again. */
const FEEDBACK_MS = 1500;

export interface CopyFeedback {
  /** The last copy landed, for the moment the feedback is up. */
  copied: Ref<boolean>;
  /** The last copy failed, for the same moment. */
  failed: Ref<boolean>;
  /** Copies, and raises exactly one of the two flags for `FEEDBACK_MS`. */
  copy(text: string): Promise<void>;
}

/** Composable: call during setup, so the timer dies with the component. */
export function useCopyFeedback(): CopyFeedback {
  const copied = ref(false);
  const failed = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy(text: string): Promise<void> {
    clearTimeout(timer);
    const ok = await copyText(text);
    copied.value = ok;
    failed.value = !ok;
    timer = setTimeout(() => {
      copied.value = false;
      failed.value = false;
    }, FEEDBACK_MS);
  }

  onBeforeUnmount(() => clearTimeout(timer));

  return { copied, failed, copy };
}
