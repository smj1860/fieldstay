import type { GuidebookSlotType } from '@/types/database'

export interface KitSlotCopy {
  label:       string   // "Morning Brew"
  categoryTag: string   // "Coffee & breakfast"
  headline:    [string, string] // two lines; second line is the gold em phrase
  momentChip:  string   // chip on the phone mock, e.g. "Chilly morning · Coffee nearby"
  mockTime:    string   // "7:42 AM"
  mockWeather: string   // "43°F ☁️"
  cardLabel:   string   // "Our pick for breakfast"
  proofMoment: string   // proof column 2 body
}

export const KIT_SLOT_COPY: Record<GuidebookSlotType, KitSlotCopy> = {
  morning_brew: {
    label:       'Morning Brew',
    categoryTag: 'Coffee & breakfast',
    headline:    ['Be the first thing our guests see on a', 'cold morning.'],
    momentChip:  'Chilly morning · Coffee nearby',
    mockTime:    '7:42 AM',
    mockWeather: '43°F ☁️',
    cardLabel:   'Our pick for breakfast',
    proofMoment: "Not a buried listing — you appear on the guest's phone at breakfast time, when they're deciding where to go.",
  },
  dinner_pints: {
    label:       'Dinner & Pints',
    categoryTag: 'Evening dining',
    headline:    ['Be the answer when our guests ask', '"where should we eat tonight?"'],
    momentChip:  'Evening · Dinner nearby',
    mockTime:    '6:15 PM',
    mockWeather: '74°F 🌇',
    cardLabel:   "Tonight's dinner pick",
    proofMoment: "Not a buried listing — you appear on the guest's phone right as dinner time approaches, when they're deciding where to go.",
  },
  rainy_day: {
    label:       'Rainy Day Refuge',
    categoryTag: 'Indoor & retail',
    headline:    ['Be where our guests go when the', 'weather turns.'],
    momentChip:  'Rain likely · Indoor ideas',
    mockTime:    '1:20 PM',
    mockWeather: '61°F 🌧️',
    cardLabel:   'Our rainy-day pick',
    proofMoment: "Not a buried listing — the guidebook watches the forecast and surfaces you the moment rain rolls in.",
  },
  outdoor_adventure: {
    label:       'Outdoor Adventure',
    categoryTag: 'Guides & rentals',
    headline:    ['Be the plan when our guests wake up to a', 'perfect day outside.'],
    momentChip:  'Clear skies · Get outside',
    mockTime:    '9:05 AM',
    mockWeather: '78°F ☀️',
    cardLabel:   'Our pick for today',
    proofMoment: "Not a buried listing — you appear on clear-sky days, exactly when guests are planning time on the water.",
  },
  general: {
    label:       'Local Favorite',
    categoryTag: 'Featured local spot',
    headline:    ['Be the local spot our guests', "don't want to miss."],
    momentChip:  'Recommended nearby',
    mockTime:    '11:30 AM',
    mockWeather: '72°F ⛅',
    cardLabel:   'Our local pick',
    proofMoment: "Not a buried listing — you're one of a handful of hand-picked local businesses guests see during their stay.",
  },
  other: {
    label:       'Local Favorite',
    categoryTag: 'Featured local spot',
    headline:    ['Be the local spot our guests', "don't want to miss."],
    momentChip:  'Recommended nearby',
    mockTime:    '11:30 AM',
    mockWeather: '72°F ⛅',
    cardLabel:   'Our local pick',
    proofMoment: "Not a buried listing — you're one of a handful of hand-picked local businesses guests see during their stay.",
  },
}

/** Ordered slot band for the kit — the four named exclusive slots. */
export const KIT_SLOT_BAND: { slotType: GuidebookSlotType; name: string; tag: string }[] = [
  { slotType: 'morning_brew',      name: 'Morning Brew',      tag: 'Coffee & breakfast' },
  { slotType: 'dinner_pints',      name: 'Dinner & Pints',    tag: 'Evening dining' },
  { slotType: 'rainy_day',         name: 'Rainy Day Refuge',  tag: 'Indoor & retail' },
  { slotType: 'outdoor_adventure', name: 'Outdoor Adventure', tag: 'Guides & rentals' },
]

export function getKitCopy(slotType: GuidebookSlotType, slotContext: string | null): KitSlotCopy {
  const base = KIT_SLOT_COPY[slotType]
  if (slotType === 'other' && slotContext) {
    return { ...base, categoryTag: slotContext }
  }
  return base
}

/** One-sentence "when this fires" context for the kit lede — shared by the print kit and signup page. */
export function getKitLedeContext(slotType: GuidebookSlotType): string {
  switch (slotType) {
    case 'morning_brew':      return 'On chilly mornings it recommends exactly one place for coffee'
    case 'dinner_pints':      return 'As evening comes it recommends exactly one place for dinner'
    case 'rainy_day':         return 'The moment rain rolls in it recommends exactly one indoor spot'
    case 'outdoor_adventure': return 'On clear days it recommends exactly one place to get outside'
    case 'general':
    case 'other':
    default:                  return 'It recommends exactly one hand-picked local spot'
  }
}
