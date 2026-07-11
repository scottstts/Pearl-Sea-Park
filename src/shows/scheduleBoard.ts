import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  LatheGeometry,
  Mesh,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
} from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { PARK_SCHEDULE } from '../core/scheduler'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { DistrictServices } from '../world/districts/atrium'
import { PARK_PLAN } from '../world/parkPlan'
import { terrainHeight } from '../world/terrain'
import { createNoticeBoardRoofPlan } from './noticeBoardGeometry'

interface Board {
  panel: Mesh
  texture: CanvasTexture
  canvas: HTMLCanvasElement
  flip: number
  changed: boolean
}

/** Two mechanical timetable boards: event information stays inside the world. */
export class ScheduleBoardSystem implements GameSystem {
  readonly id = 'schedule-boards'

  private readonly services: DistrictServices
  private readonly group = new Object3D()
  private readonly boards: Board[] = []
  private lastBucket = -1

  constructor(services: DistrictServices) {
    this.services = services
  }

  init(ctx: GameContext): void {
    const placements = [
      { x: 8.5, z: PARK_PLAN.esplanade.zTo + 5, yaw: 0 },
      { x: -9.5, z: PARK_PLAN.atrium.z - 23, yaw: Math.PI },
    ]
    for (const placement of placements) this.buildBoard(placement.x, placement.z, placement.yaw)
    ctx.scene.add(this.group)
    this.refresh(0)

    ctx.events.on('schedule/event', () => {
      for (const board of this.boards) board.flip = 0.001
      this.lastBucket = -1
    })
  }

  update(ctx: GameContext, dt: number): void {
    const bucket = Math.floor(ctx.time.sim / 15)
    if (bucket !== this.lastBucket) {
      this.lastBucket = bucket
      for (const board of this.boards) {
        if (board.flip === 0) board.flip = 0.001
      }
    }
    for (const board of this.boards) {
      if (board.flip <= 0) continue
      board.flip = Math.min(1, board.flip + dt * 2.4)
      board.panel.rotation.x = -Math.sin(board.flip * Math.PI) * Math.PI * 0.48
      if (board.flip >= 0.5 && !board.changed) {
        board.changed = true
        drawTimetable(board.canvas, ctx.time.sim)
        board.texture.needsUpdate = true
      }
      if (board.flip >= 1) {
        board.flip = 0
        board.changed = false
        board.panel.rotation.x = 0
      }
    }
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
    this.group.traverse((object) => {
      if (object instanceof Mesh) object.geometry.dispose()
    })
    for (const board of this.boards) {
      board.texture.dispose()
      const materials = Array.isArray(board.panel.material)
        ? board.panel.material
        : [board.panel.material]
      for (const material of materials) material.dispose()
    }
  }

