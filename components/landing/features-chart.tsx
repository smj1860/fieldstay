// ============================================================================
// The par-level chart: the one NEW visualization on /features.
//
// It exists because "par levels that adjust themselves" is the least
// believable claim on the page. A table of par numbers proves nothing, because
// the reader cannot see movement. A line that visibly chases another line is
// the only format that shows it happening.
//
// EVERY NUMBER BELOW TRACES TO A REAL CONSTANT in lib/inventory/par-engine.ts:
// HISTORICAL_MIN_SAMPLES = 3 (why the step waits three counts) and
// HISTORICAL_BUFFER = 0.20 (why the gold line sits above the dashed one). The
// consumption series itself is ILLUSTRATIVE and the caption says so out loud.
// Inventing a plausible-looking metric and presenting it as measured is the
// one dishonest thing this page could do, and a sceptical PM would fixate on
// exactly that.
//
// Inline SVG rather than a chart library: two series, no interaction, and it
// must render in the initial HTML for a crawler.
//
// TWO LAYOUTS, NOT ONE SCALED SVG. A single 880-wide viewBox rendered into a
// 322px phone column scales every label by 0.37, so a `fontSize={12}` label
// reaches the screen at about 4px. That is invisible to a reader AND to a
// check: getComputedStyle reports the SVG USER UNIT (12), not the rendered
// size, so the naive assertion passes while the chart is unreadable. The wide
// and narrow layouts are therefore separate viewBoxes with their own padding,
// type sizes and label density, swapped with `hidden`/`sm:block` so both are
// in the initial HTML for a crawler.
// ============================================================================

interface Point { label: string; use: number; par: number }

/** Mar through Oct. `use` is illustrative; `par` is what the engine would derive from it. */
const SERIES: readonly Point[] = [
  { label: 'Mar', use: 6.2,  par: 8  },
  { label: 'Apr', use: 7.0,  par: 8  },
  { label: 'May', use: 9.4,  par: 8  },
  { label: 'Jun', use: 11.8, par: 8  },
  { label: 'Jul', use: 12.4, par: 12 },
  { label: 'Aug', use: 11.1, par: 12 },
  { label: 'Sep', use: 8.0,  par: 12 },
  { label: 'Oct', use: 6.8,  par: 9  },
]

interface Layout {
  w: number
  h: number
  pad: { top: number; right: number; bottom: number; left: number }
  font: number
  /** Indices of the x labels to draw. The narrow layout drops half of them. */
  labelAt: readonly number[]
}

const WIDE: Layout = {
  w: 880, h: 300,
  pad: { top: 24, right: 96, bottom: 44, left: 48 },
  font: 13,
  labelAt: [0, 1, 2, 3, 4, 5, 6, 7],
}

/**
 * Rendered into roughly a 322px column at 390px viewport, so the scale factor
 * is ~0.9 and a 13px user-unit label lands near 12px on screen. That is the
 * floor worth shipping; the wide layout's own 13 would arrive at 4.8px here.
 */
const NARROW: Layout = {
  w: 360, h: 300,
  pad: { top: 20, right: 54, bottom: 40, left: 34 },
  font: 13,
  labelAt: [0, 3, 5, 7],
}

const Y_MAX = 16

