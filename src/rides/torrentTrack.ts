import { CatmullRomCurve3, Vector3 } from 'three'
// Leaf import with .ts extension so the offline audit
// (node --experimental-strip-types) can resolve this module directly.
import { terrainHeight } from '../world/terrainHeight.ts'

// Station anchor literals (= PARK_PLAN.torrent.station) — parkPlan's import
// chain is not audit-loadable, and terrainHeight.ts already sets the same
// precedent for the wheel basin anchor.
const STATION_ANCHOR = { x: 70, z: -165 }

/**
 * The Torrent's track authority — pure math (no renderer imports) so the
 * same authored loop drives the ride system AND the offline geometry audit
 * (`scripts/audit-geometry.mjs` samples clearance against terrainHeight).
 *
 * The loop is a closed centripetal Catmull-Rom; frames use the reference
 * coaster's ANALYTIC banked-up construction (gravity + capped centripetal
 * direction, orthonormalized against the tangent). Unlike parallel
 * transport, that construction is periodic by definition: the seam where
 * the end meets the beginning carries no accumulated twist.
 */

export const TRACK_SAMPLES = 2400
export const GRAVITY = 9.81
export const DRAG = 0.0014
export const ROLLING = 0.12
// Zone forces sized for a RHYTHM, not a constant blast (Scott's ride pass:
// "slow like climb, fast like dive"): a firm-but-gentle launch, the plunge
// owned entirely by gravity, a modest jet in the lower helix that decays to
// a slow crest and a slower shelf-return saddle, then one hard water-jet
// kick to clear the breach hump. The old 7.2/6.0/3.4 trio kept the whole
// lap pinned near max speed.
export const LAUNCH_ACCEL = 2.4
export const BOOST_ACCEL = 13
export const SURGE_ACCEL = 2.9
export const STATION_SPEED = 1.1
// Brake run: cruise home, then a √(2·a·d) ease onto the platform mark. The
// old profile targeted 2.2 m/s across the whole ~65 m zone — a 30 s crawl.
export const BRAKE_RETURN_SPEED = 8
const BRAKE_EASE = 1.3
const BRAKE_MAX_DECEL = 8
const MAX_BANK = 0.55

export interface TrackFrame {
  position: Vector3
  tangent: Vector3
  up: Vector3
  s: number
}

export interface TorrentLandmarks {
  stationS: number
  launchEndS: number
  boostStartS: number
  boostEndS: number
  surgeStartS: number
  surgeEndS: number
  /** Top of the helix climb — where the "slow crest" is measured. */
  crestS: number
  brakeStartS: number
}

export interface TorrentTrack {
  frames: TrackFrame[]
  length: number
  stationY: number
  landmarks: TorrentLandmarks
}

export function inTrackZone(length: number, s: number, from: number, to: number): boolean {
  const L = length || 1
  const rel = (((s - from) % L) + L) % L
  const span = (((to - from) % L) + L) % L
  return rel <= span
}

/**
 * Longitudinal acceleration at (s, v) — the ONE authority shared by the
 * runtime train, the design-pass banking integrator, and the offline lap
 * simulator, so the three can never drift apart. `braking` arms the brake
 * run; callers gate it (a freshly launched train still sits inside the
 * zone, whose end IS the station mark).
 */
export function trackAccel(
  length: number,
  landmarks: TorrentLandmarks,
  s: number,
  v: number,
  slope: number,
  braking: boolean,
): number {
  let a = -GRAVITY * slope - DRAG * v * Math.abs(v) - ROLLING
  if (inTrackZone(length, s, landmarks.stationS, landmarks.launchEndS)) a += LAUNCH_ACCEL
  if (inTrackZone(length, s, landmarks.boostStartS, landmarks.boostEndS)) a += BOOST_ACCEL
  if (inTrackZone(length, s, landmarks.surgeStartS, landmarks.surgeEndS)) a += SURGE_ACCEL
  if (braking && inTrackZone(length, s, landmarks.brakeStartS, landmarks.stationS)) {
    // Cruise home at BRAKE_RETURN_SPEED; inside the last metres the √ ease
    // walks the target down to the platform. min() means the brakes only
    // ever slow the train, and the decel cap keeps the grab from lurching.
    const remaining = (((landmarks.stationS - s) % length) + length) % length
    const target = Math.min(BRAKE_RETURN_SPEED, Math.sqrt(2 * BRAKE_EASE * remaining))
    a = Math.min(a, Math.max((target - v) * 2.5, -BRAKE_MAX_DECEL))
  }
  return a
}

