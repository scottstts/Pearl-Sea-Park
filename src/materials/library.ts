import { Color, DoubleSide } from 'three'
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import {
  abs,
  cameraPosition,
  cos,
  dot,
  float,
  fract,
  mix,
  normalGeometry,
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
import { createClearGlassMaterial } from './glass'

/**
 * The park's material identity (plan §7), created once and shared.
 * Belle Époque under the sea: brass, verdigris, white marble, nacre, glass,
 * mosaic, iron, candy-painted wood. All lit materials receive caustic light.
 * Nothing here loads a texture — procedural TSL only.
 *
 * Authoring doctrine (procedural-materials skill): every channel of a
 * material derives from the SAME few causal fields — never one noise per
 * channel — and fine microstructure fades with camera distance before it
 * can alias into shimmer.
 */
export class ParkMaterials {
  readonly brass: MeshStandardNodeMaterial
  readonly verdigris: MeshStandardNodeMaterial
  readonly marble: MeshStandardNodeMaterial
  readonly nacre: MeshStandardNodeMaterial
  readonly iron: MeshStandardNodeMaterial
  readonly glass: MeshPhysicalNodeMaterial
  readonly lampGlobe: MeshStandardNodeMaterial
  readonly mosaic: MeshStandardNodeMaterial
  readonly woodDark: MeshStandardNodeMaterial
  readonly canvasCream: MeshStandardNodeMaterial
  readonly foliage: MeshStandardNodeMaterial
  readonly soil: MeshStandardNodeMaterial
  readonly lacquer: MeshStandardNodeMaterial
  readonly leather: MeshStandardNodeMaterial
  readonly rope: MeshStandardNodeMaterial

  constructor(medium: SeaMediumSystem) {
    const lit = (material: MeshStandardNodeMaterial, causticStrength = 1.25) => {
      medium.applyCaustics(material, causticStrength)
      return material
    }

    // Fine-detail keep: 1 close up, 0 by `far` metres — microstructure must
    // dissolve before it aliases (the ocean's pixel-footprint lesson, cheap
    // camera-distance form for opaque set dressing).
    const viewDistance = cameraPosition.sub(positionWorld).length()
    const detailKeep = (far: number) =>
      float(1).sub(smoothstep(float(far * 0.45), float(far), viewDistance))
    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const grazing = float(1).sub(dot(viewDir, normalWorld).abs())

    // ── Brass: warm polished gold — hammered tone, tarnish film, hot rim ──
    // One cause pair drives everything: `hammer` (planishing marks) sets the
    // tone AND the anisotropic-feeling roughness streaks; `tarnish` collects
    // in down-facing crevices, darkening color and roughening the film.
    this.brass = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        m.metalness = 1
        const hammer = fbm2(positionWorld.xz.mul(2.1).add(positionWorld.y))
        const streak = fbm2(
          vec2(positionWorld.y.mul(13.0), positionWorld.x.add(positionWorld.z).mul(0.9)),
        )
        const tarnish = smoothstep(0.55, 0.9, fbm2(positionWorld.xz.mul(0.7).sub(positionWorld.y.mul(0.5))))
          .mul(normalWorld.y.mul(-0.5).add(0.5).mul(0.6).add(0.4))
        const base = mix(vec3(0.74, 0.55, 0.24), vec3(0.88, 0.7, 0.35), hammer)
        const tarnished = mix(base, vec3(0.42, 0.3, 0.16), tarnish.mul(0.55))
        // Grazing rim lifts toward the lacquered-gold sheen highlight.
        m.colorNode = mix(tarnished, vec3(1.0, 0.86, 0.55), grazing.pow(3).mul(0.3))
        m.roughnessNode = hammer
          .mul(0.1)
          .add(streak.sub(0.5).mul(0.12).mul(detailKeep(28)))
          .add(tarnish.mul(0.2))
          .add(0.24)
        return m
      })(),
    )

    // ── Verdigris copper: green patina collecting on up-faces & crevices ──
    // `patina` is the single cause: it selects the copper→green identity,
    // raises roughness (oxide is matte), and drips slightly down walls.
    this.verdigris = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        const drip = positionWorld.y.mul(2.6)
        const patinaField = fbm2(positionWorld.xz.mul(1.4).add(drip.mul(0.3)))
        const up = normalWorld.y.max(0)
        const patina = smoothstep(0.32, 0.78, patinaField.add(up.mul(0.28)))
        const speck = fbm2(positionWorld.xz.mul(9.0).add(positionWorld.y.mul(6.0)))
          .sub(0.5)
          .mul(detailKeep(20))
        const copper = mix(vec3(0.4, 0.24, 0.15), vec3(0.5, 0.31, 0.18), patinaField)
        const oxide = mix(vec3(0.2, 0.45, 0.38), vec3(0.4, 0.66, 0.52), patinaField.add(speck.mul(0.6)))
        m.colorNode = mix(copper, oxide, patina)
        // Metal reads through where the patina hasn't taken.
        m.metalnessNode = float(1).sub(patina.mul(0.72))
        m.roughnessNode = mix(float(0.34), float(0.74), patina).add(speck.mul(0.1))
        return m
      })(),
    )

    // ── White marble: bedded stone — warp field carves both vein families ─
    // `warp` is the shared cause: the broad dark veins, the fine secondary
    // threads, the warm undertone drift, and the polish variation all read
    // from it, so the stone looks quarried rather than noised.
    this.marble = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        const p = positionWorld.xz.mul(0.55).add(positionWorld.y.mul(0.3))
        const warp = fbm2(p.mul(2.0)).mul(1.6)
        const bed = fbm2(p.mul(0.5).add(warp.mul(0.25)))
        const vein = abs(sin(p.x.mul(3.1).add(warp).add(p.y.mul(1.7))))
        const veinMask = smoothstep(0.94, 0.995, vein)
        const thread = abs(sin(p.x.mul(9.4).sub(warp.mul(2.1)).add(p.y.mul(5.2))))
        const threadMask = smoothstep(0.965, 0.998, thread).mul(detailKeep(40)).mul(0.45)
        const undertone = mix(vec3(0.91, 0.9, 0.86), vec3(0.87, 0.85, 0.79), bed)
        const veined = mix(undertone, vec3(0.58, 0.6, 0.64), veinMask.mul(0.55))
        m.colorNode = mix(veined, vec3(0.68, 0.68, 0.7), threadMask)
        // Veins hold polish slightly differently than the bed.
        m.roughnessNode = bed.mul(0.08).add(veinMask.mul(-0.06)).add(0.3)
        return m
      })(),
    )

    // ── Mother-of-pearl: layered aragonite interference ────────────────────
    // The `band` phase (facing angle + growth-line field) drives a full
    // cosine-palette interference sweep AND the growth-ripple roughness, so
    // hue and sheen move together as the camera orbits.
    this.nacre = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        m.metalness = 0.18
        const growth = fbm2(positionWorld.xz.mul(3.0).add(positionWorld.y.mul(2.2)))
        const facing = float(1).sub(dot(viewDir, normalWorld).abs())
        const band = facing.mul(2.6).add(growth.mul(1.1)).add(positionWorld.y.mul(0.35))
        // Iridescent interference palette around a pearl base.
        const irid = vec3(
          cos(band.mul(Math.PI * 2).add(0.0)),
          cos(band.mul(Math.PI * 2).add(2.1)),
          cos(band.mul(Math.PI * 2).add(4.2)),
        )
          .mul(0.5)
          .add(0.5)
        const pearlBase = vec3(0.9, 0.88, 0.86)
        m.colorNode = mix(pearlBase, irid.mul(0.55).add(vec3(0.45)), facing.mul(0.65).add(0.2))
        const ripple = sin(band.mul(14.0)).mul(0.5).add(0.5).mul(detailKeep(16))
        m.roughnessNode = ripple.mul(0.09).add(0.16)
        return m
      })(),
    )

    // ── Wrought iron: forged skin with mill scale and worn edges ───────────
    this.iron = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        m.metalness = 0.78
        const forge = fbm2(positionWorld.xz.mul(3.0).add(positionWorld.y.mul(2.0)))
        const scale = smoothstep(0.62, 0.85, fbm2(positionWorld.xz.mul(7.5).sub(positionWorld.y.mul(4.0))))
          .mul(detailKeep(24))
        const base = vec3(0.085, 0.095, 0.1).add(forge.mul(0.035))
        m.colorNode = mix(base, vec3(0.16, 0.15, 0.14), scale.mul(0.5)).add(
          grazing.pow(4).mul(0.05),
        )
        m.roughnessNode = forge.mul(0.14).add(scale.mul(0.18)).add(0.5)
        return m
      })(),
    )

    // ── Glass: physical transmission over the opaque scene backdrop ────────
    this.glass = createClearGlassMaterial({
      tint: new Color(0xcfe8e6),
    })

    // ── Lamp globes: frosted, warmly lit from within ───────────────────────
    // A faint mantle mottle keeps a bulb from reading as flat emissive paint;
    // the average intensity is unchanged (HDR hierarchy stays calibrated).
    this.lampGlobe = (() => {
      const m = new MeshStandardNodeMaterial()
      m.roughness = 0.55
      m.color = new Color(0xf5ecd8)
      const mantle = fbm2(positionWorld.xz.mul(6.0).add(positionWorld.y.mul(6.0)))
      m.emissiveNode = vec3(1.0, 0.85, 0.63).mul(mantle.mul(0.5).add(0.8)).mul(2.6)
      return m
    })()

    // ── Mosaic tile: worldspace grid — grout, bevel, glaze, tesserae hues ──
    // The tile `id` is the master cause: palette pick, glaze polish, and the
    // per-tile tonal wobble all derive from it; the grout line carves color,
    // roughness, AND the bevel normal so edges catch caustic light.
    this.mosaic = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        const scale = 6.5 // tiles per meter
        const cell = positionWorld.xz.mul(scale)
        const id = valueNoise2(cell.floor().mul(0.37))
        const glaze = valueNoise2(cell.floor().mul(0.91).add(7.0))
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
        const toned = palette.mul(glaze.mul(0.18).add(0.91))
        m.colorNode = mix(vec3(0.35, 0.34, 0.31), toned, grout)
        m.roughnessNode = mix(float(0.85), glaze.mul(0.26).add(0.18), grout)
        // Bevel: each tile's rim chamfers down toward the grout, so the field
        // of tesserae catches caustic glints instead of reading as one flat
        // sheet. tilt = −1 at the low-x edge, +1 at the high-x edge, 0 across
        // the tile face; fades with distance before it can shimmer. Floors
        // bake their transforms into geometry, so normalGeometry is already
        // the world up here — perturb it rather than replacing it.
        const bevel = detailKeep(30).mul(0.42)
        const tiltX = smoothstep(0.86, 1.0, local.x).sub(smoothstep(0.14, 0.0, local.x))
        const tiltZ = smoothstep(0.86, 1.0, local.y).sub(smoothstep(0.14, 0.0, local.y))
        m.normalNode = normalize(
          normalGeometry.add(vec3(tiltX.mul(bevel), 0, tiltZ.mul(bevel))),
        )
        return m
      })(),
      1.45,
    )

    // ── Dark varnished wood: grain field drives figure and sheen ──────────
    this.woodDark = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        const grain = fbm2(positionWorld.xz.mul(vec2(6, 1.2)))
        const figure = sin(grain.mul(14.0).add(positionWorld.x.mul(2.0))).mul(0.5).add(0.5)
        const fine = fbm2(positionWorld.xz.mul(vec2(26, 3.0))).sub(0.5).mul(detailKeep(14))
        m.colorNode = mix(vec3(0.3, 0.19, 0.11), vec3(0.46, 0.32, 0.185), grain)
          .add(figure.mul(0.03))
          .add(fine.mul(0.05))
        // Varnish: smooth overall, grain troughs slightly matte.
        m.roughnessNode = figure.mul(0.12).add(fine.abs().mul(0.1)).add(0.42)
        return m
      })(),
    )

    // ── Cream canvas: woven duck with thread weave and sun-fade ───────────
    this.canvasCream = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        m.side = DoubleSide
        const fade = fbm2(positionWorld.xz.mul(0.9))
        const weave = fbm2(positionWorld.xz.mul(24.0)).sub(0.5).mul(detailKeep(12))
        m.colorNode = mix(vec3(0.86, 0.81, 0.7), vec3(0.9, 0.86, 0.77), fade).add(weave.mul(0.09))
        m.roughnessNode = weave.abs().mul(0.14).add(0.82)
        return m
      })(),
    )

    // ── Planter foliage: deep teal sea-fern fronds, warm-tipped ────────────
    // Solid closed tubes (frond chains), so FrontSide is enough — no
    // DoubleSide fill-rate tax. A faint teal sub-glow keeps the beds alive
    // in colonnade shade without breaking the HDR emission hierarchy.
    this.foliage = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        const tone = fbm2(positionWorld.xz.mul(2.6).add(positionWorld.y.mul(1.9)))
        m.colorNode = mix(vec3(0.05, 0.18, 0.1), vec3(0.26, 0.5, 0.24), tone).add(
          grazing.pow(2).mul(vec3(0.05, 0.1, 0.06)),
        )
        m.roughnessNode = tone.mul(0.2).add(0.58)
        m.emissiveNode = vec3(0.004, 0.012, 0.008).mul(tone.add(0.4))
        return m
      })(),
      1.2,
    )

    // ── Planter soil: dark loam with faint speckle ─────────────────────────
    this.soil = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        m.roughness = 0.96
        const speckle = fbm2(positionWorld.xz.mul(14.0))
        m.colorNode = mix(vec3(0.09, 0.07, 0.055), vec3(0.16, 0.125, 0.09), speckle)
        return m
      })(),
      1.1,
    )

    // ── Japanned lacquer: deep torrent-teal coachwork ──────────────────────
    // Ride-vehicle body finish: a dark blue-green japan with the faint
    // large-scale depth variation of hand-brushed lacquer and a tight clear
    // coat. Grazing angles lift toward the sheen instead of washing out.
    this.lacquer = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        m.metalness = 0.12
        const depth = fbm2(positionWorld.xz.mul(0.9).add(positionWorld.y.mul(0.7)))
        m.colorNode = mix(
          mix(vec3(0.016, 0.075, 0.085), vec3(0.045, 0.13, 0.14), depth),
          vec3(0.10, 0.22, 0.22),
          grazing.mul(grazing).mul(0.55),
        )
        m.roughnessNode = depth.mul(0.08).add(0.16)
        return m
      })(),
    )

    // ── Saddle leather: oxblood upholstery with worn grain ─────────────────
    this.leather = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        m.metalness = 0
        const grain = fbm2(positionWorld.xz.mul(11.0).add(positionWorld.y.mul(7.0)))
        const wear = fbm2(positionWorld.xz.mul(1.7))
        m.colorNode = mix(
          mix(vec3(0.23, 0.075, 0.05), vec3(0.31, 0.115, 0.07), grain),
          vec3(0.38, 0.17, 0.10),
          wear.mul(0.35),
        )
        m.roughnessNode = grain.mul(0.18).add(wear.mul(0.12)).add(0.42)
        return m
      })(),
      1.15,
    )

    // ── Hemp rope: laid-line twist read as tone stripes, fibrous and matte ─
    // For fenders, rigging, windlass lines, and bollard wraps.
    this.rope = lit(
      (() => {
        const m = new MeshStandardNodeMaterial()
        m.metalness = 0
        const lay = sin(
          positionWorld.x.add(positionWorld.z).mul(34.0).add(positionWorld.y.mul(46.0)),
        )
          .mul(0.5)
          .add(0.5)
          .mul(detailKeep(10))
        const fibre = fbm2(positionWorld.xz.mul(9.0).add(positionWorld.y.mul(9.0)))
        m.colorNode = mix(vec3(0.32, 0.24, 0.14), vec3(0.46, 0.36, 0.22), fibre).sub(
          lay.mul(0.07),
        )
        m.roughnessNode = float(0.88).sub(lay.mul(0.06))
        return m
      })(),
      1.1,
    )
  }
}
