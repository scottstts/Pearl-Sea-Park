import {
  CircleGeometry,
  Color,
  LatheGeometry,
  Mesh,
  Object3D,
  PointLight,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { cameraPosition, float, mix, normalGeometry, normalize, positionWorld, sin, uniform, vec3 } from 'three/tsl'
import { ArchKit } from '../archkit/modules'
import { SlotWriter } from '../archkit/writer'
import { registerBookmark } from '../core/debug'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { DistrictServices } from './districts/atrium'
import { PARK_PATHS, PARK_PLAN, anchorGround } from './parkPlan'
import {
  detailCafe,
  detailEsplanade,
  detailMidway,
  detailObservatory,
  detailOverlook,
  detailTidalCourt,
} from './parkFacilities'
import { terrainHeight } from './terrain'

/**
 * Park assembly (plan S7): every shell district the ride stages will inhabit —
 * the Esplanade, Tidal Court with its reflecting pool, the Midway hall, Café
 * Méduse, the Observatory, the Leviathan Overlook containment, and the path
 * network. All geometry through the kit; all positions from PARK_PLAN.
 */
export class ParkAssemblySystem implements GameSystem {
  readonly id = 'park'
  private group: Object3D | null = null
  private readonly services: DistrictServices
  private readonly timeUniform = uniform(0)

  constructor(services: DistrictServices) {
    this.services = services
  }

  init(ctx: GameContext): void {
    const { physics, materials, amenities, seats } = this.services
    const lib = materials.lib
    if (!lib) throw new Error('ParkAssemblySystem requires materials')
    const kit = new ArchKit(lib)
    const w = new SlotWriter(72)
    const group = new Object3D()
    const lights: PointLight[] = []
    const lamp = (x: number, y: number, z: number, lit = false) => {
      const globe = amenities.addLamp(x, y, z)
      physics.addStaticBox(x, y + 1.7, z, 0.12, 1.7, 0.12)
      if (lit) {
        const light = new PointLight(0xffd9a0, 5.5, 12, 1.8)
        light.position.set(globe.x, globe.y, globe.z)
        lights.push(light)
      }
    }
    // Terrain-following path: short plates, each grounded on its own stretch
    // of sand. One long plate at a fixed height floats over dips and drapes
    // the park in kilometre shadows — segmenting is the fix, not shadow tricks.
    const groundedPath = (ax: number, az: number, bx: number, bz: number, width: number) => {
      const dx = bx - ax
      const dz = bz - az
      const length = Math.hypot(dx, dz)
      if (length < 0.01) return
      const segments = Math.max(1, Math.ceil(length / 9))
      const pad = 0.3 / length // overlap so height steps never open gaps
      for (let i = 0; i < segments; i++) {
        const t0 = Math.max(0, i / segments - pad)
        const t1 = Math.min(1, (i + 1) / segments + pad)
        const sx = ax + dx * t0
        const sz = az + dz * t0
        const ex = ax + dx * t1
        const ez = az + dz * t1
        const mx = (sx + ex) / 2
        const mz = (sz + ez) / 2
        const y =
          Math.max(terrainHeight(sx, sz), terrainHeight(mx, mz), terrainHeight(ex, ez)) + 0.02
        kit.mosaicPath(w, sx, sz, ex, ez, y, width)
        const half = Math.hypot(ex - sx, ez - sz) / 2
        physics.addStaticBox(mx, y + 0.08, mz, width / 2, 0.08, half, Math.atan2(ex - sx, ez - sz))
      }
    }

    // ── Esplanade: twin colonnade boulevard, atrium → hub ─────────────────
    const esp = PARK_PLAN.esplanade
    const espY = terrainHeight(esp.x, (esp.zFrom + esp.zTo) / 2) + 0.1
    groundedPath(esp.x, esp.zFrom, esp.x, esp.zTo, esp.width)
    const columnGap = 12
    for (let z = esp.zTo + 6; z <= esp.zFrom - 6; z += columnGap) {
      for (const side of [-1, 1]) {
        const x = esp.x + side * (esp.width / 2 + 0.8)
        kit.column(w, x, espY, z, 6.5, 0.3)
        physics.addStaticBox(x, espY + 3.2, z, 0.38, 3.2, 0.38)
      }
    }
    for (let z = esp.zTo + 6; z < esp.zFrom - 6 - columnGap; z += columnGap) {
      for (const side of [-1, 1]) {
        const x = esp.x + side * (esp.width / 2 + 0.8)
        kit.arch(w, x, z, x, z + columnGap, espY + 6.5, 1.3)
      }
    }
    for (let z = esp.zTo + 12; z <= esp.zFrom - 12; z += columnGap * 2) {
      lamp(esp.x - esp.width / 2 - 2.4, espY, z)
      lamp(esp.x + esp.width / 2 + 2.4, espY, z + columnGap)
    }
    for (let z = esp.zTo + 18; z <= esp.zFrom - 18; z += columnGap * 3) {
      for (const side of [-1, 1]) {
        const bx = esp.x + side * (esp.width / 2 - 1.2)
        amenities.addBenchFacing(bx, espY + 0.1, z, esp.x, z)
        physics.addStaticBox(bx, espY + 0.45, z, 0.32, 0.34, 0.9)
        seats?.registerBenchSeat({
          eye: new Vector3(bx, espY + 1.35, z),
          lookAt: new Vector3(esp.x - side * 30, espY + 2, z),
          exit: new Vector3(bx - side * 1.3, espY + 0.1, z),
          prompt: 'Sit a while',
        })
      }
    }
    detailEsplanade({ kit, writer: w, materials: lib, physics }, espY)

    // ── Tidal Court: hub colonnade ring + reflecting pool ─────────────────
    const hub = PARK_PLAN.tidalCourt
    const hubY = anchorGround(hub) + 0.1
    kit.mosaicPlaza(w, hub.x, hubY, hub.z, hub.colonnadeRadius + 4)
    kit.stepsRing(w, hub.x, hubY - 0.1, hub.z, hub.colonnadeRadius + 4)
    physics.addStaticCylinder(hub.x, hubY + 0.09, hub.z, 0.16, hub.colonnadeRadius + 4.6)

    const hubStations: { x: number; z: number; skip: boolean }[] = []
    const hubCount = 28
    for (let i = 0; i < hubCount; i++) {
      const angle = (i / hubCount) * Math.PI * 2
      const px = hub.x + Math.sin(angle) * hub.colonnadeRadius
      const pz = hub.z + Math.cos(angle) * hub.colonnadeRadius
      // Gates toward: esplanade (S), wheel (E), menagerie (W), coaster (N), midway (SE).
      const gate =
        i === 0 || i === hubCount / 2 || i === hubCount / 4 || i === (3 * hubCount) / 4 || i === 3
      hubStations.push({ x: px, z: pz, skip: gate })
      if (!gate) {
        kit.column(w, px, hubY, pz, 7.5, 0.32)
        physics.addStaticBox(px, hubY + 3.7, pz, 0.4, 3.7, 0.4)
      }
    }
    for (let i = 0; i < hubCount; i++) {
      const a = hubStations[i]
      const b = hubStations[(i + 1) % hubCount]
      if (a.skip || b.skip) continue
      kit.arch(w, a.x, a.z, b.x, b.z, hubY + 7.5, 1.4)
    }

    // The reflecting pool — the Bubble Fountain show uses this exact stage.
    // The basin is an open RING — a capped cylinder would lid the water over.
    const poolRadius = hub.lagoonRadius
    const basin = new LatheGeometry(
      [
        new Vector2(poolRadius - 0.15, 0),
        new Vector2(poolRadius + 1.4, 0),
        new Vector2(poolRadius + 1.4, 0.5),
        new Vector2(poolRadius + 1.15, 0.56),
        new Vector2(poolRadius - 0.15, 0.56),
        new Vector2(poolRadius - 0.15, 0),
      ],
      72,
    )
    basin.computeVertexNormals()
    const basinMesh = new Mesh(basin, lib.marble)
    basinMesh.position.set(hub.x, hubY, hub.z)
    basinMesh.receiveShadow = true
    group.add(basinMesh)
    // Ring collider approximated by four arc-chord boxes is overkill — a low
    // cylinder at the rim height keeps guests from wading; the wall is 56 cm.
    physics.addStaticCylinder(hub.x, hubY + 0.28, hub.z, 0.28, poolRadius + 1.4)

    // Single-draw glossy pool. A previous planar reflector nested a second
    // full park render whenever this disc entered the Esplanade view frustum,
    // freezing the exact entrance-facing-north sightline.
    const ripplePhase = this.timeUniform.mul(0.7)
    const rippleVec = vec3(
      sin(positionWorld.x.mul(2.6).add(positionWorld.z.mul(1.4)).add(ripplePhase))
        .mul(0.09)
        .add(sin(positionWorld.x.mul(7.1).sub(positionWorld.z.mul(4.9)).add(ripplePhase.mul(1.7))).mul(0.04)),
      0,
      sin(positionWorld.z.mul(2.3).sub(positionWorld.x.mul(1.2)).add(ripplePhase.mul(0.8)))
        .mul(0.09)
        .add(sin(positionWorld.z.mul(7.9).add(positionWorld.x.mul(4.2)).add(ripplePhase.mul(1.4))).mul(0.04)),
    )
    const water = new MeshStandardNodeMaterial()
    water.color = new Color(0x0a3038)
    water.roughness = 0.16
    water.metalness = 0.12
    water.envMapIntensity = 0.72
    water.normalNode = normalize(normalGeometry.add(rippleVec))
    const facing = cameraPosition.sub(positionWorld).normalize().y.abs().clamp(0, 1)
    const grazing = float(1).sub(facing).pow(3)
    water.colorNode = mix(vec3(0.018, 0.09, 0.105), vec3(0.16, 0.29, 0.31), grazing)
    water.emissiveNode = vec3(0.004, 0.015, 0.018)
    const waterDisc = new Mesh(new CircleGeometry(poolRadius, 48), water)
    waterDisc.rotation.x = -Math.PI / 2
    waterDisc.position.set(hub.x, hubY + 0.42, hub.z)
    waterDisc.receiveShadow = true
    group.add(waterDisc)
    // Verdigris lip on the basin rim so the water's edge reads at a glance.
    const lip = new Mesh(new TorusGeometry(poolRadius + 1.2, 0.09, 12, 72), lib.verdigris)
    lip.rotation.x = Math.PI / 2
    lip.position.set(hub.x, hubY + 0.52, hub.z)
    group.add(lip)

    for (const [dx, dz] of [
      [-hub.colonnadeRadius + 6, 0],
      [hub.colonnadeRadius - 6, 0],
      [0, -hub.colonnadeRadius + 6],
      [0, hub.colonnadeRadius - 6],
      [hub.colonnadeRadius * 0.55, hub.colonnadeRadius * 0.55],
      [-hub.colonnadeRadius * 0.55, hub.colonnadeRadius * 0.55],
    ]) {
      lamp(hub.x + dx, hubY + 0.1, hub.z + dz, true)
    }
    detailTidalCourt({ kit, writer: w, materials: lib, physics }, hubY)

    // ── Midway hall shell and its physical games ─────────────────────────
    const mid = PARK_PLAN.midway
    const midY = terrainHeight(mid.x, mid.z) + 0.1
    groundedPath(mid.x - mid.width / 2, mid.z, mid.x + mid.width / 2, mid.z, mid.depth)
    const hallColumns = 6
    for (let i = 0; i <= hallColumns; i++) {
      const x = mid.x - mid.width / 2 + (i / hallColumns) * mid.width
      for (const side of [-1, 1]) {
        const z = mid.z + (side * mid.depth) / 2
        kit.column(w, x, midY, z, 6, 0.28)
        physics.addStaticBox(x, midY + 3, z, 0.36, 3, 0.36)
      }
    }
    kit.gableRoof(w, mid.x, midY + 6, mid.z, mid.width + 2, mid.depth + 2, 3.4)
    for (let i = 0; i < 4; i++) {
      lamp(mid.x - mid.width / 2 + 4 + i * ((mid.width - 8) / 3), midY, mid.z - mid.depth / 2 - 2, i % 2 === 0)
    }
    detailMidway({ kit, writer: w, materials: lib, physics }, midY)

    // ── Café Méduse ───────────────────────────────────────────────────────
    const cafe = PARK_PLAN.cafe
    const cafeY = terrainHeight(cafe.x, cafe.z) + 0.1
    kit.mosaicPlaza(w, cafe.x, cafeY, cafe.z, 8)
    physics.addStaticCylinder(cafe.x, cafeY + 0.09, cafe.z, 0.16, 8.3)
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + Math.PI / 6
      const px = cafe.x + Math.sin(angle) * 7
      const pz = cafe.z + Math.cos(angle) * 7
      kit.column(w, px, cafeY, pz, 4.6, 0.24)
      physics.addStaticBox(px, cafeY + 2.3, pz, 0.3, 2.3, 0.3)
    }
    kit.dome(w, cafe.x, cafeY + 4.7, cafe.z, 7.6, 10)
    for (const [tx, tz] of [
      [-3, -2],
      [3.2, -1],
      [-1.5, 3],
      [2.4, 3.2],
    ]) {
      kit.table(w, cafe.x + tx, cafeY + 0.18, cafe.z + tz)
      physics.addStaticBox(cafe.x + tx, cafeY + 0.6, cafe.z + tz, 0.45, 0.42, 0.45)
    }
    lamp(cafe.x - 6, cafeY, cafe.z + 5, true)
    lamp(cafe.x + 6, cafeY, cafe.z - 5, true)
    detailCafe({ kit, writer: w, materials: lib, physics }, cafeY)

    // ── Observatory: the quiet dome for watching the Silver Ceiling ──────
    const obs = PARK_PLAN.observatory
    const obsY = terrainHeight(obs.x, obs.z) + 0.1
    kit.mosaicPlaza(w, obs.x, obsY, obs.z, 9)
    kit.stepsRing(w, obs.x, obsY - 0.1, obs.z, 9)
    physics.addStaticCylinder(obs.x, obsY + 0.09, obs.z, 0.16, 9.5)
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + Math.PI / 8
      const px = obs.x + Math.sin(angle) * 8
      const pz = obs.z + Math.cos(angle) * 8
      kit.column(w, px, obsY, pz, 5, 0.26)
      physics.addStaticBox(px, obsY + 2.5, pz, 0.32, 2.5, 0.32)
    }
    kit.dome(w, obs.x, obsY + 5.1, obs.z, 8.7, 12)
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + Math.PI / 4
      const bx = obs.x + Math.sin(angle) * 4
      const bz = obs.z + Math.cos(angle) * 4
      const yaw = Math.atan2(bx - obs.x, bz - obs.z)
      amenities.addBenchFacing(bx, obsY + 0.18, bz, obs.x, obs.z)
      physics.addStaticBox(bx, obsY + 0.5, bz, 0.9, 0.34, 0.3, yaw)
      seats?.registerBenchSeat({
        eye: new Vector3(bx, obsY + 1.4, bz),
        lookAt: new Vector3(bx, obsY + 40, bz - 6),
        exit: new Vector3(bx + Math.sin(yaw) * 1.3, obsY + 0.2, bz + Math.cos(yaw) * 1.3),
        prompt: 'Recline and watch the ceiling',
      })
    }
    detailObservatory({ kit, writer: w, materials: lib, physics }, obsY)

    // ── Leviathan Overlook: balustrade at the rim ─────────────────────────
    const overlookX = -140
    const overlookZ = -236
    const overlookY = terrainHeight(overlookX, overlookZ) + 0.1
    groundedPath(overlookX - 30, overlookZ + 2, overlookX + 30, overlookZ + 2, 6)
    for (let i = 0; i < 6; i++) {
      const x1 = overlookX - 30 + i * 10
      kit.balustrade(w, x1, overlookZ - 1, x1 + 10, overlookZ - 1, overlookY)
    }
    physics.addStaticBox(overlookX, overlookY + 0.6, overlookZ - 1, 30, 0.6, 0.2)
    lamp(overlookX - 28, overlookY, overlookZ + 4, true)
    lamp(overlookX + 28, overlookY, overlookZ + 4, true)
    detailOverlook({ kit, writer: w, materials: lib, physics }, overlookX, overlookZ, overlookY)

    // ── Path network (segments defined once in parkPlan) ─────────────────
    for (const p of PARK_PATHS) groundedPath(p.ax, p.az, p.bx, p.bz, p.width)

    group.add(w.compile())
    for (const light of lights) group.add(light)
    ctx.scene.add(group)
    this.group = group

    registerBookmark({
      name: 'esplanade',
      position: [esp.x - 4.4, espY + 1.9, esp.zFrom - 8],
      look: [esp.x + 2, espY + 5, esp.zTo],
      note: 'Postcard 2 staging — the boulevard toward the hub',
    })
    registerBookmark({
      name: 'hub',
      position: [hub.x + 30, hubY + 2.2, hub.z + 34],
      look: [hub.x, hubY + 4, hub.z],
      note: 'Tidal Court colonnade + reflecting pool',
    })
    registerBookmark({
      name: 'snell',
      position: [obs.x, obsY + 1.55, obs.z + 0.5],
      look: [obs.x, 8, obs.z - 2],
      note: "Postcard 7 — Snell's window through the Observatory oculus",
    })
  }

  update(ctx: GameContext): void {
    this.timeUniform.value = ctx.time.elapsed
  }

  dispose(ctx: GameContext): void {
    if (this.group) ctx.scene.remove(this.group)
  }
}
