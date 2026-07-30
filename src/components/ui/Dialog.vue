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
import IconButton from "./IconButton.vue";
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
    /**
     * Every way out, refused for a moment.
     *
     * Not the same as `dismissible: false`, which is about a dialog that has no
     * way out *at all* and so renders no close button. This is a dialog that
     * has one and is about to use it itself: the respondents drawer holds
     * still for half a second after an eye is pressed, so the toggle is seen to
     * move before the sheet goes down to reveal what it changed. A backdrop
     * tap, an Escape or the close button landing inside that window would
     * race the dismissal that is already coming, so all three do nothing —
     * and the button stays where it is, disabled rather than removed, because
     * a header that reflowed mid-transition would be its own glitch.
     */
    locked?: boolean;
    /**
     * Whether the page behind is veiled. A dialog is normally the only thing
     * being attended to, and the dim says so. A drawer that has just changed
     * what the page above it *shows* is the exception: veiling the thing it was
     * asked to look at would undo the asking. Everything else about it is
     * unchanged — the backdrop is still there and still dismisses.
     */
    dim?: boolean;
  }>(),
  { dismissible: true, size: "sm", variant: "modal", dim: true, locked: false },
);

const emit = defineEmits<{ close: [] }>();

defineSlots<{
  /** The dialog's contents. */
  default?: () => unknown;
  /** A glyph beside the title. See the note in the template. */
  icon?: () => unknown;
}>();

const panel = ref<HTMLElement | null>(null);

/**
 * The page's scroll lock, held by however many dialogs are open at once.
 *
 * Module scope rather than per-instance because there is one page and the last
 * dialog to close is the one that gives it back: counting means an instance
 * that opens while another is still closing cannot record "hidden" as the state
 * to restore and leave the page locked for good.
 *
 * Both elements are locked. `body { overflow: hidden }` on its own does not
 * stop a touch platform from dragging the document behind the dim — the root
 * element is what owns the viewport's scroll.
 */
let locks = 0;
let previousOverflow: { root: string; body: string } | null = null;

function lockPage() {
  if (locks++ > 0) return;
  const root = document.documentElement;
  previousOverflow = { root: root.style.overflow, body: document.body.style.overflow };
  root.style.overflow = "hidden";
  document.body.style.overflow = "hidden";
}

function unlockPage() {
  if (locks === 0) return;
  locks -= 1;
  if (locks > 0 || !previousOverflow) return;
  document.documentElement.style.overflow = previousOverflow.root;
  document.body.style.overflow = previousOverflow.body;
  previousOverflow = null;
}

function dismiss() {
  if (props.dismissible && !props.locked) emit("close");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") dismiss();
}

/**
 * Keeps the field you just tapped where you can see it.
 *
 * The panel is capped so that its body scrolls rather than sliding under the
 * keyboard, which means the field being typed into can be below the fold of a
 * box that has just shrunk. `block: "nearest"` is the whole of the ask: scroll
 * the least that makes it visible, and do nothing at all when it already is.
 *
 * A frame late, because the cap only bites once `--keyboard-inset` lands — and
 * the platforms that raise a keyboard do it after the focus, not before.
 */
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
      document.addEventListener("keydown", onKeydown);
      lockPage();
      // Focus an [autofocus] element if the content marks one (dynamically
      // inserted nodes don't get native autofocus), else the panel itself.
      // `preventScroll`, because the default is to scroll every scrollable
      // ancestor until the target is centred — and on the event page those
      // ancestors are the chart's pane and the drawer's own body, which would
      // jump under the finger the moment the dialog opened.
      void nextTick(() => {
        const preferred = panel.value?.querySelector<HTMLElement>("[autofocus]");
        (preferred ?? panel.value)?.focus({ preventScroll: true });
      });
    } else {
      document.removeEventListener("keydown", onKeydown);
      unlockPage();
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (typeof document === "undefined") return;
  document.removeEventListener("keydown", onKeydown);
  // Only if this instance is holding one; the count is shared.
  if (props.open) unlockPage();
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
              <!-- A glyph before the title, for a dialog whose *kind* is worth
                   saying twice: the owner's tools and the way into them both
                   wear the half-solid shield, so a sheet that rose from an
                   unlabelled navbar button still says whose it is. Absent for
                   every other dialog, which needs no such badge. -->
              <span v-if="$slots.icon" class="panel__icon" aria-hidden="true">
                <slot name="icon" />
              </span>
              <h2 class="panel__title">{{ title }}</h2>
            </div>
            <!-- No tooltip: a close cross reads as its own name, and a bubble
                 saying "Close" over it would be chrome on chrome. -->
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
  /* The dim covers the whole display; the panel it holds stays clear of
     whatever the display takes out of it — and, at the bottom, of the keyboard
     too. `--overlay-bottom` is the larger of the home indicator and whatever
     the keyboard is covering (tokens.css); because the panel is centred in what
     is left, growing this is what lifts a prompt off an open keyboard. */
  padding: calc(1rem + var(--safe-top)) calc(1rem + var(--safe-right))
    calc(1rem + var(--overlay-bottom)) calc(1rem + var(--safe-left));
  background: var(--color-backdrop);
  transition: background var(--transition-med);
}

/* Still a backdrop — it takes the tap that dismisses — but not a veil. */
.backdrop--clear {
  background: transparent;
}

.panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 26rem;
  /* Capped by the same inset, so a form taller than the room left above the
     keyboard scrolls inside its own body rather than sliding under it. */
  max-height: calc(100dvh - 2rem - var(--safe-top) - var(--overlay-bottom));
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
  /* It rises from the bottom edge, so it is the top of the display it has to
     stop short of — and in landscape, the cutout beside it. */
  max-height: calc(88dvh - var(--safe-top));
  padding-right: var(--safe-right);
  /* The keyboard's height as the sheet's own bottom padding, rather than a gap
     under it: the surface still reaches the bottom edge — a sheet floating a
     keyboard's height above the screen would read as a card, not a drawer —
     while everything in it sits above the keys. The cap above then bites on the
     body, which scrolls. */
  padding-bottom: var(--overlay-bottom);
  padding-left: var(--safe-left);
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

/* Icon and title read as one heading, so they travel together and give up room
   together when the close button takes its own. */
.panel__lead {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

/* Sized off the title beside it rather than off the tap grid: it is a badge on
   a heading, not a control. Muted, like every other place the same mark
   appears — what identifies it is the half-solid shape, not a colour. */
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

/* Titles are prose and wrap like prose — "Switch to Ada?" reading over two
   lines is fine. What is not fine is a title carrying a name with no space in
   it, which without `anywhere` cannot break at all and runs out under the close
   button. `min-width: 0` lets it be narrower than that unbreakable run. */
.panel__title {
  min-width: 0;
  margin: 0;
  font-size: 1.0625rem;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

/* Everything else about the close — the box, the hover, the disabled hold,
   the tap-floor growth — is IconButton's. Kept here: its bite into the
   header's padding, and the glyph size. */
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

/* A drawer travels its own height rather than a nudge: where it comes from is
   the whole of what it says. */
.dialog-enter-from .panel--sheet,
.dialog-leave-to .panel--sheet {
  transform: translateY(100%);
}

/* The global reduced-motion rule zeroes the durations; the *start offset* is
   not a transition property, so it is neutralised here or the panel would
   still paint one frame displaced before snapping into place. */
@media (prefers-reduced-motion: reduce) {
  .dialog-enter-from .panel,
  .dialog-leave-to .panel {
    transform: none;
  }
}
</style>