  private buildBoard(x: number, z: number, yaw: number): void {
    const lib = this.services.materials.lib
    if (!lib) throw new Error('ScheduleBoardSystem requires park materials')
    const y = terrainHeight(x, z)
    const boardGroup = new Object3D()
    boardGroup.position.set(x, y, z)
    boardGroup.rotation.y = yaw

    const frame = new Mesh(new BoxGeometry(6.1, 3.8, 0.22), lib.woodDark)
    frame.position.y = 3
    frame.castShadow = true
    frame.receiveShadow = true
    boardGroup.add(frame)

    const canvas = document.createElement('canvas')
    canvas.width = 1024
    canvas.height = 512
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    const panelMaterial = new MeshStandardNodeMaterial()
    panelMaterial.map = texture
    panelMaterial.color = new Color(0xffffff)
    panelMaterial.roughness = 0.64
    panelMaterial.metalness = 0.08
    const panel = new Mesh(new PlaneGeometry(5.58, 3.28), panelMaterial)
    panel.position.set(0, 3, 0.13)
    panel.castShadow = false
    panel.receiveShadow = true
    boardGroup.add(panel)

    const postGeometry = new LatheGeometry([
      new Vector2(0.18, 0), new Vector2(0.24, 0.12), new Vector2(0.14, 0.28),
      new Vector2(0.11, 4.58), new Vector2(0.17, 4.76), new Vector2(0.13, 4.88),
    ], 12)
    const footGeometry = new CylinderGeometry(0.28, 0.34, 0.12, 12)
    const finialGeometry = new SphereGeometry(0.16, 12, 8)
    for (const postX of [-2.45, 2.45]) {
      const post = new Mesh(postGeometry, lib.brass)
      post.position.set(postX, 0, 0)
      post.castShadow = true
      const foot = new Mesh(footGeometry, lib.marble)
      foot.position.set(postX, 0.06, 0)
      const finial = new Mesh(finialGeometry, lib.nacre)
      finial.position.set(postX, 4.98, 0)
      boardGroup.add(post, foot, finial)
    }
    // Layered reveal and rain-cap: the board remains readable as furniture
    // even when its texture is edge-on during the mechanical flip.
    for (const xSide of [-1, 1]) {
      const rail = new Mesh(new BoxGeometry(0.08, 3.42, 0.1), lib.brass)
      rail.position.set(xSide * 2.86, 3, 0.17)
      boardGroup.add(rail)
    }
    for (const ySide of [-1, 1]) {
      const rail = new Mesh(new BoxGeometry(5.8, 0.08, 0.1), lib.brass)
      rail.position.set(0, 3 + ySide * 1.7, 0.17)
      boardGroup.add(rail)
    }
    const roof = createNoticeBoardRoofPlan()
    for (const panelPlan of roof.panels) {
      const roofPanel = new Mesh(
        new BoxGeometry(panelPlan.width, panelPlan.thickness, panelPlan.slopeLength),
        lib.verdigris,
      )
      roofPanel.rotation.x = panelPlan.rotationX
      roofPanel.position.copy(panelPlan.position)
      const fascia = new Mesh(new BoxGeometry(6.72, 0.14, 0.1), lib.brass)
      fascia.position.set(0, roof.eaveY, panelPlan.side * roof.halfDepth)
      boardGroup.add(roofPanel, fascia)
    }
    const ridge = new Mesh(new CylinderGeometry(0.07, 0.07, roof.ridgeLength, 10), lib.brass)
    ridge.rotation.z = Math.PI / 2
    ridge.position.set(0, roof.ridgeY, 0)
    boardGroup.add(ridge)
    this.services.physics.addStaticBox(x, y + 2.75, z, 3.05, 2.75, 0.2, yaw)
    this.group.add(boardGroup)
    this.boards.push({ panel, texture, canvas, flip: 0, changed: false })
  }

  private refresh(time: number): void {
    for (const board of this.boards) {
      drawTimetable(board.canvas, time)
      board.texture.needsUpdate = true
    }
  }
}

function drawTimetable(canvas: HTMLCanvasElement, time: number): void {
  const context = canvas.getContext('2d')
  if (!context) return
  context.fillStyle = '#111815'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.strokeStyle = '#6f5b31'
  context.lineWidth = 3
  for (let y = 114; y < canvas.height; y += 94) {
    context.beginPath()
    context.moveTo(42, y)
    context.lineTo(canvas.width - 42, y)
    context.stroke()
  }
  context.textBaseline = 'middle'
  context.fillStyle = '#d7b96e'
  context.font = '32px Georgia, serif'
  context.letterSpacing = '8px'
  context.fillText('ROYAL PARK TIMETABLE', 54, 62)
  context.font = '29px Georgia, serif'
  context.letterSpacing = '3px'
  PARK_SCHEDULE.forEach((entry, index) => {
    const local = time < entry.offset ? -1 : (time - entry.offset) % entry.period
    const active = local >= 0 && local < entry.duration
    const wait = active
      ? 0
      : time < entry.offset
        ? entry.offset - time
        : entry.period - local
    const label = entry.name.replace(/-/g, ' ').toUpperCase()
    const status = active ? 'NOW' : formatWait(wait)
    const y = 154 + index * 88
    context.fillStyle = active ? '#f8d98b' : '#c7bc96'
    context.fillText(label, 56, y)
    context.textAlign = 'right'
    context.fillStyle = active ? '#fff3bc' : '#8fb6ae'
    context.fillText(status, canvas.width - 58, y)
    context.textAlign = 'left'
  })
}

function formatWait(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60)
  const remainder = Math.floor(Math.max(0, seconds) % 60)
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}
