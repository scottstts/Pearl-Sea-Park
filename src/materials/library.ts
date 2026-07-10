import { Color, DoubleSide } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import {
  abs,
  cameraPosition,
  dot,
  float,
  fract,
  mix,
  normalWorld,
  normalize,
  positionWorld,
  sin,
  smoothstep,
  vec2,
  vec3,
} from 'three/tsl'
import { fbm2, valueNoise2 } from '../render/tslNoise'
import type { SeaMediumSystem } from '../sea/medium'

/**
 * The park's material identity (plan §7), created once and shared.
 * Belle Époque under the sea: brass, verdigris, white marble, nacre, glass,
 * mosaic, iron, candy-painted wood. All lit materials receive caustic light.
 * Nothing here loads a texture — procedural TSL only.
 */
export class ParkMaterials {
  readonly brass: MeshStandardNodeMaterial
  readonly verdigris: MeshStandardNodeMaterial
  readonly marble: MeshStandardNodeMaterial
  readonly nacre: MeshStandardNodeMaterial
  readonly iron: MeshStandardNodeMaterial
  readonly glass: MeshStandardNodeMaterial
  readonly lampGlobe: MeshStandardNodeMaterial
  readonly mosaic: MeshStandardNodeMaterial
  readonly woodDark: MeshStandardNodeMaterial
  readonly canvasCream: MeshStandardNodeMaterial

  constructor(medium: SeaMediumSystem) {
    const lit = (material: MeshStandardNodeMaterial, causticStrength = 1.25) => {
      medium.applyCaustics(material, causticStrength)
      return material
    }

    // ── Brass: warm gold, faint hammered variation ─────────────────────────
    this.brass = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        m.metalness = 1
        const tone = fbm2(positionWorld.xz.mul(2.1).add(positionWorld.y))
        m.colorNode = mix(vec3(0.72, 0.54, 0.25), vec3(0.85, 0.68, 0.34), tone)
        m.roughnessNode = tone.mul(0.14).add(0.26)
        return m
      })(),
    )

    // ── Verdigris copper: green patina collecting in crevices ─────────────
    this.verdigris = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        m.metalness = 0.85
        const patina = fbm2(positionWorld.xz.mul(1.4).add(positionWorld.y.mul(0.8)))
        const up = normalWorld.y.max(0)
        const amount = smoothstep(0.35, 0.75, patina.add(up.mul(0.25)))
        m.colorNode = mix(vec3(0.45, 0.28, 0.17), vec3(0.28, 0.5, 0.42), amount)
        m.roughnessNode = amount.mul(0.35).add(0.35)
        return m
      })(),
    )

    // ── White marble with soft veining ─────────────────────────────────────
    this.marble = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        m.roughness = 0.32
        const p = positionWorld.xz.mul(0.55).add(positionWorld.y.mul(0.3))
        const warp = fbm2(p.mul(2.0)).mul(1.6)
        const vein = abs(sin(p.x.mul(3.1).add(warp).add(p.y.mul(1.7))))
        const veinMask = smoothstep(0.94, 0.995, vein).mul(0.5)
        m.colorNode = mix(vec3(0.9, 0.89, 0.85), vec3(0.62, 0.63, 0.66), veinMask)
        return m
      })(),
    )

    // ── Mother-of-pearl: view-dependent iridescent sheen ───────────────────
    this.nacre = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        m.roughness = 0.22
        m.metalness = 0.15
        const viewDir = normalize(cameraPosition.sub(positionWorld))
        const facing = float(1).sub(dot(viewDir, normalWorld).abs())
        const band = fract(facing.mul(2.2).add(fbm2(positionWorld.xz.mul(3.0)).mul(0.5)))
        const hue = mix(
          mix(vec3(0.93, 0.87, 0.86), vec3(0.82, 0.89, 0.94), smoothstep(0.0, 0.5, band)),
          vec3(0.9, 0.86, 0.95),
          smoothstep(0.5, 1.0, band),
        )
        m.colorNode = hue
        return m
      })(),
    )

    // ── Wrought iron ───────────────────────────────────────────────────────
    this.iron = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        m.metalness = 0.75
        m.roughness = 0.58
        m.colorNode = vec3(0.09, 0.1, 0.1).add(
          fbm2(positionWorld.xz.mul(3.0)).mul(0.03),
        )
        return m
      })(),
    )

    // ── Glass: decorative panes (the sea is air — glass is jewelry now) ────
    this.glass = (() => {
      const m = new MeshStandardNodeMaterial()
      m.transparent = true
      m.opacity = 0.07
      m.roughness = 0.03
      m.metalness = 0
      m.color = new Color(0xcfe8e6)
      m.side = DoubleSide
      m.depthWrite = false
      m.envMapIntensity = 0.25
      return m
    })()

    // ── Lamp globes: frosted, warmly lit from within ───────────────────────
    this.lampGlobe = (() => {
      const m = new MeshStandardNodeMaterial()
      m.roughness = 0.55
      m.color = new Color(0xf5ecd8)
      m.emissive = new Color(0xffd9a0)
      m.emissiveIntensity = 2.6
      return m
    })()

    // ── Mosaic tile: worldspace grid with grout, shell palette ─────────────
    this.mosaic = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        const scale = 6.5 // tiles per meter
        const cell = positionWorld.xz.mul(scale)
        const id = valueNoise2(cell.floor().mul(0.37))
        const local = fract(cell)
        const grout = smoothstep(0.0, 0.09, local.x)
          .mul(smoothstep(1.0, 0.91, local.x))
          .mul(smoothstep(0.0, 0.09, local.y))
          .mul(smoothstep(1.0, 0.91, local.y))
        const palette = mix(
          mix(vec3(0.85, 0.82, 0.74), vec3(0.55, 0.71, 0.7), smoothstep(0.25, 0.55, id)),
          vec3(0.76, 0.62, 0.42),
          smoothstep(0.72, 0.95, id),
        )
        m.colorNode = mix(vec3(0.35, 0.34, 0.31), palette, grout)
        m.roughnessNode = mix(float(0.85), float(0.3), grout)
        return m
      })(),
      1.45,
    )

    // ── Painted / dark woods & canvas ──────────────────────────────────────
    this.woodDark = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        m.roughness = 0.7
        const grain = fbm2(positionWorld.xz.mul(vec2(6, 1.2)))
        m.colorNode = mix(vec3(0.32, 0.21, 0.12), vec3(0.45, 0.31, 0.18), grain)
        return m
      })(),
    )

    this.canvasCream = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        m.roughness = 0.9
        m.side = DoubleSide
        m.colorNode = vec3(0.88, 0.83, 0.72).add(fbm2(positionWorld.xz.mul(9.0)).mul(0.05))
        return m
      })(),
    )
  }
}