/** Interpolated, re-orthonormalized frame at arc position s. */
export function frameOnTrack(track: TorrentTrack, s: number): TrackFrame {
  const L = track.length
  const wrapped = ((s % L) + L) % L
  const f = (wrapped / L) * TRACK_SAMPLES
  const i = Math.floor(f) % TRACK_SAMPLES
  const j = (i + 1) % TRACK_SAMPLES
  const t = f - Math.floor(f)
  const a = track.frames[i]
  const b = track.frames[j]
  const tangent = a.tangent.clone().lerp(b.tangent, t).normalize()
  const up = a.up.clone().lerp(b.up, t)
  up.addScaledVector(tangent, -up.dot(tangent)).normalize()
  return {
    position: a.position.clone().lerp(b.position, t),
    tangent,
    up,
    s: wrapped,
  }
}

export function buildTorrentTrack(): TorrentTrack {
  const st = STATION_ANCHOR
  const stationY = terrainHeight(st.x, st.z) + 1.1
  const points: Vector3[] = []
  const P = (x: number, y: number, z: number) => points.push(new Vector3(x, y, z))

  // Station straight (southbound approach joins here), launch runway north.
  P(st.x, stationY, st.z + 24) // 0 loop seam, south of station
  P(st.x, stationY, st.z) // 1 station platform
  P(st.x, stationY - 0.2, st.z - 26) // 2 launch begins
  P(st.x, stationY - 0.45, st.z - 58) // 3 launch ends
  // Low skim across the shelf tail — the rim jitter keeps solid sand out to
  // z ≈ st.z−97 on this corridor (measured; the audit enforces clearance),
  // so the dive waits for the ground to actually fall away.
  P(st.x - 6.3, -24.1, st.z - 79.7)
  P(st.x - 9.9, -23.8, st.z - 92.1)
  P(st.x - 12.6, -27, st.z - 101.4) // over the true lip
  P(st.x - 14.4, -39.5, st.z - 107.6) // the plunge steepens with the cliff
  P(st.x - 16.2, -55, st.z - 113.8)
  P(st.x - 20, -59, st.z - 120.5) // wreck bow gap — pullout spread wide
  P(st.x - 32, -57.5, st.z - 126)
  // Open void sweep flowing WEST into the helix with a valley swell (more
  // up-and-down over the abyss; the dip banks energy for the climb). The
  // helix phase is chosen so its entry tangent IS the sweep direction —
  // no turnaround anywhere (an earlier approach doubled back through one
  // control point and the spline tied a knot).
  P(st.x - 54, -62, st.z - 124)
  P(st.x - 76, -64, st.z - 121)
  // Helix climb (generated). The column stands PAST the drop-off rim — the
  // rim jitter locally extends the shelf to z ≈ st.z−105, and the original
  // helix over that ground ran its lower turns beneath the sand (the
  // reported below-seabed track). The offline audit now enforces clearance.
  // 1.5 turns from θ = 90°: enters at the circle's NORTH point heading
  // west (continuing the sweep), exits at the SOUTH point heading east —
  // the exact exit the unwind points below were authored for.
  const helixStartIndex = points.length
  const helixCenterX = st.x - 96
  const helixCenterZ = st.z - 133
  const helixRadius = 15.5
  const helixTurns = 1.5
  const helixPoints = 12
  for (let i = 0; i <= helixPoints; i++) {
    const t = i / helixPoints
    const angle = Math.PI / 2 + t * helixTurns * Math.PI * 2
    const y = -56 + t * 36 // climb to -20
    P(
      helixCenterX + Math.cos(angle) * helixRadius,
      y,
      helixCenterZ + Math.sin(angle) * helixRadius,
    )
  }
  const helixEndIndex = points.length - 1
  // Unwind the helix along its eastbound exit tangent while leveling off,
  // else the spline overshoots down into the void and the train stalls on
  // honest physics. Then the shelf return runs south over the rim.
  P(st.x - 74, -19.6, st.z - 147)
  P(st.x - 56, -18.6, st.z - 135)
  P(st.x - 44, -17.6, st.z - 87)
  // Back over the shelf, dip, torrent booster, the breach hump. The saddle
  // tops at −16.8: a genuine slow drift after the crest, but with honest
  // physics margin — at −15 the train stalled onto the speed floor here.
  P(st.x - 46, -16.8, st.z - 53)
  P(st.x - 44, -18, st.z - 26)
  P(st.x - 30, -22.5, st.z - 6) // booster dip
  P(st.x - 16, -22.5, st.z + 8) // booster (jet) straight
  // Hump shoulders sit wide at −4 so the crest arcs over ~12 m of radius
  // instead of spiking through a 1.65 m point (34°/m — 6 g at ride speed).
  P(st.x - 4, -4, st.z + 15.5)
  P(st.x + 8, 2.6, st.z + 18) // hump apex — two metres of sky
  P(st.x + 20, -4, st.z + 23)
  // Splash re-entry, then the brake run turns 180° home along one EVEN arc
  // (points distributed on the curve, not two corners) and joins the seam
  // heading north — the descent never reverses direction. (The old tail
  // dived north-east to the splash point then hairpinned straight back
  // south: the spline tied a visible knot over the brake run.)
  P(st.x + 24, -20.5, st.z + 31) // splash re-entry
  P(st.x + 21, -22.8, st.z + 41.5) // brake run begins
  P(st.x + 9, -23.2, st.z + 45.5)
  P(st.x + 2, -23.5, st.z + 40)
  const curve = new CatmullRomCurve3(points, true, 'centripetal', 0.5)

  // ── Arc-length samples ────────────────────────────────────────────────
  const positions: Vector3[] = []
  const tangents: Vector3[] = []
  for (let i = 0; i < TRACK_SAMPLES; i++) {
    const u = i / TRACK_SAMPLES
    positions.push(curve.getPointAt(u, new Vector3()))
    tangents.push(curve.getTangentAt(u, new Vector3()).normalize())
  }
  const length = curve.getLength()
  const ds = length / TRACK_SAMPLES

  const nearestS = (target: Vector3) => {
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < TRACK_SAMPLES; i++) {
      const d = positions[i].distanceToSquared(target)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best * ds
  }
  const landmarks: TorrentLandmarks = {
    stationS: nearestS(points[1]),
    launchEndS: nearestS(points[3]),
    boostStartS: nearestS(points[points.length - 8]),
    boostEndS: nearestS(points[points.length - 7]),
    surgeStartS: nearestS(points[helixStartIndex]),
    // The jet dies out 60% up the helix so the last turns climb on
    // momentum alone and the train visibly slows toward the crest.
    surgeEndS: nearestS(points[helixStartIndex + Math.round(helixPoints * 0.6)]),
    crestS: nearestS(points[helixEndIndex]),
    brakeStartS: nearestS(points[points.length - 3]),
  }

  // ── Design-pass speed profile (same integrator as runtime) ────────────
  const speeds = new Float32Array(TRACK_SAMPLES)
  {
    let s = landmarks.stationS
    let v = STATION_SPEED
    const dt = 1 / 90
    for (let iter = 0; iter < 90 * 240; iter++) {
      const i = Math.floor(s / ds) % TRACK_SAMPLES
      speeds[i] = Math.max(speeds[i], v)
      const a = trackAccel(length, landmarks, s, v, tangents[i].y, iter > 900)
      v = Math.max(0.6, v + a * dt)
      s = (s + v * dt) % length
      if (iter > 90 * 30 && Math.abs(s - landmarks.stationS) < 1) break
    }
    for (let i = 0; i < TRACK_SAMPLES; i++) if (speeds[i] === 0) speeds[i] = 2
  }

  // ── Analytic banked frames (periodic — no seam twist) ─────────────────
  // Roll authored as a SIGNED SCALAR bank angle in the zero-roll frame
  // (refUp = worldUp ⊥ tangent; side = tangent × refUp, horizontal):
  //   bank_i = atan2(min(v²·κ_lateral, G·tanMAX)·sign, G)
  // κ_lateral is the HORIZONTAL component of the curvature vector, so
  // banking answers flat turning ONLY — a pure vertical bend (the cliff
  // plunge, the breach hump) rolls exactly zero, and up-and-down stays
  // up-and-down. Two earlier constructions both corkscrewed here: scaling
  // a normalized horizontal residue by the FULL κ poured pitch curvature
  // into microscopic lateral spline noise, and boxcar-averaging up VECTORS
  // let near-opposing raws in the lip S-bend cancel, leaving a normalized
  // residue pointing ~120° off. Scalar bank smoothing cannot cancel, and
  // |bank| ≤ MAX_BANK by construction.
  const worldUp = new Vector3(0, 1, 0)
  const refUps: Vector3[] = []
  const sides: Vector3[] = []
  const rawBank = new Float32Array(TRACK_SAMPLES)
  for (let i = 0; i < TRACK_SAMPLES; i++) {
    const tangent = tangents[i]
    const refUp = worldUp.clone().addScaledVector(tangent, -worldUp.dot(tangent))
    // Near-vertical guard (steepest plunge sample is |ty| ≈ 0.93 — the
    // guard is insurance, not a code path).
    if (refUp.lengthSq() < 1e-4) refUp.copy(refUps[i - 1] ?? worldUp)
    refUp.normalize()
    const side = new Vector3().crossVectors(tangent, refUp).normalize()
    refUps.push(refUp)
    sides.push(side)
    const prev = tangents[(i - 1 + TRACK_SAMPLES) % TRACK_SAMPLES]
    const next = tangents[(i + 1) % TRACK_SAMPLES]
    const lateral = new Vector3().subVectors(next, prev).multiplyScalar(1 / (2 * ds))
    lateral.addScaledVector(worldUp, -lateral.dot(worldUp))
    const vDesign = speeds[i]
    const centripetal = Math.min(
      vDesign * vDesign * lateral.length(),
      GRAVITY * Math.tan(MAX_BANK),
    )
    rawBank[i] = Math.atan2(centripetal * Math.sign(lateral.dot(side)), GRAVITY)
  }
  const frames: TrackFrame[] = []
  const WINDOW = 32
  for (let i = 0; i < TRACK_SAMPLES; i++) {
    let bank = 0
    for (let k = -WINDOW; k <= WINDOW; k++) {
      bank += rawBank[(i + k + TRACK_SAMPLES) % TRACK_SAMPLES]
    }
    bank /= WINDOW * 2 + 1
    const up = refUps[i]
      .clone()
      .multiplyScalar(Math.cos(bank))
      .addScaledVector(sides[i], Math.sin(bank))
    frames.push({ position: positions[i], tangent: tangents[i], up, s: i * ds })
  }

  return { frames, length, stationY, landmarks }
}

