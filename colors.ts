/**
 * OKLCH-based palette engine for colored-tabs.
 *
 * Rule set (agreed):
 *  - Color 0 is the theme accent itself (the input field's sidedash color).
 *  - Colors 1..9 are hue rotations of the accent (+36 deg per step), keeping
 *    the accent's lightness/chroma so they stay harmonious with the theme.
 *  - "Somewhat random, never similar": each session gets a deterministic
 *    hue jitter (<= +/-10 deg) and lightness jitter (<= 0.03) hashed from its
 *    session ID. Even with maximum jitter, two palette neighbors stay >= 16
 *    deg apart in hue, so no two open tabs look alike within one rotation.
 *  - After 10 colors the palette rotates (wrap-around).
 *
 * No imports: pure functions so the plugin has zero dependencies.
 */

export type Rgb = { r: number; g: number; b: number } // 0..255

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function srgbToOklch(r: number, g: number, b: number): { L: number; C: number; H: number } {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const R = lin(r / 255)
  const G = lin(g / 255)
  const B = lin(b / 255)

  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const b2 = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s

  const C = Math.sqrt(a * a + b2 * b2)
  let H = (Math.atan2(b2, a) * 180) / Math.PI
  if (H < 0) H += 360
  return { L, C, H }
}

export function oklchToRgb(L: number, C: number, H: number): Rgb {
  const rad = (H * Math.PI) / 180
  const a = C * Math.cos(rad)
  const b = C * Math.sin(rad)

  const l = L + 0.3963377774 * a + 0.2158037573 * b
  const m = L - 0.1055613458 * a - 0.0638541728 * b
  const s = L - 0.0894841775 * a - 1.291485548 * b

  const l3 = l * l * l
  const m3 = m * m * m
  const s3 = s * s * s

  const R = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
  const G = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
  const B = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3

  const gam = (c: number) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(clamp(c, 0, 1), 1 / 2.4) - 0.055
    return Math.round(clamp(v, 0, 1) * 255)
  }
  return { r: gam(R), g: gam(G), b: gam(B) }
}

/** Deterministic 32-bit hash of a string (FNV-1a). */
export function hashString(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Deterministic pseudo-random in [-1, 1] from a seed + salt. */
function seededUnit(seed: number, salt: number): number {
  let x = (seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return (x >>> 0) / 2147483648 - 1
}

export type PaletteAnchor = { L: number; C: number; H: number }

export const PALETTE_SIZE = 10

/**
 * Build the 10-color palette from an accent RGB.
 * Index 0 = the accent, verbatim. Rotations clamp chroma so pastel themes
 * do not produce neon tabs and dark themes keep tabs visible. Lightness
 * oscillates across the rotation so adjacent entries differ in both hue
 * and brightness — "never similar" even at low chroma.
 */
export function buildPalette(accent: Rgb): { hex: string; anchor: PaletteAnchor }[] {
  const { L, C, H } = srgbToOklch(accent.r, accent.g, accent.b)
  const safeC = clamp(C, 0.06, 0.14)
  const safeL = clamp(L, 0.55, 0.72)
  // lightness wave: 0,+0.10,-0.04,+0.14,+0.02,+0.12,-0.02,+0.08,-0.06,+0.06
  const wave = [0, 0.1, -0.04, 0.14, 0.02, 0.12, -0.02, 0.08, -0.06, 0.06]
  const out: { hex: string; anchor: PaletteAnchor }[] = []
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const anchor: PaletteAnchor = {
      L: clamp(safeL + wave[i], 0.45, 0.85),
      C: i % 3 === 2 ? clamp(safeC + 0.03, 0.06, 0.17) : safeC,
      H: (H + (360 / PALETTE_SIZE) * i) % 360,
    }
    out.push({ hex: rgbToHex(oklchToRgb(anchor.L, anchor.C, anchor.H)), anchor })
  }
  // Color 0 must be the exact accent color
  out[0] = { hex: rgbToHex(accent), anchor: { L: safeL, C: safeC, H } }
  return out
}

/** Apply per-session deterministic jitter to a palette entry. */
export function jitterFor(hex: string, anchor: PaletteAnchor, sessionID: string): Rgb {
  const seed = hashString(sessionID)
  const dH = seededUnit(seed, 1) * 10 // +/-10 deg hue
  const dL = seededUnit(seed, 2) * 0.03 // +/-0.03 lightness
  const dC = seededUnit(seed, 3) * 0.01 // +/-0.01 chroma
  const rgb = oklchToRgb(
    clamp(anchor.L + dL, 0.45, 0.85),
    clamp(anchor.C + dC, 0.05, 0.18),
    (anchor.H + dH + 360) % 360,
  )
  return rgb
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const h = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")
  return `#${h(r)}${h(g)}${h(b)}`
}

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { r: 200, g: 200, b: 200 }
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}
