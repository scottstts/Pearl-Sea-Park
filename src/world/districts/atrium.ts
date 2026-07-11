import { Object3D, PointLight, Vector3 } from 'three'
import { ArchKit } from '../../archkit/modules'
import { SlotWriter } from '../../archkit/writer'
import { registerBookmark } from '../../core/debug'
import type { MaterialsSystem } from '../../materials/materialsSystem'
import type { PhysicsSystem } from '../../physics/physicsWorld'
import type { InteractionSystem } from '../../player/interact'
import type { SeatSystem } from '../../player/seats'
import type { GameContext } from '../../runtime/context'
import type { GameSystem } from '../../runtime/system'
import type { ParkAmenitiesSystem } from '../parkAmenities'
import { PARK_PLAN, anchorGround } from '../parkPlan'
import { detailAtrium } from '../parkFacilities'

export interface DistrictServices {
  physics: PhysicsSystem
  materials: MaterialsSystem
  amenities: ParkAmenitiesSystem
  seats?: SeatSystem
  interaction?: InteractionSystem
}

/**
 * The Grand Atrium (plan §9.2): a ⌀44 m open colonnade rotunda under a ribbed
 * glass dome — the S6 hero build proving the kit. Ticket machine at the south
 * entrance, benches around the rosette, four lamps.
 */
export class AtriumSystem implements GameSystem {
  readonly id = 'atrium'
  private group: Object3D | null = null
  private readonly services: DistrictServices

  constructor(services: DistrictServices) {
    this.services = services
  }

  init(ctx: GameContext): void {
    const { physics, materials, amenities, seats, interaction } = this.services
    const lib = materials.lib
    if (!lib) throw new Error('AtriumSystem requires MaterialsSystem')

    const { x: cx, z: cz } = PARK_PLAN.atrium
    const floorY = anchorGround(PARK_PLAN.atrium) + 0.1
    const kit = new ArchKit(lib)
    const writer = new SlotWriter()

    // Plaza + steps.
    kit.mosaicPlaza(writer, cx, floorY, cz, 20)
    kit.stepsRing(writer, cx, floorY - 0.1, cz, 20)
    physics.addStaticCylinder(cx, floorY + 0.09, cz, 0.16, 20.6)

    // Colonnade: 16 stations, gaps at N and S entrances.
    const columnRadius = 17
    const columnHeight = 9
    const stations: { x: number; z: number; skip: boolean }[] = []
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2
      const px = cx + Math.sin(angle) * columnRadius
      const pz = cz + Math.cos(angle) * columnRadius
      // Skip the exact north (toward esplanade) and south (toward bell) posts.
      const skip = i === 0 || i === 8
      stations.push({ x: px, z: pz, skip })
      if (!skip) {
        kit.column(writer, px, floorY, pz, columnHeight, 0.34)
        physics.addStaticBox(px, floorY + columnHeight / 2, pz, 0.42, columnHeight / 2, 0.42)
      }
    }
    for (let i = 0; i < 16; i++) {
      const a = stations[i]
      const b = stations[(i + 1) % 16]
      if (a.skip || b.skip) continue
      kit.arch(writer, a.x, a.z, b.x, b.z, floorY + columnHeight, 1.7)
    }
    detailAtrium({ kit, writer, materials: lib, physics }, floorY)

    // Dome over it all.
    kit.dome(writer, cx, floorY + columnHeight + 0.6, cz, columnRadius + 0.9, 16)

    // Benches facing the center rosette.
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + Math.PI / 6
      const bx = cx + Math.sin(angle) * 13.5
      const bz = cz + Math.cos(angle) * 13.5
      const yaw = Math.atan2(cx - bx, cz - bz) + Math.PI
      amenities.addBench(bx, floorY + 0.18, bz, yaw)
      physics.addStaticBox(bx, floorY + 0.5, bz, 0.9, 0.34, 0.3, yaw)
      seats?.registerBenchSeat({
        eye: new Vector3(bx - Math.sin(yaw) * 0.1, floorY + 1.45, bz - Math.cos(yaw) * 0.1),
        lookAt: new Vector3(cx, floorY + 1.3, cz),
        exit: new Vector3(bx - Math.sin(yaw) * 1.2, floorY + 0.2, bz - Math.cos(yaw) * 1.2),
        prompt: 'Sit a while',
      })
    }

    // Lamps (with real warm light — the atrium glows).
    const group = new Object3D()
    for (const [dx, dz] of [
      [-11, -11],
      [11, -11],
      [-11, 11],
      [11, 11],
    ]) {
      const globe = amenities.addLamp(cx + dx, floorY + 0.18, cz + dz)
      const light = new PointLight(0xffd9a0, 6.5, 13, 1.8)
      light.position.set(globe.x, globe.y, globe.z)
      group.add(light)
      physics.addStaticBox(cx + dx, floorY + 1.7, cz + dz, 0.12, 1.7, 0.12)
    }

    // Ticket machine at the south entrance.
    const tmX = cx
    const tmZ = cz + columnRadius - 2
    kit.ticketMachine(writer, tmX, floorY + 0.18, tmZ, Math.PI)
    physics.addStaticBox(tmX, floorY + 0.85, tmZ, 0.4, 0.75, 0.4)
    interaction?.register({
      position: new Vector3(tmX, floorY + 1.2, tmZ),
      radius: 2.2,
      prompt: 'Punch your golden ticket',
      onInteract: () => ctx.events.emit('ticket/punched', { ride: 'atrium' }),
    })

    group.add(writer.compile())
    ctx.scene.add(group)
    this.group = group

    registerBookmark({
      name: 'atrium',
      position: [cx + 1, floorY + 2.1, cz - 32],
      look: [cx, floorY + 9, cz],
      note: 'S6 hero — colonnade rotunda under the glass dome',
    })
  }

  dispose(ctx: GameContext): void {
    if (this.group) ctx.scene.remove(this.group)
  }
}
