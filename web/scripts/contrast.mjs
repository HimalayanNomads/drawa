// Contrast check for every color scheme: resolves the tokens in tokens.css against each scheme's 13 base colors
// (schemes.css) the way the browser does, and prints the WCAG ratio of each pair the UI actually draws.
// Run: node scripts/contrast.mjs [styles dir]   (exits 1 if a pair is under its minimum)
// ponytail: evaluates only the color syntax tokens.css uses (hex, oklch(), color-mix in oklab, relative oklch with
// min/max/clamp/calc); a new form there needs a line in color() below.
import { readFileSync } from 'node:fs'

const dir = process.argv[2] ?? new URL('../src/styles/', import.meta.url).pathname
const css = f => readFileSync(`${dir}/${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const decls = body => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+?)\s*(?=;|$)/g)].map(m => [m[1], m[2]]))
const blocks = src => [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), d: decls(m[2]) }))

const schemes = {}
for (const b of blocks(css('schemes.css'))) for (const m of b.sel.matchAll(/data-scheme=([\w-]+)/g)) schemes[m[1]] = b.d
const tok = blocks(css('tokens.css'))
const light = Object.assign({}, ...tok.filter(b => b.sel === ':root').map(b => b.d))
const dark = Object.assign({}, ...tok.filter(b => b.sel === ':root[data-theme=dark]').map(b => b.d))

// --- color math: oklab <-> linear sRGB ---
const lin = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const gam = v => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
function rgbToLab([r, g, b]) {
  ;[r, g, b] = [r, g, b].map(lin)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
function labToRgb([L, a, b]) { // clipped to sRGB, as Chromium draws an out-of-gamut oklch
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(v => gam(Math.min(1, Math.max(0, v))))
}
const lch = ([L, a, b]) => [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360]
const fromLch = (L, C, H) => [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)]

// split at top-level separators (commas or spaces), ignoring those inside parentheses
function split(s, sep) {
  const out = []; let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(') depth++; else if (ch === ')') depth--
    if (depth === 0 && (sep === ',' ? ch === ',' : /\s/.test(ch))) { if (cur.trim()) out.push(cur.trim()); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
const num = (expr, env) => Function('l', 'c', 'h', 'min', 'max', 'clamp', `return ${expr.replace(/calc\(/g, '(')}`)(env.l, env.c, env.h, Math.min, Math.max, (a, v, b) => Math.min(b, Math.max(a, v)))

/** A color value (vars already substituted) as { lab, a }. */
function color(s) {
  s = s.trim()
  if (s === 'transparent') return { lab: [0, 0, 0], a: 0 }
  if (s[0] === '#') { const h = s.slice(1).length === 3 ? [...s.slice(1)].map(c => c + c).join('') : s.slice(1); return { lab: rgbToLab([0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)), a: 1 } }
  const fn = s.match(/^([\w-]+)\((.*)\)$/s)
  if (!fn) throw new Error(`can't read color: ${s}`)
  if (fn[1] === 'oklch' && fn[2].startsWith('from ')) {
    const [, origin, ...ch] = split(fn[2], ' ')
    const o = color(origin), [l, c, h] = lch(o.lab), env = { l, c, h }
    return { lab: fromLch(num(ch[0], env), num(ch[1], env), num(ch[2], env)), a: o.a }
  }
  if (fn[1] === 'oklch') { const [L, C, H] = split(fn[2].split('/')[0], ' ').map(Number); return { lab: fromLch(L, C, H), a: 1 } }
  if (fn[1] === 'color-mix') {
    const [, x, y] = split(fn[2], ',')
    const part = p => { const m = p.match(/^(.*?)\s+([\d.]+)%$/); return m ? [color(m[1]), +m[2] / 100] : [color(p), null] }
    let [c1, p1] = part(x), [c2, p2] = part(y)
    if (p1 == null) p1 = p2 == null ? 0.5 : 1 - p2
    const a = c1.a * p1 + c2.a * (1 - p1) // premultiplied, as CSS mixes
    return { lab: [0, 1, 2].map(i => (a ? (c1.lab[i] * c1.a * p1 + c2.lab[i] * c2.a * (1 - p1)) / a : 0)), a }
  }
  throw new Error(`can't read color: ${s}`)
}

function resolver(scheme, isDark) {
  const vars = { ...schemes['claude-light'], ...schemes[scheme], ...light, ...(isDark ? dark : {}) }
  const sub = s => { for (let i = 0; i < 20 && s.includes('var('); i++) s = s.replace(/var\((--[\w-]+)\)/g, (_, n) => { if (!(n in vars)) throw new Error(`${scheme}: ${n} undefined`); return vars[n] }); return s }
  return (name, fallback) => color(sub(name in vars ? vars[name] : fallback ?? `var(${name})`))
}
const Y = rgb => { const [r, g, b] = rgb.map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const over = (fg, bg) => { const f = labToRgb(fg.lab), b = labToRgb(bg.lab); return f.map((v, i) => v * fg.a + b[i] * (1 - fg.a)) }
const ratio = (fg, bg) => { const a = Y(over(fg, bg)), b = Y(labToRgb(bg.lab)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }

// [label, foreground token, background token, minimum]; `?fallback` stands in for tokens older stylesheets lack
const FOCUS = '--focus?color-mix(in oklab,var(--accent) 75%,transparent)', FIELD = '--field-edge?var(--line-2)'
const PAIRS = [
  ['muted/bg', '--muted', '--bg', 4.5], ['muted/sel', '--muted', '--sel', 4.5], ['muted/hover', '--muted', '--hover', 4.5], ['muted/code', '--muted', '--code', 4.5],
  ['on-accent', '--on-accent', '--accent', 4.5], ['on-danger', '--on-danger', '--danger', 4.5],
  ['focus/bg', FOCUS, '--bg', 3], ['focus/canvas', FOCUS, '--canvas', 3], ['field/bg', FIELD, '--bg', 3],
  ...['read', 'edit', 'write', 'run', 'add', 'del', 'warn', 'danger', 'accent-text'].map(k => [`${k}/bg`, `--${k}`, '--bg', 4.5]),
  ...['key', 'str', 'num', 'fn', 'com'].map(k => [`syn-${k}`, `--syn-${k}`, '--code', 4.5]),
  ['add/add-bg', '--add', '--add-bg', 4.5], ['del/del-bg', '--del', '--del-bg', 4.5], ['warn/warn-bg', '--warn', '--warn-bg', 4.5],
]

let fails = 0
const rows = []
for (const scheme of Object.keys(schemes)) {
  const r0 = resolver(scheme, false), isDark = Y(labToRgb(r0('--c-bg').lab)) < 0.2, get = resolver(scheme, isDark)
  const t = s => { const [n, fb] = s.split('?'); return get(n, fb) }
  for (const [label, fg, bg, min] of PAIRS) {
    const v = ratio(t(fg), t(bg))
    if (v < min) fails++
    rows.push({ scheme, label, v, min })
  }
}
const labels = PAIRS.map(p => p[0]), names = Object.keys(schemes)
if (process.argv.includes('--json')) console.log(JSON.stringify(rows))
else {
  const w = Math.max(...names.map(n => n.length))
  for (const label of labels) {
    const rs = rows.filter(r => r.label === label), low = rs.filter(r => r.v < r.min)
    const worst = rs.reduce((a, b) => (b.v < a.v ? b : a))
    console.log(`${label.padEnd(13)} min ${worst.v.toFixed(2).padStart(5)} (${worst.scheme.padEnd(w)})  ${low.length ? 'FAIL: ' + low.map(r => `${r.scheme} ${r.v.toFixed(2)}`).join(', ') : 'ok'}`)
  }
  console.log(fails ? `\n${fails} pair(s) under the minimum` : '\nevery pair passes')
}
process.exit(fails ? 1 : 0)
