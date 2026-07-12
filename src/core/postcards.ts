import { getBookmark } from './debug'

export const POSTCARD_VIEWS = [
  { name: 'descent', intent: 'Sky through the waterline to the glowing park below' },
  { name: 'esplanade', intent: 'The glass-vault boulevard and its civic arcade' },
  { name: 'breach', intent: 'The Great Wheel crest breaks into sunlight' },
  { name: 'dive', intent: 'The Torrent leaves the shelf for open blue' },
  { name: 'manta', intent: 'A manta and its shadow cross the Esplanade marble' },
  { name: 'wishing-well', intent: 'Carousel lights ripple across the physical wishing well' },
  { name: 'snell', intent: "Snell's window fills the Observatory oculus" },
  { name: 'whale', intent: 'Shadow first, then the whale eye at the Overlook' },
  // The Grotto (and its pearl-treasury postcard) was removed from the park;
  // the Sun Garden's glasshouse interior takes the ninth frame.
  { name: 'sun-garden', intent: 'Blooms and butterflies under the Sun Garden glass' },
  { name: 'fountain', intent: 'Light-threaded bubble columns crown Tidal Court' },
] as const

export interface PostcardAudit {
  complete: boolean
  total: number
  present: string[]
  missing: string[]
}

export function auditPostcardBookmarks(): PostcardAudit {
  const present: string[] = []
  const missing: string[] = []
  for (const postcard of POSTCARD_VIEWS) {
    if (getBookmark(postcard.name)) present.push(postcard.name)
    else missing.push(postcard.name)
  }
  return {
    complete: missing.length === 0,
    total: POSTCARD_VIEWS.length,
    present,
    missing,
  }
}
