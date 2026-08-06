<script setup lang="ts">
// Modal dialog: focus trap, scroll lock, viewport-capped body scroll (ARCHITECTURE.md § UX bar).
// `sheet` is the same dialog anchored to the bottom edge: a drawer.
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import IconButton from "./IconButton.vue";
import IconClose from "../../assets/icons/close-sm.svg";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    dismissible?: boolean;
    size?: "sm" | "lg";
    variant?: "modal" | "sheet";
    /** Refuse every dismissal for a moment (one is already on its way); unlike
     *  `dismissible: false` the close button stays rendered, just disabled. */
    locked?: boolean;
    /** Undimmed backdrop for a drawer that just changed what the page shows. */
    dim?: boolean;
  }>(),
  { dismissible: true, size: "sm", variant: "modal", dim: true, locked: false },
);

const emit = defineEmits<{ close: [] }>();

defineSlots<{
  default?: () => unknown;
  icon?: () => unknown;
}>();

const panel = ref<HTMLElement | null>(null);

// Module-scope refcount: dialogs stack, and only the last to close unlocks.
// The root element is locked too — body{overflow:hidden} alone does not stop touch scroll.
let locks = 0;
let previousOverflow: { root: string; body: string; pad: string } | null = null;

// Module scope: a stacked dialog restores focus to whatever was focused when it
// opened. The restore also re-arms `history.ts`'s chart shortcuts after a confirm.
let opener: HTMLElement | null = null;

function lockPage() {
  if (locks++ > 0) return;
  const root = document.documentElement;
  // Keep the hidden scrollbar's width as body padding or centred content jumps (ARCHITECTURE.md § Client model).
  const gutter = window.innerWidth - root.clientWidth;
  previousOverflow = {
    root: root.style.overflow,
    body: document.body.style.overflow,
    pad: document.body.style.paddingRight,
  };
  root.style.overflow = "hidden";
  document.body.style.overflow = "hidden";
  if (gutter > 0) document.body.style.paddingRight = `${gutter}px`;
}

function unlockPage() {
  if (locks === 0) return;
  locks -= 1;
  if (locks > 0 || !previousOverflow) return;
  document.documentElement.style.overflow = previousOverflow.root;
  document.body.style.overflow = previousOverflow.body;
  document.body.style.paddingRight = previousOverflow.pad;
  previousOverflow = null;
}

function dismiss() {
  if (props.dismissible && !props.locked) emit("close");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") dismiss();
  else if (event.key === "Tab") containTab(event);
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Keeps Tab inside the panel: aria-modal promises inertness nothing else enforces.
function containTab(event: KeyboardEvent) {
  const root = panel.value;
  const active = document.activeElement;
  // A dialog stacked on top runs its own trap; wrapping from underneath would yank focus out of it.
  if (!root || !(active instanceof HTMLElement) || !root.contains(active)) return;
  const tabbables = Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.getClientRects().length > 0,
  );
  if (tabbables.length === 0) {
    event.preventDefault();
    return;
  }
  const first = tabbables[0];
  const last = tabbables[tabbables.length - 1];
  if (!tabbables.includes(active)) {
    // With no [autofocus] focus starts on the panel itself: enter at one end rather than falling out.
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  }
}

// Keep the tapped field visible once the keyboard cap bites; a frame late
// because `--keyboard-inset` lands after focus on platforms that raise a keyboard.
function onFocusIn(event: FocusEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (!target.matches("input, textarea, select, [contenteditable]")) return;
  requestAnimationFrame(() => target.scrollIntoView({ block: "nearest" }));
}

watch(
  () => props.open,
  (open) => {
    if (typeof document === "undefined") return;
    if (open) {
      opener =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.addEventListener("keydown", onKeydown);
      lockPage();
      // Dynamically inserted nodes get no native autofocus. preventScroll: the
      // default would scroll the chart pane and drawer body under the finger.
      void nextTick(() => {
        const preferred = panel.value?.querySelector<HTMLElement>("[autofocus]");
        (preferred ?? panel.value)?.focus({ preventScroll: true });
      });
    } else {
      document.removeEventListener("keydown", onKeydown);
      unlockPage();
      restoreFocus();
    }
  },
  { immediate: true },
);

