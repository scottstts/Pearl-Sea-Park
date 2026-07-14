import { PARK_PLAN } from '../world/parkPlan'
import { terrainHeight } from '../world/terrain'

export type VehicleStructureCollider =
  | {
      kind: 'box'
      name: string
      x: number
      y: number
      z: number
      hx: number
      hy: number
      hz: number
      yaw?: number
    }
  | {
      kind: 'cylinder'
      name: string
      x: number
      y: number
      z: number
      halfHeight: number
      radius: number
    }

/**
 * Broad, vehicle-only envelopes for architecture whose ordinary Rapier
 * colliders intentionally describe guest-walkable floors, posts, and rails.
 * A guest can enter these pavilions; a five-metre submarine cannot fly
 * through their dome, roof, or ride superstructure.
 */
export function vehicleStructureColliders(): VehicleStructureCollider[] {
  const colliders: VehicleStructureCollider[] = []

  const cylinderFromFloor = (
    name: string,
    x: number,
    z: number,
    floorY: number,
    topY: number,
    radius: number,
  ): void => {
    colliders.push({
      kind: 'cylinder',
      name,
      x,
      y: (floorY + topY) * 0.5,
      z,
      halfHeight: (topY - floorY) * 0.5,
      radius,
    })
  }

  // Four enclosed glass pavilions. Dome vertical radii match ArchKit.dome
  // (0.815 × horizontal radius); the lower volume closes the colonnade to a
  // vehicle while remaining absent from guest queries.
  const atrium = PARK_PLAN.atrium
  const atriumFloor = terrainHeight(atrium.x, atrium.z) + 0.1
  cylinderFromFloor(
    'grand-atrium',
    atrium.x,
    atrium.z,
    atriumFloor,
    atriumFloor + 9.6 + 17.9 * 0.815,
    17.9,
  )

  const cafe = PARK_PLAN.cafe
  const cafeFloor = terrainHeight(cafe.x, cafe.z) + 0.1
  cylinderFromFloor(
    'cafe-meduse',
    cafe.x,
    cafe.z,
    cafeFloor,
    cafeFloor + 4.7 + 7.6 * 0.815,
    7.6,
  )

  const observatory = PARK_PLAN.observatory
  const observatoryFloor = terrainHeight(observatory.x, observatory.z) + 0.1
  cylinderFromFloor(
    'silver-ceiling-observatory',
    observatory.x,
    observatory.z,
    observatoryFloor,
    observatoryFloor + 5.1 + 8.7 * 0.815,
    8.7,
  )

  const sun = PARK_PLAN.menagerie.sunGarden
  const sunFloor = terrainHeight(sun.x, sun.z) + 0.08
  cylinderFromFloor(
    'sun-garden',
    sun.x,
    sun.z,
    sunFloor,
    sunFloor + 5.15 + 8.5 * 0.815,
    8.5,
  )

  // Gabled halls and stations use their authored roof footprints. These are
  // complete building volumes, not the larger plazas around them.
  const midway = PARK_PLAN.midway
  const midwayFloor = terrainHeight(midway.x, midway.z) + 0.1
  colliders.push({
    kind: 'box',
    name: 'midway-hall',
    x: midway.x,
    y: midwayFloor + 4.7,
    z: midway.z,
    hx: (midway.width + 2) * 0.5,
    hy: 4.7,
    hz: (midway.depth + 2) * 0.5,
  })

  const torrent = PARK_PLAN.torrent.station
  const torrentStationY = terrainHeight(torrent.x, torrent.z) + 1.1
  colliders.push({
    kind: 'box',
    name: 'torrent-station',
    x: torrent.x + 1,
    y: torrentStationY + 2.3,
    z: torrent.z,
    hx: 4.8,
    hy: 3.5,
    hz: 8.5,
  })

  for (const [name, x, z] of [
    ['pearl-line-atrium', -34, 210],
    ['pearl-line-wheel', 146, 58],
  ] as const) {
    const floorY = terrainHeight(x, z)
    colliders.push({
      kind: 'box',
      name,
      x,
      y: floorY + 3.1,
      z,
      hx: 4.4,
      hy: 3.1,
      hz: 2.8,
    })
  }

  // Ride machinery is treated as a single coherent obstacle. Its ordinary
  // colliders remain detailed for guests; this envelope prevents a vehicle
  // threading through moving or elevated visual parts.
  const carousel = PARK_PLAN.carousel
  const carouselFloor = terrainHeight(carousel.x, carousel.z)
  cylinderFromFloor(
    'carousel',
    carousel.x,
    carousel.z,
    carouselFloor,
    carouselFloor + 10.1,
    8.8,
  )

  const wheel = PARK_PLAN.wheel
  colliders.push({
    kind: 'box',
    name: 'great-wheel-sweep',
    x: wheel.x,
    y: wheel.hubY,
    z: wheel.z,
    hx: wheel.radius + 2.3,
    hy: wheel.radius + 2.8,
    hz: 3.9,
  })

  // The arrival platform spans the full water column on piles; its compact
  // envelope is safely clear of the submarine berth at (6, 311).
  const arrival = PARK_PLAN.arrival
  const arrivalFloor = terrainHeight(arrival.x, arrival.z)
  cylinderFromFloor(
    'descent-station',
    arrival.x,
    arrival.z,
    arrivalFloor,
    8.2,
    6.6,
  )

  return colliders
}