/**
 * Offline geometry contract: the track must clear the seabed everywhere it
 * is over reachable ground, the seam frames must agree (no twist), and the
 * hump must genuinely breach. Run via scripts/audit-geometry.mjs.
 */
/** Integrate one full lap with the runtime physics; the ride must complete. */
export function simulateTorrentLap(track: TorrentTrack): {
  lapSeconds: number
  maxSpeed: number
  diveSpeed: number
  crestSpeed: number
  brakeSeconds: number
  completed: boolean
} {
  const { landmarks, length } = track
  let s = landmarks.stationS
  let v = STATION_SPEED
  let maxSpeed = 0
  let diveSpeed = 0
  let crestSpeed = 0
  let brakeSeconds = 0
  const dt = 1 / 90
  let launched = false
  for (let iter = 0; iter < 90 * 240; iter++) {
    const frame = frameOnTrack(track, s)
    const a = trackAccel(length, landmarks, s, v, frame.tangent.y, launched)
    v = Math.max(0.5, v + a * dt)
    maxSpeed = Math.max(maxSpeed, v)
    // Rhythm capture: the plunge/sweep max, and the speed cresting the helix.
    if (inTrackZone(length, s, landmarks.launchEndS, landmarks.surgeStartS)) {
      diveSpeed = Math.max(diveSpeed, v)
    }
    if (crestSpeed === 0 && inTrackZone(length, s, landmarks.crestS, landmarks.crestS + 2)) {
      crestSpeed = v
    }
    if (launched && inTrackZone(length, s, landmarks.brakeStartS, landmarks.stationS)) {
      brakeSeconds += dt
    }
    const step = v * dt
    if (!launched && iter * dt > 10) launched = true
    if (launched) {
      const remaining = (((landmarks.stationS - s) % length) + length) % length
      if ((remaining <= step && remaining < 8) || remaining > length - 8) {
        // Exact landing on the platform mark, same lesson as the wheel.
        return { lapSeconds: iter * dt, maxSpeed, diveSpeed, crestSpeed, brakeSeconds, completed: true }
      }
    }
    s = (s + step) % length
  }
  return { lapSeconds: 240, maxSpeed, diveSpeed, crestSpeed, brakeSeconds, completed: false }
}

