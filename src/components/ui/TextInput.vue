<script setup lang="ts">
// Labelled text field; extra attributes fall through to the <input>.
// The border lives on a wrapper so a `prefix` slot can sit inside the box.
import { computed, useAttrs, useId } from "vue";

const model = defineModel<string>({ required: true });

const props = withDefaults(
  defineProps<{
    label?: string;
    /** Explicit id; otherwise one is generated (stable across SSR/CSR). */
    id?: string;
    error?: string;
    invalid?: boolean;
  }>(),
  { label: "", id: "", error: "", invalid: false },
);

defineOptions({ inheritAttrs: false });

// class/style stay on the wrapper — what a caller means by `<TextInput class="…">`.
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

/* Wrong beats focused: the caret is normally still in the field being told what is wrong. */
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

/* Left-truncation: `dir="rtl"` moves the ellipsis to the front; the `bdi` keeps the text reading LTR. */
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

/* Basis + floor, not width:100%: the input takes the leftovers and stops giving ground at 12ch. */
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
    /* iOS Safari auto-zooms any focused text control under 16px. */
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
