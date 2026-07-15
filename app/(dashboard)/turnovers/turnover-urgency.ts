// Classifies a turnover's urgency for the board's color-coding. Replaces
// three separate chained-ternary color computations that used to live
// inline in TurnoverCard (border color, priority-indicator bar, and — via
// a different input domain — the checkout window color), each re-deriving
// the same overdue > urgent > high > medium priority ordering.

export type TurnoverUrgencyTone = 'overdue' | 'urgent' | 'high' | 'medium' | 'normal'

export function turnoverUrgencyTone(isOverdue: boolean, priority: string): TurnoverUrgencyTone {
  if (isOverdue) return 'overdue'
  if (priority === 'urgent') return 'urgent'
  if (priority === 'high') return 'high'
  if (priority === 'medium') return 'medium'
  return 'normal'
}

export const CARD_BORDER_CLASS: Record<TurnoverUrgencyTone, string> = {
  overdue: 'border-red-200 shadow-[0_0_0_1px_#fca5a5]',
  urgent:  'border-red-200',
  high:    'border-amber-200',
  medium:  'border-themed',
  normal:  'border-themed',
}

export const PRIORITY_INDICATOR_CLASS: Record<TurnoverUrgencyTone, string> = {
  overdue: 'bg-red-500',
  urgent:  'bg-red-400',
  high:    'bg-amber-400',
  medium:  'bg-blue-300',
  normal:  'bg-raised-themed',
}

/** Checkout-window color — a separate classification (driven by minutes, not priority/overdue). */
export function windowUrgencyColor(windowMins: number): string {
  if (windowMins < 120) return 'text-red-600'
  if (windowMins < 240) return 'text-amber-600'
  if (windowMins < 480) return 'text-blue-600'
  return 'text-green-600'
}
