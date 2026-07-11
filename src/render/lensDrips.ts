import type { Node } from 'three/webgpu'
import {
  Fn,
  If,
  float,
  fract,
  hash,
  mix,
  screenSize,
  screenUV,
  sin,
  smoothstep,
  step,
  uniform,
  vec2,
  vec4,
} from 'three/tsl'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { SeaSystem } from '../sea/seaSystem'
import { fbm2 } from './tslNoise'
import type { RenderPipelineSystem } from './pipeline'

/**
 * How long the clinging droplets take to dry off the lens. Short on purpose:
 * lingering refraction-only drops are invisible over flat sky/sea but shatter
 * the horizon edge into dashes — the effect must live around the crossing
 * moment, then get out of the frame (walkthrough ruling).
 */
const DROPLET_TAU = 2.0
const DROPLET_BLEED = 0.06
/** The draining film right after surfacing decays even faster. */
const SHEET_DRAIN = 2.2

interface SceneSampler {
  sample: (uv: Node<'vec2'>) => Node<'vec4'>
}

/**
 * Water on the lens. When the camera breaks the surface, a draining film
 * sweeps down, then clinging droplets and running streaks refract the scene
 * (true offset resampling of the HDR frame, so the sun and glints bloom
 * through them) and dry off over a few seconds. Keyed to the same waterline
 * crossings as the medium: every brief dip through the swell re-wets the lens.
 */
export class LensDripSystem implements GameSystem {
  readonly id = 'lens-drips'

  private readonly pipeline: RenderPipelineSystem
  private readonly sea: SeaSystem
  private readonly droplets = uniform(0)
  private readonly sheet = uniform(0)
  private readonly timeUniform = uniform(0)

  constructor(pipeline: RenderPipelineSystem, sea: SeaSystem) {
    this.pipeline = pipeline
    this.sea = sea
  }