// isConnected: the drawer-to-identity chain can tear the opener down in the same tick.
function restoreFocus() {
  const back = opener;
  opener = null;
  if (back?.isConnected) back.focus({ preventScroll: true });
}

onBeforeUnmount(() => {
  if (typeof document === "undefined") return;
  document.removeEventListener("keydown", onKeydown);
  // `v-if` around the whole component is a way dialogs close.
  if (props.open) {
    unlockPage();
    restoreFocus();
  }
});
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div
        v-if="open"
        class="backdrop"
        :class="[`backdrop--${variant}`, { 'backdrop--clear': !dim }]"
        @pointerdown.self="dismiss"
      >
        <div
          ref="panel"
          class="panel"
          :class="[`panel--${size}`, `panel--${variant}`]"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          tabindex="-1"
          @focusin="onFocusIn"
        >
          <span v-if="variant === 'sheet'" class="panel__grip" aria-hidden="true" />
          <header class="panel__head">
            <div class="panel__lead">
              <span v-if="$slots.icon" class="panel__icon" aria-hidden="true">
                <slot name="icon" />
              </span>
              <h2 class="panel__title">{{ title }}</h2>
            </div>
            <IconButton
              v-if="dismissible"
              class="panel__close"
              size="xs"
              label="Close"
              :tooltip="false"
              :disabled="locked"
              @click="dismiss"
            >
              <IconClose aria-hidden="true" />
            </IconButton>
          </header>
          <div class="panel__body">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  /* --overlay-bottom = max(home indicator, keyboard) (tokens.css): centring in what is left lifts prompts off the keyboard. */
  padding: calc(1rem + var(--safe-top)) calc(1rem + var(--safe-right))
    calc(1rem + var(--overlay-bottom)) calc(1rem + var(--safe-left));
  background: var(--color-backdrop);
  transition: background var(--transition-med);
}

.backdrop--clear {
  background: transparent;
}

.panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 26rem;
  /* Capped so a form taller than the room above the keyboard scrolls in its own body. */
  max-height: calc(100dvh - 2rem - var(--safe-top) - var(--overlay-bottom));
  background: var(--color-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
}

/* Wide enough for the event form's three time selects on one line. */
.panel--lg {
  max-width: 42rem;
}

.backdrop--sheet {
  align-items: flex-end;
  padding: 0;
}

.panel--sheet {
  max-width: none;
  max-height: calc(88dvh - var(--safe-top));
  padding-right: var(--safe-right);
  /* Keyboard height as bottom padding, not a gap: the surface reaches the bottom edge while contents sit above the keys. */
  padding-bottom: var(--overlay-bottom);
  padding-left: var(--safe-left);
  border-width: 1px 0 0;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
}

.panel__grip {
  flex: none;
  width: 2.25rem;
  height: 0.25rem;
  margin: 0.5rem auto -0.25rem;
  background: var(--color-border-strong);
  border-radius: var(--radius-pill);
}

.panel:focus {
  outline: none;
}

.panel__head {
  display: flex;
  flex: none;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.25rem 0.5rem;
}

.panel__lead {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

.panel__icon {
  display: grid;
  flex: none;
  place-items: center;
  color: var(--color-text-muted);
}

.panel__icon :slotted(svg) {
  width: 1.05rem;
  height: 1.05rem;
}

/* `anywhere` + `min-width: 0`: an unbreakable name must not run under the close button. */
.panel__title {
  min-width: 0;
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.panel__close {
  --icon-button-glyph: 16px;

  margin: -0.25rem -0.4rem 0 0;
}

.panel__body {
  flex: 1 1 auto;
  padding: 0 1.25rem 1.25rem;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.dialog-enter-active,
.dialog-leave-active {
  transition: opacity 0.15s ease;
}

.dialog-enter-active .panel,
.dialog-leave-active .panel {
  transition: transform 0.18s ease;
}

.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}

.dialog-enter-from .panel,
.dialog-leave-to .panel {
  transform: translateY(0.75rem);
}

.dialog-enter-from .panel--sheet,
.dialog-leave-to .panel--sheet {
  transform: translateY(100%);
}

/* Global reduced-motion zeroes durations, but the start offset is not a transition property. */
@media (prefers-reduced-motion: reduce) {
  .dialog-enter-from .panel,
  .dialog-leave-to .panel {
    transform: none;
  }
}
</style>
