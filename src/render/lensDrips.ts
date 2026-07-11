import type { Node } from 'three/webgpu'
import {
  Fn,
  If,
  clamp,
  float,
  mix,
  screenSize,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec4,
  wgslFn,
} from 'three/tsl'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { SeaSystem } from '../sea/seaSystem'
import type { RenderPipelineSystem } from './pipeline'

const WASH_DURATION = 5.0
const FINAL_FADE_START = 4.55
type WgslInclude = NonNullable<Parameters<typeof wgslFn>[1]>[number]

// FunctionNode's callable proxy is also a valid code include at runtime; the
// current @types/three declaration exposes only the callable half.
const includes = (...functions: unknown[]): WgslInclude[] =>
  functions as WgslInclude[]

interface SceneSampler {
  sample: (uv: Node<'vec2'>) => Node<'vec4'>
}

// Exact reversed-edge smoothstep used by the Heartfelt/Rain droplet field.
const sFn = wgslFn(/* wgsl */ `
  fn S(a: f32, b: f32, t: f32) -> f32 {
    let x = clamp((t - a) / (b - a), 0.0, 1.0);
    return x * x * (3.0 - 2.0 * x);
  }
`)

const n13Fn = wgslFn(/* wgsl */ `
  fn N13(p: f32) -> vec3f {
    var p3 = fract(vec3f(p) * vec3f(0.1031, 0.11369, 0.13787));
    p3 = p3 + dot(p3, p3.yzx + 19.19);
    return fract(vec3f(
      (p3.x + p3.y) * p3.z,
      (p3.x + p3.z) * p3.y,
      (p3.y + p3.z) * p3.x
    ));
  }
`)

const n1Fn = wgslFn(/* wgsl */ `
  fn N1(t: f32) -> f32 {
    return fract(sin(t * 12345.564) * 7658.76);
  }
`)

const sawFn = wgslFn(
  /* wgsl */ `
    fn Saw(b: f32, t: f32) -> f32 {
      return S(0.0, b, t) * S(1.0, b, t);
    }
  `,
  includes(sFn),
)

// Mechanical WGSL translation of the reference DropLayer2 implementation.
const dropLayer2Fn = wgslFn(
  /* wgsl */ `
    fn DropLayer2(uvInput: vec2f, t: f32) -> vec2f {
      var uv = uvInput;
      let UV = uv;

      uv.y = uv.y + t * 0.75;
      let a = vec2f(6.0, 1.0);
      let grid = a * 2.0;
      var id = floor(uv * grid);

      let colShift = N1(id.x);
      uv.y = uv.y + colShift;

      id = floor(uv * grid);
      let n = N13(id.x * 35.2 + id.y * 2376.1);
      let st = fract(uv * grid) - vec2f(0.5, 0.0);

      var x = n.x - 0.5;
      var y = UV.y * 20.0;
      let wiggle = sin(y + sin(y));
      x = x + wiggle * (0.5 - abs(x)) * (n.z - 0.5);
      x = x * 0.7;

      let ti = fract(t + n.z);
      y = (Saw(0.85, ti) - 0.5) * 0.9 + 0.5;
      let p = vec2f(x, y);
      let d = length((st - p) * a.yx);
      let mainDrop = S(0.4, 0.0, d);

      let r = sqrt(S(1.0, y, st.y));
      let cd = abs(st.x - x);
      var trail = S(0.23 * r, 0.15 * r * r, cd);
      let trailFront = S(-0.02, 0.02, st.y - y);
      trail = trail * trailFront * r * r;

      y = UV.y;
      let trail2 = S(0.2 * r, 0.0, cd);
      var droplets = max(0.0, sin(y * (1.0 - y) * 120.0) - st.y) * trail2 * trailFront * n.z;
      y = fract(y * 10.0) + (st.y - 0.5);
      let dd = length(st - vec2f(x, y));
      droplets = S(0.3, 0.0, dd);

      let m = mainDrop + droplets * r * trailFront;
      return vec2f(m, trail);
    }
  `,
  includes(n1Fn, n13Fn, sawFn, sFn),
)

const staticDropsFn = wgslFn(
  /* wgsl */ `
    fn StaticDrops(uvInput: vec2f, t: f32) -> f32 {
      var uv = uvInput * 40.0;
      let id = floor(uv);
      uv = fract(uv) - 0.5;

      let n = N13(id.x * 107.45 + id.y * 3543.654);
      let p = (n.xy - 0.5) * 0.7;
      let d = length(uv - p);
      let fade = Saw(0.025, fract(t + n.z));
      return S(0.3, 0.0, d) * fract(n.z * 10.0) * fade;
    }
  `,
  includes(n13Fn, sawFn, sFn),
)