function ChartSvg({ layout }: Readonly<{ layout: Layout }>) {
  const { w, h, pad, font, labelAt } = layout
  const plotW = w - pad.left - pad.right
  const plotH = h - pad.top - pad.bottom

  const x = (i: number) => pad.left + (i / (SERIES.length - 1)) * plotW
  const y = (v: number) => pad.top + plotH - (v / Y_MAX) * plotH

  const usePath = SERIES.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.use)}`).join(' ')

  // A STEP path, not a smooth one: the engine changes a par level at a moment,
  // from one integer to another. A slope would imply a continuous drift the
  // product does not do.
  const parPath = SERIES.reduce<string>((d, p, i) => (
    i === 0 ? `M${x(0)},${y(p.par)}` : `${d} L${x(i)},${y(SERIES[i - 1]!.par)} L${x(i)},${y(p.par)}`
  ), '')

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" aria-hidden="true" style={{ display: 'block', overflow: 'visible' }}>
      {[0, 4, 8, 12, 16].map((v) => (
        <g key={v}>
          <line x1={pad.left} x2={pad.left + plotW} y1={y(v)} y2={y(v)}
                stroke="var(--mkt-ed-on-ink)" strokeOpacity={v === 0 ? 0.35 : 0.12} strokeWidth={1} />
          <text x={pad.left - 8} y={y(v) + font / 3} textAnchor="end"
                fill="var(--mkt-ed-on-ink-soft)" fontSize={font}>{v}</text>
        </g>
      ))}

      {SERIES.map((p, i) => labelAt.includes(i) && (
        <text key={p.label} x={x(i)} y={h - pad.bottom / 3} textAnchor="middle"
              fill="var(--mkt-ed-on-ink-soft)" fontSize={font}>{p.label}</text>
      ))}

      {/* Dashed and smooth = what happened. Distinguished from the par line by
          SHAPE as well as colour, so it survives greyscale and colour blindness. */}
      <path d={usePath} fill="none" stroke="var(--mkt-ed-on-ink-soft)" strokeWidth={2} strokeDasharray="5 4" />
      {SERIES.map((p, i) => (
        <circle key={p.label} cx={x(i)} cy={y(p.use)} r={3} fill="var(--mkt-ed-on-ink-soft)" />
      ))}

      {/* Solid and stepped = what FieldStay set. */}
      <path d={parPath} fill="none" stroke="var(--mkt-gold)" strokeWidth={3} strokeLinejoin="round" />

      <text x={x(7) + 8} y={y(SERIES[7]!.par) + font / 3} fill="var(--mkt-gold)" fontSize={font} fontWeight={700}>Par</text>
      <text x={x(7) + 8} y={y(SERIES[7]!.use) + font / 3} fill="var(--mkt-ed-on-ink-soft)" fontSize={font}>Used</text>
    </svg>
  )
}

/**
 * THE TEXT ALTERNATIVE IS THE VISIBLE CAPTION, not a hidden aria-label, and
 * the SVGs are aria-hidden decoration.
 *
 * The first version put `role="img"` plus an aria-label on the <figure>. That
 * role makes an element's DESCENDANTS presentational, and the <figcaption> is
 * a descendant: a screen reader got the terse label and never the sentence
 * explaining what the chart proves, which is the part worth having. SonarQube
 * flagged the role; the hidden caption was the real defect under it.
 *
 * Its suggested fix, an <img alt>, is wrong for this chart specifically. These
 * are inline SVGs coloured from CSS custom properties, and var(--mkt-gold)
 * does not resolve inside an <img>. Dropping the role is the fix.
 *
 * So the caption now carries the SHAPE as well as the mechanism, which makes
 * it a complete alternative for someone who cannot see the lines, and a better
 * one than an aria-label for everyone else: it is visible, indexable, and
 * cannot silently rot the way an attribute nobody reads can.
 */
export function ParLevelChart() {
  return (
    <figure style={{ margin: 0 }}>
      <div className="hidden sm:block"><ChartSvg layout={WIDE} /></div>
      <div className="sm:hidden"><ChartSvg layout={NARROW} /></div>

      <figcaption
        style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--mkt-ed-on-ink-soft)', marginTop: 18, maxWidth: '62ch' }}
      >
        Bath towels per turnover at one property. Use climbs from about 6 in
        March to a peak above 12 in July, then falls back below 7 by October,
        and the par level follows it: holding at 8, stepping to 12 in July,
        easing to 9. Nobody edited a par level. Three real counts moved it, and
        the purchase order that went out that week ordered for 12 rather than 8.
        The gold line sits above actual use because the engine adds a 20 percent
        buffer. Illustrative figures, real behaviour.
      </figcaption>
    </figure>
  )
}
