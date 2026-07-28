<script setup lang="ts">
/**
 * Modal dialog: backdrop, Escape to close, focus moved to the panel, and the
 * page behind it locked so a touch scroll cannot run away underneath.
 *
 * Sized for phones first — the panel never exceeds the visual viewport
 * (`100dvh`, which excludes mobile browser chrome) and its body scrolls on its
 * own (ARCHITECTURE.md § UX bar).
 *
 * The `sheet` variant is the same dialog anchored to the bottom edge instead of
 * the middle: a drawer. It exists because the phone layout has no room to keep
 * secondary controls on screen, and everything a drawer needs — the backdrop,
 * Escape, the scroll lock, the focus move — is what this component already is.
 * A second component would have been the same behaviour with a different
 * `align-items`.
 */
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import IconClose from "../../assets/icons/close-sm.svg";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    dismissible?: boolean;
    /**
     * `sm` is a confirm or a short prompt; `lg` is a form with fields side by
     * side. Both stay within the viewport and scroll their own body.
     */
    size?: "sm" | "lg";
    /** `sheet` rises from the bottom edge, full width. */
    variant?: "modal" | "sheet";
  }>(),
  { dismissible: true, size: "sm", variant: "modal" },
);

const emit = defineEmits<{ close: [] }>();

const panel = ref<HTMLElement | null>(null);
let previousBodyOverflow = "";

function dismiss() {
  if (props.dismissible) emit("close");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") dismiss();
}

watch(
  () => props.open,
  (open) => {
    if (typeof document === "undefined") return;
    if (open) {
      document.addEventListener("keydown", onKeydown);
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      // Focus an [autofocus] element if the content marks one (dynamically
      // inserted nodes don't get native autofocus), else the panel itself.
      void nextTick(() => {
        const preferred = panel.value?.querySelector<HTMLElement>("[autofocus]");
        (preferred ?? panel.value)?.focus();
      });
    } else {
      document.removeEventListener("keydown", onKeydown);
      document.body.style.overflow = previousBodyOverflow;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (typeof document === "undefined") return;
  document.removeEventListener("keydown", onKeydown);
  if (props.open) document.body.style.overflow = previousBodyOverflow;
});
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="open" class="backdrop" :class="`backdrop--${variant}`" @pointerdown.self="dismiss">
        <div
          ref="panel"
          class="panel"
          :class="[`panel--${size}`, `panel--${variant}`]"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          tabindex="-1"
        >
          <span v-if="variant === 'sheet'" class="panel__grip" aria-hidden="true" />
          <header class="panel__head">
            <h2 class="panel__title">{{ title }}</h2>
            <button
              v-if="dismissible"
              type="button"
              class="panel__close"
              aria-label="Close"
              @click="emit('close')"
            >
              <IconClose aria-hidden="true" />
            </button>
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
  padding: 1rem;
  background: var(--color-backdrop);
}

.panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 26rem;
  max-height: calc(100dvh - 2rem);
  background: var(--color-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
}

/* Wide enough for the event form's three time selects to sit on one line at
   the width their own media query expects. */
.panel--lg {
  max-width: 42rem;
}

/* --- the drawer ---------------------------------------------------------- */

.backdrop--sheet {
  align-items: flex-end;
  padding: 0;
}

/* Full width, hinged on the bottom edge: rounded where it meets the page and
   square where it meets the screen, so it reads as having come up from there
   rather than as a card that happens to be low. */
.panel--sheet {
  max-width: none;
  max-height: 88dvh;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  border-width: 1px 0 0;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
}

/* The bar every drawer has. Purely a signal that this thing came from the
   bottom edge — the close button is what actually dismisses it. */
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

.panel__title {
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 600;
  line-height: 1.3;
}

.panel__close {
  display: grid;
  flex: none;
  place-items: center;
  width: 2rem;
  height: 2rem;
  margin: -0.25rem -0.4rem 0 0;
  color: var(--color-text-muted);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.panel__close svg {
  width: 16px;
  height: 16px;
}

.panel__close:hover {
  color: var(--color-text);
  background: var(--color-subtle);
}

.panel__close:focus-visible {
  outline: var(--focus-ring);
  outline-offset: calc(var(--focus-ring-offset) * -1);
}

@media (pointer: coarse) {
  .panel__close {
    width: var(--tap-min);
    height: var(--tap-min);
  }
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

/* A drawer travels its own height rather than a nudge: where it comes from is
   the whole of what it says. */
.dialog-enter-from .panel--sheet,
.dialog-leave-to .panel--sheet {
  transform: translateY(100%);
}

@media (prefers-reduced-motion: reduce) {
  .dialog-enter-active,
  .dialog-leave-active,
  .dialog-enter-active .panel,
  .dialog-leave-active .panel {
    transition: none;
  }

  .dialog-enter-from .panel,
  .dialog-leave-to .panel {
    transform: none;
  }
}
</style>