export function auditTorrentTrack(): {
  length: number
  minClearance: number
  minClearanceAt: [number, number, number]
  seamUpDot: number
  seamPositionGap: number
  humpApexY: number
  maxBankDeg: number
  maxRollRateDegPerM: number
  maxTurnDegPerM: number
  maxTurnAt: [number, number, number]
  minSelfDistance: number
  brakeZoneMeters: number
  lapSeconds: number
  maxSpeed: number
  diveSpeed: number
  crestSpeed: number
  brakeSeconds: number
} {
  const track = buildTorrentTrack()
  let minClearance = Infinity
  let minAt: [number, number, number] = [0, 0, 0]
  let humpApexY = -Infinity
  for (const frame of track.frames) {
    const p = frame.position
    humpApexY = Math.max(humpApexY, p.y)
    const ground = terrainHeight(p.x, p.z)
    if (ground < -45) continue // over the void — the plunge owns this space
    if (p.y > 0.5) continue // the breach hump is out of the water
    const clearance = p.y - ground
    if (clearance < minClearance) {
      minClearance = clearance
      minAt = [p.x, p.y, p.z]
    }
  }
  const first = track.frames[0]
  const last = track.frames[TRACK_SAMPLES - 1]
  const seamUpDot = first.up.dot(last.up)
  const seamPositionGap = first.position.distanceTo(last.position)
  const brakeZoneMeters =
    (((track.landmarks.stationS - track.landmarks.brakeStartS) % track.length) + track.length) %
    track.length

  // ── Roll-axis contract (Scott's ride pass): bank is measured against the
  // zero-roll frame (worldUp ⊥ tangent) as a signed angle about the tangent;
  // its arc-rate catches corkscrew transitions the max alone would miss.
  // Near-vertical samples are skipped — bank is ill-defined there and the
  // plunge legitimately pitches past 60°.
  const worldUp = new Vector3(0, 1, 0)
  const refUp = new Vector3()
  const cross = new Vector3()
  const ds = track.length / TRACK_SAMPLES
  let maxBankDeg = 0
  let maxRollRateDegPerM = 0
  let prevBank: number | null = null
  for (let i = 0; i <= TRACK_SAMPLES; i++) {
    const frame = track.frames[i % TRACK_SAMPLES]
    const tangent = frame.tangent
    if (Math.abs(tangent.y) > 0.98) {
      prevBank = null
      continue
    }
    refUp.copy(worldUp).addScaledVector(tangent, -worldUp.dot(tangent)).normalize()
    const bank = Math.atan2(cross.crossVectors(refUp, frame.up).dot(tangent), refUp.dot(frame.up))
    maxBankDeg = Math.max(maxBankDeg, Math.abs(bank) * (180 / Math.PI))
    if (prevBank !== null) {
      let delta = bank - prevBank
      if (delta > Math.PI) delta -= Math.PI * 2
      if (delta < -Math.PI) delta += Math.PI * 2
      maxRollRateDegPerM = Math.max(maxRollRateDegPerM, (Math.abs(delta) * (180 / Math.PI)) / ds)
    }
    prevBank = bank
  }

  // ── Curvature + self-proximity contract (Scott found a literal KNOT the
  // audit missed): turn rate caps the tightest bend (10°/m ≈ 5.7 m radius —
  // a spline cusp shows hundreds), and self-distance forbids the loop from
  // passing within a train envelope of itself outside one stretch of track.
  let maxTurnDegPerM = 0
  let maxTurnAt: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < TRACK_SAMPLES; i++) {
    const a = track.frames[i].tangent
    const b = track.frames[(i + 1) % TRACK_SAMPLES].tangent
    const turn = (Math.acos(Math.min(1, Math.max(-1, a.dot(b)))) * (180 / Math.PI)) / ds
    if (turn > maxTurnDegPerM) {
      maxTurnDegPerM = turn
      const p = track.frames[i].position
      maxTurnAt = [p.x, p.y, p.z]
    }
  }
  let minSelfDistance = Infinity
  const SELF_ARC = 14 // ignore neighbours along the same stretch
  const stride = 2 // ~0.6 m sampling; full-pair cost stays offline-cheap
  for (let i = 0; i < TRACK_SAMPLES; i += stride) {
    const pi = track.frames[i].position
    for (let j = i + stride; j < TRACK_SAMPLES; j += stride) {
      const arc = Math.min((j - i) * ds, track.length - (j - i) * ds)
      if (arc < SELF_ARC) continue
      const d = pi.distanceTo(track.frames[j].position)
      if (d < minSelfDistance) minSelfDistance = d
    }
  }

  if (minClearance < 0.55) {
    throw new Error(
      `Torrent track dips beneath reachable seabed: ${minClearance.toFixed(2)} m at (${minAt
        .map((v) => v.toFixed(1))
        .join(', ')})`,
    )
  }
  if (maxTurnDegPerM > 14) {
    // 14°/m ≈ a 4 m radius floor; an actual spline cusp/knot measures
    // 50–500°/m, so this margin still flags one instantly.
    throw new Error(
      `Torrent track bends too sharply (${maxTurnDegPerM.toFixed(1)}°/m at (${maxTurnAt
        .map((v) => v.toFixed(1))
        .join(', ')}) — check for spline cusps/knots)`,
    )
  }
  if (minSelfDistance < 6) {
    throw new Error(
      `Torrent track passes within ${minSelfDistance.toFixed(1)} m of itself — knot or crossing`,
    )
  }
  if (seamUpDot < 0.999) {
    throw new Error(`Torrent loop seam carries twist (up dot ${seamUpDot.toFixed(4)})`)
  }
  if (humpApexY < 1.5) throw new Error('Torrent hump no longer breaches the surface')
  if (maxBankDeg > 34) {
    throw new Error(`Torrent banking exceeds the roll contract (${maxBankDeg.toFixed(1)}°)`)
  }
  if (maxRollRateDegPerM > 7) {
    throw new Error(`Torrent roll rate too violent (${maxRollRateDegPerM.toFixed(1)}°/m)`)
  }
  const lap = simulateTorrentLap(track)
  if (!lap.completed || lap.lapSeconds > 150) {
    throw new Error(`Torrent lap does not complete (${lap.lapSeconds.toFixed(1)} s)`)
  }
  if (lap.diveSpeed < 20) {
    throw new Error(`Torrent plunge lost its rush (${lap.diveSpeed.toFixed(1)} m/s)`)
  }
  if (lap.crestSpeed < 2 || lap.crestSpeed > 15) {
    throw new Error(`Torrent helix crest no longer reads slow (${lap.crestSpeed.toFixed(1)} m/s)`)
  }
  return {
    length: track.length,
    minClearance,
    minClearanceAt: minAt,
    seamUpDot,
    seamPositionGap,
    humpApexY,
    maxBankDeg,
    maxRollRateDegPerM,
    maxTurnDegPerM,
    maxTurnAt,
    minSelfDistance,
    brakeZoneMeters,
    lapSeconds: lap.lapSeconds,
    maxSpeed: lap.maxSpeed,
    diveSpeed: lap.diveSpeed,
    crestSpeed: lap.crestSpeed,
    brakeSeconds: lap.brakeSeconds,
  }
}
