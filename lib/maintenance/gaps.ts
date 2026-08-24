// Vacancy gaps — the one place that turns a booking list into free days.
//
// This was inlined in `computeVacancyGaps` (the Phase 18 cron), which asks the
// SCHEDULE-DRIVEN question: find the gaps, then see which maintenance items
// fall inside them. Scheduling an inspection asks the inverse — given the month
// this occurrence is due in, find a day in it the property is empty — and the
// answer has to come from the same derivation, or the two disagree about what
// "free" means and only one of them is right.
//
// Pure and dependency-free on purpose: every caller already batch-fetches the
// bookings it needs, and a leaf module can be exercised without a database.

/** A booking's occupied span. Blocks `[checkin_date, checkout_date)`. */
export interface BookingWindow {
  checkin_date:  string
  checkout_date: string
}

/**
 * A period with no booking on it.
 *
 * `start` is inclusive — a checkout day is free from that morning. `end` is
 * EXCLUSIVE, being the next guest's arrival. `end` is null when nothing follows,
 * and `days` is then the caller's open-ended horizon rather than a measured
 * span.
 */
export interface VacancyGap {
  start: string
  end:   string | null
  days:  number
}

const DAY_MS = 86_400_000

/** Midnight UTC for a `YYYY-MM-DD`, so arithmetic never crosses a DST seam. */
function dayMs(date: string): number {
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  )
}

function toDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Every gap between the given bookings.
 *
 * SORTS AND MERGES OVERLAPS ITSELF rather than trusting the caller's ORDER BY.
 * The version this replaces paired `bookings[i].checkout_date` with
 * `bookings[i + 1].checkin_date` over a list ordered by check-IN, which is only
 * the same thing when no two bookings overlap. Given A = Jan 1–20 and
 * B = Jan 5–10, it walked off the end at B and reported the property free from
 * Jan 10 — while A still had it. Carrying a running maximum checkout is what
 * makes "the last booking" mean the last one to END.
 *
 * `openEndedDays` is how far past the final checkout to call the property free;
 * there is no booking to bound it, so the caller's planning horizon does.
 *
 * `horizonStart`, when given, also emits the gap BEFORE the first booking.
 * `computeVacancyGaps` passes nothing — its gaps are by definition "after a
 * checkout" — so its output is unchanged. A month-scoped search needs it,
 * because a month entirely ahead of the next booking is the most vacant a
 * property ever gets and would otherwise produce no gap at all.
 */
export function deriveVacancyGaps(
  bookings:      BookingWindow[],
  openEndedDays: number,
  horizonStart?: string,
): VacancyGap[] {
  const sorted = [...bookings].sort((a, b) => a.checkin_date.localeCompare(b.checkin_date))
  const gaps: VacancyGap[] = []

  if (sorted.length === 0) {
    if (!horizonStart) return gaps
    return [{ start: horizonStart, end: null, days: openEndedDays }]
  }

  if (horizonStart && horizonStart < sorted[0]!.checkin_date) {
    gaps.push({
      start: horizonStart,
      end:   sorted[0]!.checkin_date,
      days:  Math.round((dayMs(sorted[0]!.checkin_date) - dayMs(horizonStart)) / DAY_MS),
    })
  }

  // The furthest checkout seen so far — the day the property actually frees up,
  // which an overlapping booking can push later than the current row's own.
  let freeFrom = sorted[0]!.checkout_date

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!
    if (next.checkin_date > freeFrom) {
      gaps.push({
        start: freeFrom,
        end:   next.checkin_date,
        days:  Math.round((dayMs(next.checkin_date) - dayMs(freeFrom)) / DAY_MS),
      })
    }
    if (next.checkout_date > freeFrom) freeFrom = next.checkout_date
  }

  gaps.push({ start: freeFrom, end: null, days: openEndedDays })
  return gaps
}

/** The `[first, last]` inclusive day pair of `date`'s calendar month. */
export function monthBounds(date: string): { first: string; last: string } {
  const year  = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  return {
    first: toDate(Date.UTC(year, month - 1, 1)),
    // Day 0 of the following month is the last day of this one, leap years
    // included.
    last:  toDate(Date.UTC(year, month, 0)),
  }
}

/**
 * The day in `target`'s month, inside a vacancy gap, nearest to `target`.
 *
 * NEVER LEAVES THE MONTH. The recurrence anchor in this codebase is emergent
 * from `(next_due_date, frequency)` — `calcNextDueDate` steps whole months from
 * the due date, so the calendar month IS the anchor. Nudging a quarterly
 * inspection from March 30th to April 2nd because that is where the gap was
 * would silently re-anchor the whole series to April, and the one after to July.
 * A booked month keeps its date.
 *
 * RETURNS `target` UNCHANGED WHEN THERE IS NOWHERE BETTER, and the two reasons
 * for that are indistinguishable by design: a property with no bookings at all
 * is free every day, and one booked solid through the month is free on none.
 * Both mean "the requested date is as good as any", which is the only decision
 * this function makes.
 *
 * Ties go to the EARLIER day — an inspection sooner is worth more than an
 * inspection later, and it leaves room to reschedule inside the same month.
 */
export function pickVacantDayInMonth(target: string, gaps: VacancyGap[]): string {
  const { first, last } = monthBounds(target)

  // Already free? Leave it. Moving a date that was fine is churn a PM would
  // read as the system second-guessing them.
  if (gaps.some((g) => isInGap(target, g))) return target

  let best: string | null = null

  for (const gap of gaps) {
    const window = clampGapToMonth(gap, first, last)
    if (!window) continue
    // Only the two edges can be nearest: `target` is outside this window (it
    // failed isInGap above), so the whole window lies on one side of it.
    best = nearerTo(target, best, window.from)
    best = nearerTo(target, best, window.to)
  }

  return best ?? target
}

/** The gap's usable days, intersected with the month. Null when they miss. */
function clampGapToMonth(
  gap:   VacancyGap,
  first: string,
  last:  string,
): { from: string; to: string } | null {
  // A null end is an open horizon: `days` past the checkout, and never past
  // the end of the month either way.
  const gapLast = gap.end
    ? toDate(dayMs(gap.end) - DAY_MS)
    : toDate(dayMs(gap.start) + (gap.days - 1) * DAY_MS)

  const from = gap.start > first ? gap.start : first
  const to   = gapLast   < last  ? gapLast   : last
  return from > to ? null : { from, to }
}

/** Whichever of the two is closer to `target`; a tie goes to the earlier day. */
function nearerTo(target: string, current: string | null, candidate: string): string {
  if (current === null) return candidate

  const candidateDistance = Math.abs(dayMs(candidate) - dayMs(target))
  const currentDistance   = Math.abs(dayMs(current)   - dayMs(target))

  if (candidateDistance < currentDistance) return candidate
  if (candidateDistance > currentDistance) return current
  return candidate < current ? candidate : current
}

function isInGap(day: string, gap: VacancyGap): boolean {
  if (day < gap.start) return false
  if (gap.end) return day < gap.end
  return dayMs(day) < dayMs(gap.start) + gap.days * DAY_MS
}
