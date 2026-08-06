/**
 * Reading design tokens back out of the DOM. A naive `getPropertyValue()` is
 * useless here: the tokens are declared with `light-dark()`, and an
 * unregistered custom property keeps its declaration verbatim in the computed
 * style. So the value is resolved the way the browser paints it — assigned to
 * a throwaway element's `color` and read back as resolved rgb()/rgba().
 */
import { computed } from "vue";
import type { ComputedRef } from "vue";
import { useTheme } from "./theme";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Server-side/unresolved fallback; matches the light `--color-slot-available`. */
export const FALLBACK_SLOT_AVAILABLE: Rgb = { r: 0, g: 153, b: 76 };

function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** Parses computed-style rgb()/rgba() notations plus plain hex; alpha is discarded. */
export function parseCssColor(value: string): Rgb | null {
  const input = value.trim();
  if (input === "") return null;

  if (input.startsWith("#")) {
    const hex = input.slice(1);
    const expand = (part: string) => Number.parseInt(part.repeat(2), 16);
    if (hex.length === 3 || hex.length === 4) {
      return { r: expand(hex[0]), g: expand(hex[1]), b: expand(hex[2]) };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
      };
    }
    return null;
  }

  const match = /^rgba?\(([^)]+)\)$/i.exec(input);
  if (!match) return null;
  const parts = match[1]
    .split(/[\s,/]+/)
    .filter((part) => part !== "")
    .slice(0, 3)
    .map((part) =>
      part.endsWith("%") ? (Number.parseFloat(part) * 255) / 100 : Number.parseFloat(part),
    );
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
  return { r: clampChannel(parts[0]), g: clampChannel(parts[1]), b: clampChannel(parts[2]) };
}

/**
 * Resolves one custom property against the document root, as the browser would
 * paint it right now. Returns null on the server or when the token is unset.
 */
export function resolveTokenColor(name: string): Rgb | null {
  if (typeof document === "undefined") return null;
  const host = document.body ?? document.documentElement;
  if (!host) return null;

  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;visibility:hidden";
  probe.style.color = `var(${name})`;
  host.appendChild(probe);
  const resolved = window.getComputedStyle(probe).color;
  probe.remove();
  return parseCssColor(resolved);
}

/** `#rrggbb`, for the few places that need a colour as a string. */
export function rgbToHex({ r, g, b }: Rgb): string {
  const pair = (value: number) => clampChannel(value).toString(16).padStart(2, "0");
  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

/**
 * The heatmap base for the theme on screen. `setTheme()` writes `data-theme`
 * before moving the ref, so the probe always measures the new theme.
 */
export function useSlotBaseColor(): ComputedRef<Rgb> {
  const { theme } = useTheme();
  return computed<Rgb>(() => {
    // Referenced for the dependency, not the value.
    void theme.value;
    return resolveTokenColor("--color-slot-available") ?? FALLBACK_SLOT_AVAILABLE;
  });
}