const dropsFn = wgslFn(
  /* wgsl */ `
    fn Drops(uv: vec2f, t: f32, l0: f32, l1: f32, l2: f32) -> vec2f {
      let s = StaticDrops(uv, t) * l0;
      let m1 = DropLayer2(uv, t) * l1;
      let m2 = DropLayer2(uv * 1.85, t) * l2;

      var c = s + m1.x + m2.x;
      c = S(0.3, 1.0, c);
      return vec2f(c, max(m1.y * l0, m2.y * l1));
    }
  `,
  includes(staticDropsFn, dropLayer2Fn, sFn),
)

const rainFieldFn = wgslFn(
  /* wgsl */ `
    fn rainField(
      screenUv: vec2f,
      timeValue: f32,
      rainAmount: f32,
      speed: f32,
      normalStrength: f32,
      dropZoom: f32,
      aspect: f32
    ) -> vec4f {
      var centeredUv = (screenUv - 0.5) * vec2f(aspect, 1.0);
      let t = timeValue * 0.2 * speed;
      centeredUv = centeredUv * (0.7 * dropZoom);

      let staticDrops = S(-0.5, 1.0, rainAmount) * 2.0;
      let layer1 = S(0.25, 0.75, rainAmount);
      let layer2 = S(0.0, 0.5, rainAmount);

      let c = Drops(centeredUv, t, staticDrops, layer1, layer2);
      let e = vec2f(0.001, 0.0) * normalStrength;
      let cx = Drops(centeredUv + e, t, staticDrops, layer1, layer2).x;
      let cy = Drops(centeredUv + e.yx, t, staticDrops, layer1, layer2).x;
      let n = vec2f(cx - c.x, cy - c.x);

      return vec4f(n, c);
    }
  `,
  includes(dropsFn, sFn),
)

/**
 * The reference lens-water field, armed only when the camera emerges through
 * the displaced surface. It runs in HDR before bloom, then becomes a coherent
 * no-op after five seconds and whenever the visual waterline says submerged.
 */
export class LensDripSystem implements GameSystem {
  readonly id = 'lens-drips'

  private readonly pipeline: RenderPipelineSystem
  private readonly sea: SeaSystem
  private readonly washTime = uniform(WASH_DURATION + 1)

  constructor(pipeline: RenderPipelineSystem, sea: SeaSystem) {
    this.pipeline = pipeline
    this.sea = sea
  }

  init(ctx: GameContext): void {
    const submerged = this.sea.visualSubmergedNode
    if (!submerged) throw new Error('LensDripSystem requires the visual waterline gate')

    ctx.events.on('sea/waterline-crossed', ({ submerged }) => {
      this.washTime.value = submerged ? WASH_DURATION + 1 : 0
    })

    const washTime = this.washTime

    this.pipeline.lensTransform = (color, extras) => {
      const scene = extras.sceneColorNode as unknown as SceneSampler
      const input = color as Node<'vec4'>

      return Fn(() => {
        const result = vec4(input.rgb, 1).toVar()
        const aboveWater = float(1).sub(submerged)
        const washWeight = float(1)
          .sub(smoothstep(FINAL_FADE_START, WASH_DURATION, washTime))
          .mul(aboveWater)

        // Uniform, frame-coherent branch: all stochastic blur samples vanish
        // from the workload as soon as the five-second wash is complete.
        If(washWeight.greaterThan(0.001), () => {
          const aspect = screenSize.x.div(screenSize.y)
          // The reference fullscreen mesh UV points upward, but WebGPU
          // screenUV points downward. Run the drop field in reference space,
          // then flip only Y offsets back when sampling the scene texture.
          const effectUv = vec2(screenUV.x, float(1).sub(screenUV.y))
          const drainPhase = smoothstep(
            0.0,
            1.0,
            clamp(washTime.sub(0.18).div(4.82), 0.0, 1.0),
          )
          const rainAmount = mix(float(0.4), float(-0.15), drainPhase)
          const field = rainFieldFn({
            screenUv: effectUv,
            timeValue: washTime,
            rainAmount,
            speed: float(1.0),
            normalStrength: float(0.5),
            dropZoom: float(2.61),
            aspect,
          }) as Node<'vec4'>

          const refractedUv = screenUV.add(vec2(field.x, field.y.negate()))
          const refracted = scene.sample(refractedUv).rgb
          // The field's Z/W channels are drop-body and trail coverage. Limit
          // the scene resample to that water only: the surrounding frame keeps
          // the game's existing warmth, sharpness, exposure, and vignette.
          const dropletMask = field.z.max(field.w.mul(0.65)).clamp(0, 1).mul(washWeight)
          result.assign(vec4(mix(input.rgb, refracted, dropletMask), 1))
        })

        return result
      })()
    }
  }

  update(_ctx: GameContext, dt: number): void {
    const current = this.washTime.value as number
    if (current <= WASH_DURATION) this.washTime.value = Math.min(WASH_DURATION + 1, current + dt)
  }
}
