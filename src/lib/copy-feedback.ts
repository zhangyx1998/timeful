/**
 * Holds a copy verdict up for a moment. Failure is said as plainly as
 * success: on plain-http LAN deployments the copy genuinely can fail.
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
