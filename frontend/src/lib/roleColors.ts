// Role identity color-coding (2026-07-02): seats of different roles were
// indistinguishable at a glance — same font, same color everywhere. Each role gets a
// stable accent (background tint + border) keyed by its position in the doc's role
// list. The text itself stays in the normal ink tokens and the role NAME is always
// written out, so identity is never carried by color alone.
//
// The eight hues are a CVD-validated categorical palette in a fixed order (worst
// adjacent color-vision-deficiency ΔE 24.2 on white — checked with a validator, not
// by eye). Extra roles beyond eight wrap; the name label keeps them distinguishable.

export const ROLE_ACCENTS = [
  "#2a78d6", // blue
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
  "#e87ba4", // magenta
  "#eb6834", // orange
] as const;

/** The accent hex for a role, by its stable position in the doc's role list. */
export function roleAccent(
  roleId: string | null | undefined,
  roles: readonly { id: string }[],
): string | null {
  if (!roleId) return null;
  const i = roles.findIndex((r) => r.id === roleId);
  return i < 0 ? null : ROLE_ACCENTS[i % ROLE_ACCENTS.length];
}

/** Inline chip styling for a role accent: a light tint + a solid border edge. */
export function roleChipStyle(accent: string | null): React.CSSProperties | undefined {
  if (!accent) return undefined;
  return { backgroundColor: `${accent}1f`, borderInlineStartColor: accent };
}
