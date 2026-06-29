export interface OccupancyPeriod {
  rate:         number
  bookedNights: number
  totalNights:  number
}

export interface OccupancyMetrics {
  currentMonth:      OccupancyPeriod
  sameMonthLastYear: OccupancyPeriod | null
  rolling12Month:    OccupancyPeriod
}

function bookedNightsInPeriod(
  bookings: { checkin_date: string; checkout_date: string }[],
  periodStart: Date,
  periodEnd: Date
): number {
  return bookings.reduce((total, b) => {
    const checkin  = new Date(b.checkin_date)
    const checkout = new Date(b.checkout_date)
    const overlapStart = checkin  > periodStart ? checkin  : periodStart
    const overlapEnd   = checkout < periodEnd   ? checkout : periodEnd
    const nights = Math.max(0, (overlapEnd.getTime() - overlapStart.getTime()) / 86_400_000)
    return total + nights
  }, 0)
}

/**
 * propertyCount scales totalNights for portfolio aggregates — occupancy
 * for N properties over a period is booked_nights / (days_in_period * N).
 */
export function computeOccupancy(
  bookings: { checkin_date: string; checkout_date: string }[],
  selectedMonthStr: string, // 'YYYY-MM' format, already used by the portal
  propertyCount = 1
): OccupancyMetrics {
  const [year, month] = selectedMonthStr.split('-').map(Number)

  // Current month
  const monthStart = new Date(year!, month! - 1, 1)
  const monthEnd   = new Date(year!, month!, 1)
  const daysInMonth = (monthEnd.getTime() - monthStart.getTime()) / 86_400_000 * propertyCount
  const bookedCurrent = bookedNightsInPeriod(bookings, monthStart, monthEnd)

  // Same month last year — null if that period predates any booking history
  const lyStart = new Date(year! - 1, month! - 1, 1)
  const lyEnd   = new Date(year! - 1, month!, 1)
  const hasLastYearHistory = bookings.some((b) => new Date(b.checkout_date) > lyStart)
  const daysInLyMonth = (lyEnd.getTime() - lyStart.getTime()) / 86_400_000 * propertyCount
  const bookedLY = bookedNightsInPeriod(bookings, lyStart, lyEnd)

  // Rolling 12 months back from start of current month
  const rolling12Start = new Date(year!, month! - 13, 1)
  const rolling12End   = monthEnd
  const daysRolling12  = (rolling12End.getTime() - rolling12Start.getTime()) / 86_400_000 * propertyCount
  const bookedRolling  = bookedNightsInPeriod(bookings, rolling12Start, rolling12End)

  return {
    currentMonth: {
      rate:         Math.round((bookedCurrent / daysInMonth) * 100),
      bookedNights: Math.round(bookedCurrent),
      totalNights:  daysInMonth,
    },
    sameMonthLastYear: hasLastYearHistory ? {
      rate:         Math.round((bookedLY / daysInLyMonth) * 100),
      bookedNights: Math.round(bookedLY),
      totalNights:  daysInLyMonth,
    } : null,
    rolling12Month: {
      rate:         Math.round((bookedRolling / daysRolling12) * 100),
      bookedNights: Math.round(bookedRolling),
      totalNights:  Math.round(daysRolling12),
    },
  }
}
