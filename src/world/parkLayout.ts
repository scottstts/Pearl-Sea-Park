/**
 * THE master layout (plan §3): every district, path, ride, and entrance sign
 * anchors here. Coordinates are meters; north = −z toward the drop-off.
 */
export const PARK_PLAN = {
  arrival: { x: 0, z: 320 },
  atrium: { x: 0, z: 250, plazaRadius: 21 },
  esplanade: { x: 0, zFrom: 229, zTo: 121, width: 13 },
  tidalCourt: { x: 0, z: 78, colonnadeRadius: 40, lagoonRadius: 26 },
  wheel: { x: 175, z: 40, radius: 20, hubY: -18 },
  carousel: { x: 100, z: 182, plazaRadius: 12 },
  torrent: { station: { x: 70, z: -165 } },
  menagerie: {
    x: -170,
    z: 45,
    sunGarden: { x: -148, z: 60 },
    jellyCourt: { x: -188, z: 53, radius: 14 },
    turtleLagoon: { x: -168, z: 20, radius: 13 },
  },
  midway: { x: 100, z: 150, width: 42, depth: 20 },
  grotto: { x: 185, z: 125 },
  observatory: { x: -62, z: 228 },
  cafe: { x: 46, z: 112 },
} as const

/** All authored walking links; paths, keep-outs, and sign clearance share it. */
export const PARK_PATHS: readonly {
  ax: number
  az: number
  bx: number
  bz: number
  width: number
}[] = [
  { ax: PARK_PLAN.arrival.x, az: PARK_PLAN.arrival.z - 6, bx: PARK_PLAN.atrium.x, bz: PARK_PLAN.atrium.z + 21, width: 5 },
  { ax: PARK_PLAN.tidalCourt.x, az: PARK_PLAN.tidalCourt.z, bx: PARK_PLAN.wheel.x - 27, bz: PARK_PLAN.wheel.z, width: 8 },
  { ax: PARK_PLAN.midway.x, az: PARK_PLAN.midway.z + 12, bx: PARK_PLAN.carousel.x, bz: PARK_PLAN.carousel.z - 13, width: 6 },
  { ax: PARK_PLAN.tidalCourt.x, az: PARK_PLAN.tidalCourt.z, bx: PARK_PLAN.menagerie.x, bz: PARK_PLAN.menagerie.z, width: 8 },
  { ax: PARK_PLAN.tidalCourt.x, az: PARK_PLAN.tidalCourt.z, bx: PARK_PLAN.midway.x - 10, bz: PARK_PLAN.midway.z - 4, width: 7 },
  { ax: PARK_PLAN.midway.x + 16, az: PARK_PLAN.midway.z, bx: PARK_PLAN.grotto.x, bz: PARK_PLAN.grotto.z, width: 6 },
  { ax: PARK_PLAN.tidalCourt.x, az: PARK_PLAN.tidalCourt.z, bx: PARK_PLAN.torrent.station.x, bz: PARK_PLAN.torrent.station.z, width: 7 },
  { ax: PARK_PLAN.atrium.x, az: PARK_PLAN.atrium.z, bx: PARK_PLAN.observatory.x, bz: PARK_PLAN.observatory.z, width: 5 },
  { ax: PARK_PLAN.tidalCourt.x + 18, az: PARK_PLAN.tidalCourt.z + 24, bx: PARK_PLAN.cafe.x, bz: PARK_PLAN.cafe.z, width: 5 },
  { ax: -140, az: -232, bx: PARK_PLAN.menagerie.x, bz: PARK_PLAN.menagerie.z, width: 6 },
]

export type FacilityEntranceSign = {
  id: string
  title: string
  subtitle?: string
  x: number
  z: number
  /** World-space point from which a guest approaches and reads the sign. */
  approachX: number
  approachZ: number
}

/**
 * One entrance marker for every guest-facing park facility. Positions sit to
 * the side of the threshold rather than in its walking lane; the approach
 * point is also the authoritative facing target used by the geometry audit.
 */
