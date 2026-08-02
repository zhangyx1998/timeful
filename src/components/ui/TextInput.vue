<script setup lang="ts">
/**
 * Labelled text field. Any extra attribute (type, autocomplete, required,
 * maxlength, placeholder, …) falls through to the <input>, so callers keep
 * using plain HTML attributes.
 *
 * The border lives on a wrapper rather than on the `<input>` so that a `prefix`
 * slot can sit *inside* the box: fixed text the field's value continues, like
 * the origin an event's path is appended to. Without it the prefix would have
 * to be a separate bordered box, which reads as a second field rather than as
 * one value with a fixed head.
 */
import { computed, useAttrs, useId } from "vue";

const model = defineModel<string>({ required: true });

const props = withDefaults(
  defineProps<{
    label?: string;
    /** Explicit id; otherwise one is generated (stable across SSR/CSR). */
    id?: string;
    /** Shown under the field, and marks it invalid. */
    error?: string;
    invalid?: boolean;
  }>(),
  { label: "", id: "", error: "", invalid: false },
);

defineOptions({ inheritAttrs: false });

// Attributes go to the <input>, except `class` and `style`: those belong to the
// wrapper, which is what a caller means by `<TextInput class="…">` (and what
// lets a caller size the field inside a flex row).
const attrs = useAttrs();
const inputAttrs = computed(() => {
  const { class: _class, style: _style, ...rest } = attrs;
  return rest;
});

const generatedId = useId();
const inputId = computed(() => props.id || generatedId);
const isInvalid = computed(() => props.invalid || props.error.length > 0);
const messageId = computed(() => `${inputId.value}-message`);
</script>

<template>
  <div class="text-field" :class="attrs.class" :style="attrs.style">
    <label v-if="label" class="text-field__label" :for="inputId">{{ label }}</label>
    <div
      class="text-field__control"
      :class="{ 'text-field__control--invalid': isInvalid }"
    >
      <!-- Inert: clicking the fixed head puts the caret in the field, which is
           the only thing here you can actually type into. -->
      <span v-if="$slots.prefix" class="text-field__prefix" aria-hidden="true">
        <slot name="prefix" />
      </span>
      <input
        :id="inputId"
        v-model="model"
        class="text-field__input"
        :aria-invalid="isInvalid || undefined"
        :aria-describedby="error ? messageId : undefined"
        v-bind="inputAttrs"
      />
      <!-- A control that acts on the value, kept on the value's own row rather
           than beside the whole field — where a validation message underneath
           would push it out of line with the input it belongs to. -->
      <span v-if="$slots.suffix" class="text-field__suffix">
        <slot name="suffix" />
      </span>
    </div>
    <p v-if="error" :id="messageId" class="text-field__message text-field__message--error">
      {{ error }}
    </p>
    <slot />
  </div>
</template>

<style scoped>
.text-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 0;
}

.text-field__label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-text);
}

/* The box. What used to be the input's own border, moved out one level so the
   prefix can share it. */
.text-field__control {
  display: flex;
  align-items: stretch;
  min-width: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.text-field__control:focus-within {
  border-color: var(--color-accent);
  box-shadow: var(--focus-shadow);
}

/* Wrong beats focused: with the field validated as it is typed, the caret is
   normally still in it when it is being told what is wrong. */
.text-field__control--invalid,
.text-field__control--invalid:focus-within {
  border-color: var(--color-danger);
}

.text-field__control--invalid:focus-within {
  box-shadow: var(--focus-shadow-danger);
}

.text-field__control:has(.text-field__input:disabled) {
  opacity: var(--disabled-opacity);
}

/* Truncates from the *left* when there is not enough room: the end of an origin
   is the part that identifies it, and the scheme is the part you can afford to
   lose. `dir="rtl"` is what moves the ellipsis to the front; the `bdi` keeps
   the text itself reading left to right inside it. */
.text-field__prefix {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  min-width: 2.5rem;
  padding-left: 0.75rem;
  font-size: 0.875rem;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
}

/* Basis and floor rather than `width: 100%`. Asking for the whole control made
   the input's share unshrinkable in practice: every pixel a prefix wanted came
   out of the prefix, so an origin was being ellipsised next to a field with
   most of a row to spare. Now the input asks for a usable minimum, takes
   everything left over, and only stops giving ground at 12 characters — which
   is the point at which a prefix truncating is the lesser loss. */
.text-field__input {
  flex: 1 1 12ch;
  min-width: 12ch;
  min-height: 2.5rem;
  padding: 0.5rem 0.75rem;
  font: inherit;
  font-size: 0.875rem;
  color: var(--color-text);
  background: none;
  border: none;
  border-radius: inherit;
  outline: none;
}

/* The value continues the prefix, so nothing separates them. */
.text-field__prefix + .text-field__input {
  padding-left: 0.1rem;
}

.text-field__suffix {
  display: flex;
  flex: none;
  align-items: center;
  padding-right: 0.15rem;
}

@media (pointer: coarse) {
  .text-field__input {
    min-height: var(--tap-min);
    /* iOS Safari auto-zooms any focused text control under 16px; staying at
       1rem keeps the page still without forbidding the user to zoom. */
    font-size: 1rem;
  }
}

.text-field__input::placeholder {
  color: var(--color-text-muted);
}

.text-field__input:disabled {
  cursor: not-allowed;
}

.text-field__message {
  margin: 0;
  font-size: 0.75rem;
}

.text-field__message--error {
  color: var(--color-danger);
}
</style>