  init(ctx: GameContext): void {
    const submerged = this.sea.visualSubmergedNode
    if (!submerged) throw new Error('LensDripSystem requires the visual waterline gate')

    ctx.events.on('sea/waterline-crossed', ({ submerged }) => {
      if (submerged) {
        // A submerged lens carries no droplets — the water IS the medium.
        this.droplets.value = 0
        this.sheet.value = 0
      } else {
        this.droplets.value = 1
        this.sheet.value = 1
      }
    })

    const droplets = this.droplets
    const sheet = this.sheet
    const time = this.timeUniform

    this.pipeline.lensTransform = (color, extras) => {
      const scene = extras.sceneColorNode as unknown as SceneSampler
      const input = color as Node<'vec4'>

      return Fn(() => {
        const result = vec4(input.rgb, 1).toVar()

        // `droplets` is uniform across the frame — a coherent branch that
        // removes every extra texture sample once the lens is dry.
        // CPU events own wet/dry history, but a delayed readback must never
        // leave an above-water lens overlay on the first underwater frame.
        const visibleDroplets = droplets.mul(float(1).sub(submerged))
        If(visibleDroplets.greaterThan(0.002), () => {
          const aspect = screenSize.x.div(screenSize.y)
          const suv = vec2(screenUV.x.mul(aspect), screenUV.y).toVar()
          const offset = vec2(0, 0).toVar()
          const mask = float(0).toVar()
          const shade = float(0).toVar()
          const spark = float(0).toVar()

          // ── Clinging droplets: two grid scales of spherical caps ─────────
          for (const [scale, seed, sizeMul] of [
            [6.0, 11.3, 1.0],
            [11.0, 37.7, 0.72],
          ] as const) {
            const grid = suv.mul(scale)
            const cell = grid.floor()
            const f = fract(grid)
            const s1 = hash(cell.dot(vec2(127.1, 311.7)).add(seed))
            const s2 = hash(cell.dot(vec2(269.5, 183.3)).add(seed))
            const exists = step(0.58, s1)
            const center = vec2(s1.mul(0.5).add(0.25), s2.mul(0.5).add(0.25))
            // Per-drop staggered drying: small drops evaporate first.
            const dry = droplets.pow(s2.mul(1.2).add(0.4))
            const radius = float(0.16).mul(sizeMul).mul(dry).add(1e-4)
            const q = f.sub(center)
            const d = q.length().div(radius)
            const inside = smoothstep(1.0, 0.72, d).mul(exists)
            // Spherical-cap normal: lateral refraction grows toward the rim,
            // so each drop carries an inverted wide-angle micro-image.
            const dome = float(1).sub(d.mul(d)).max(0.04).sqrt()
            const bend = q.div(radius).mul(d).div(dome)
            offset.addAssign(bend.mul(-0.038).mul(inside))
            mask.addAssign(inside)
            // Drop BODY: Fresnel-dark rim + a meniscus glint, so the drop
            // reads as water against any background — refraction alone only
            // shows where it crosses a contrast edge.
            shade.addAssign(smoothstep(0.45, 0.95, d).mul(inside))
            const glint = q.div(radius).sub(vec2(-0.3, 0.3)).length()
            spark.addAssign(
              smoothstep(0.34, 0.12, glint).mul(exists).mul(smoothstep(1.0, 0.85, d)).mul(dry),
            )
          }

          // ── Running streaks: heads sliding down, wet trails above ────────
          const streakLife = smoothstep(0.08, 0.6, droplets)
          const cols = float(16.0)
          const colX = suv.x.mul(cols)
          const col = colX.floor()
          const c1 = hash(col.mul(0.61).add(4.7))
          const c2 = hash(col.mul(1.37).add(9.1))
          const colExists = step(0.45, c1).mul(streakLife)
          const speed = c2.mul(0.14).add(0.1)
          const headY = fract(c1.mul(9.7).sub(time.mul(speed)))
          const wobble = sin(suv.y.mul(48.0).add(c1.mul(37.0))).mul(0.12)
          const fx = fract(colX).sub(0.5).add(wobble)
          const dy = suv.y.sub(headY)
          const headV = vec2(fx.mul(3.2), dy.mul(9.0))
          const headD = headV.length()
          const head = smoothstep(1.0, 0.55, headD).mul(colExists)
          const headDome = float(1).sub(headD.mul(headD)).max(0.06).sqrt()
          offset.addAssign(headV.div(headDome).mul(-0.015).mul(head))
          shade.addAssign(smoothstep(0.5, 0.95, headD).mul(head))
          const trail = smoothstep(0.13, 0.03, fx.abs())
            .mul(smoothstep(0.0, 0.06, dy))
            .mul(smoothstep(0.5, 0.06, dy))
            .mul(colExists)
            .mul(0.6)
          offset.addAssign(vec2(fx.mul(-0.012), 0.008).mul(trail))
          mask.addAssign(head.add(trail))

          // ── Draining film: the first moments after surfacing ─────────────
          const flow = fbm2(vec2(suv.x.mul(2.4), suv.y.mul(1.1).add(time.mul(1.6))))
          offset.addAssign(
            vec2(flow.sub(0.5).mul(0.02), flow.mul(0.03).add(0.02)).mul(sheet),
          )
          mask.addAssign(sheet.mul(0.9))

          const m = mask.clamp(0, 1)
          const sampleUV = screenUV.add(vec2(offset.x.div(aspect), offset.y))
          const warped = scene
            .sample(sampleUV)
            .rgb.mul(float(0.97).sub(shade.clamp(0, 1).mul(0.28)))
            .add(spark.clamp(0, 1).mul(0.5))
          result.assign(vec4(mix(input.rgb, warped, m), 1))
        })

        return result
      })()
    }
  }

  update(ctx: GameContext, dt: number): void {
    this.timeUniform.value = ctx.time.elapsed
    const sheet = this.sheet.value as number
    if (sheet > 0) {
      this.sheet.value = Math.max(0, sheet - dt * (sheet * SHEET_DRAIN + 0.12))
    }
    const droplets = this.droplets.value as number
    if (droplets > 0) {
      const next = droplets * Math.exp(-dt / DROPLET_TAU) - dt * DROPLET_BLEED
      this.droplets.value = next < 0.004 ? 0 : next
    }
  }
}