export const FACILITY_ENTRANCE_SIGNS: readonly FacilityEntranceSign[] = [
  {
    id: 'grand-atrium', title: 'GRAND ATRIUM', subtitle: 'ENTRANCE ROTUNDA',
    x: PARK_PLAN.atrium.x - 6.2, z: PARK_PLAN.atrium.z + 20.2,
    approachX: PARK_PLAN.arrival.x, approachZ: PARK_PLAN.arrival.z,
  },
  {
    id: 'tidal-court', title: 'TIDAL COURT',
    x: PARK_PLAN.tidalCourt.x - 9.2, z: PARK_PLAN.tidalCourt.z + 42,
    approachX: PARK_PLAN.esplanade.x, approachZ: PARK_PLAN.esplanade.zTo,
  },
  {
    id: 'midway-hall', title: 'MIDWAY HALL', subtitle: 'GAMES & AMUSEMENTS',
    x: PARK_PLAN.midway.x - 13, z: PARK_PLAN.midway.z - 11.6,
    approachX: PARK_PLAN.tidalCourt.x, approachZ: PARK_PLAN.tidalCourt.z,
  },
  {
    id: 'cafe-meduse', title: 'CAFÉ MÉDUSE', subtitle: 'REFRESHMENT TERRACE',
    x: PARK_PLAN.cafe.x - 7.4, z: PARK_PLAN.cafe.z + 3.5,
    approachX: PARK_PLAN.tidalCourt.x + 18, approachZ: PARK_PLAN.tidalCourt.z + 24,
  },
  {
    id: 'observatory', title: 'SILVER CEILING', subtitle: 'OBSERVATORY',
    x: PARK_PLAN.observatory.x + 9.3, z: PARK_PLAN.observatory.z - 5.7,
    approachX: PARK_PLAN.atrium.x, approachZ: PARK_PLAN.atrium.z,
  },
  {
    id: 'leviathan-overlook', title: 'LEVIATHAN OVERLOOK',
    x: -148, z: -228.5, approachX: -160, approachZ: -210,
  },
  {
    id: 'great-wheel', title: 'THE GREAT WHEEL', subtitle: 'BOARDING PIER',
    x: PARK_PLAN.wheel.x - 27, z: PARK_PLAN.wheel.z + 5.2,
    approachX: PARK_PLAN.tidalCourt.x, approachZ: PARK_PLAN.tidalCourt.z,
  },
  {
    id: 'carousel', title: 'CARROUSEL', subtitle: 'DES ABYSSES',
    x: PARK_PLAN.carousel.x - 6.5, z: PARK_PLAN.carousel.z - 12.6,
    approachX: PARK_PLAN.midway.x, approachZ: PARK_PLAN.midway.z,
  },
  {
    id: 'torrent', title: 'THE TORRENT', subtitle: 'LAUNCH COASTER',
    x: PARK_PLAN.torrent.station.x + 2.2, z: PARK_PLAN.torrent.station.z + 13.2,
    approachX: PARK_PLAN.tidalCourt.x, approachZ: PARK_PLAN.tidalCourt.z,
  },
  {
    id: 'menagerie', title: 'MENAGERIE GARDENS',
    x: PARK_PLAN.menagerie.x + 17.2, z: PARK_PLAN.menagerie.z - 2.8,
    approachX: PARK_PLAN.tidalCourt.x, approachZ: PARK_PLAN.tidalCourt.z,
  },
  {
    id: 'sun-garden', title: 'SUN GARDEN', subtitle: 'LIVING CORAL COURT',
    x: PARK_PLAN.menagerie.sunGarden.x + 9.2, z: PARK_PLAN.menagerie.sunGarden.z + 2,
    approachX: PARK_PLAN.menagerie.x, approachZ: PARK_PLAN.menagerie.z,
  },
  {
    id: 'jelly-court', title: 'MOON-JELLY COURT',
    x: PARK_PLAN.menagerie.jellyCourt.x + 14.8, z: PARK_PLAN.menagerie.jellyCourt.z + 2,
    approachX: PARK_PLAN.menagerie.x, approachZ: PARK_PLAN.menagerie.z,
  },
  {
    id: 'turtle-lagoon', title: 'TURTLE LAGOON',
    x: PARK_PLAN.menagerie.turtleLagoon.x + 13.8, z: PARK_PLAN.menagerie.turtleLagoon.z + 6.2,
    approachX: PARK_PLAN.menagerie.x, approachZ: PARK_PLAN.menagerie.z,
  },
  {
    id: 'grotto', title: 'GROTTO OF PEARLS', subtitle: 'SCENIC VOYAGE',
    x: PARK_PLAN.grotto.x - 9.5, z: PARK_PLAN.grotto.z + 9.2,
    approachX: PARK_PLAN.midway.x, approachZ: PARK_PLAN.midway.z,
  },
  {
    id: 'pearl-line-atrium', title: 'PEARL LINE', subtitle: 'ESPLANADE WEST',
    x: -27.5, z: 215.8, approachX: PARK_PLAN.atrium.x, approachZ: PARK_PLAN.atrium.z,
  },
  {
    id: 'pearl-line-wheel', title: 'PEARL LINE', subtitle: 'WHEEL PIER',
    x: 139.2, z: 63.2, approachX: PARK_PLAN.tidalCourt.x, approachZ: PARK_PLAN.tidalCourt.z,
  },
] as const
