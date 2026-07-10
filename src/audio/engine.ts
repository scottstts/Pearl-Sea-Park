import { Vector3 } from 'three'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { PARK_PLAN, anchorGround } from '../world/parkPlan'

/**
 * Fully procedural audio (plan §12): no files, everything synthesized.
 * - Underwater ambience: filtered noise bed + slow shimmer pad.
 * - Chimes: FM bell peals on the park schedule.
 * - Interaction ticks (ticket punch).
 * The submerged state sweeps a master low-pass — crossing the waterline
 * audibly swaps worlds. Ride, game, wildlife, and fountain sources are positional.
 */
export class AudioEngineSystem implements GameSystem {
  readonly id = 'audio'

  /** Set by main: the carousel's world position for the distance-mixed waltz. */
  waltzSource: Vector3 | null = null

  private context: AudioContext | null = null
  private master: GainNode | null = null
  private lowpass: BiquadFilterNode | null = null
  private started = false
  private waltzGain: GainNode | null = null
  private waltzFilter: BiquadFilterNode | null = null
  private waltzLoopEnd = 0
  private caveWet: GainNode | null = null
  private caveDry: GainNode | null = null
  private organGain: GainNode | null = null
  private organLoopEnd = 0
  private grottoInterior = 0
  private readonly listenerForward = new Vector3()
  private readonly listenerUp = new Vector3()
  private volume = 0.55
  private fountainActive = false
  private fountainGain: GainNode | null = null
  private fountainLoopEnd = 0

  init(ctx: GameContext): void {
    // The context must start from a user gesture: the enter click.
    ctx.events.on('park/entered', () => this.start(ctx))
    ctx.events.on('audio/volume-changed', ({ volume }) => {
      this.volume = Math.max(0, Math.min(1, volume))
      if (this.master && this.context) {
        this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.06)
      }
    })
    ctx.events.on('runtime/pause-changed', ({ paused }) => {
      const context = this.context
      if (!context) return
      if (paused) void context.suspend()
      else void context.resume()
    })
    ctx.events.on('schedule/event', ({ name, phase }) => {
      if (name === 'chimes' && phase === 'start') this.playChimes()
      if (name === 'fountain-show') {
        this.fountainActive = phase === 'start'
        this.setFountainActive()
      }
    })
    ctx.events.on('ticket/punched', () => this.playPunch())
    ctx.events.on('ticket/completed', () => this.playChimes())
    ctx.events.on('games/penny-pressed', () => this.playPunch())
    ctx.events.on('games/prize-earned', ({ prize }) => {
      const at = (this.context?.currentTime ?? 0) + 0.04
      this.bell(prize === 'paper-hat' ? 880 : 659.26, at, 1.8, 0.1)
      this.bell(prize === 'paper-hat' ? 1174.66 : 987.77, at + 0.18, 2.2, 0.08)
    })
    ctx.events.on('games/kraken-bell', ({ power, x, y, z }) => {
      this.playKrakenBell(power, x, y, z)
    })
    ctx.events.on('sea/waterline-crossed', ({ submerged }) => {
      if (this.lowpass && this.context) {
        this.lowpass.frequency.linearRampToValueAtTime(
          submerged ? 1900 : 16000,
          this.context.currentTime + 0.6,
        )
      }
    })
    // Ride machinery: cable hums while anything is being winched around.
    ctx.events.on('ride/bell-state', ({ state }) => {
      if (state === 'descending' || state === 'ascending') this.startHum('bell', 58, 0.05)
      else {
        this.stopHum('bell')
        this.bell(659.26, (this.context?.currentTime ?? 0) + 0.05, 1.9, 0.09)
      }
    })
    ctx.events.on('ride/pearl-riding', ({ riding }) => {
      if (riding) this.startHum('pearl', 84, 0.035)
      else this.stopHum('pearl')
    })
    ctx.events.on('ride/wheel-riding', ({ riding }) => {
      if (riding) this.startHum('wheel', 47, 0.045)
      else this.stopHum('wheel')
    })
    ctx.events.on('ride/carousel-riding', ({ riding }) => {
      if (riding) this.startHum('carousel', 36, 0.02)
      else this.stopHum('carousel')
    })
    ctx.events.on('ride/torrent-riding', ({ riding }) => {
      if (riding) this.startHum('torrent', 52, 0.06)
      else this.stopHum('torrent')
    })
    ctx.events.on('ride/grotto-riding', ({ riding }) => {
      if (riding) this.startHum('grotto', 42, 0.028)
      else this.stopHum('grotto')
    })
    ctx.events.on('grotto/drip', () => this.playDrip())
    ctx.events.on('wildlife/whale-cue', ({ phase }) => {
      if (phase === 'approach') this.playWhaleSong()
    })
    ctx.events.on('audio/grotto-interior', ({ amount }) => {
      this.grottoInterior = Math.max(0, Math.min(1, amount))
      const context = this.context
      if (!context) return
      this.caveWet?.gain.setTargetAtTime(this.grottoInterior * 0.62, context.currentTime, 0.22)
      this.caveDry?.gain.setTargetAtTime(1 - this.grottoInterior * 0.12, context.currentTime, 0.18)
      this.organGain?.gain.setTargetAtTime(this.grottoInterior * 0.16, context.currentTime, 0.3)
    })
  }

  private start(_ctx: GameContext): void {
    if (this.started) return
    this.started = true
    const context = new AudioContext()
    this.context = context

    const master = context.createGain()
    master.gain.value = this.volume
    const lowpass = context.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.value = 1900 // guests begin underwater
    lowpass.Q.value = 0.4
    const caveDry = context.createGain()
    caveDry.gain.value = 1
    const caveWet = context.createGain()
    caveWet.gain.value = 0
    const convolver = context.createConvolver()
    convolver.buffer = this.createCaveImpulse(context)
    master.connect(caveDry).connect(lowpass)
    master.connect(convolver).connect(caveWet).connect(lowpass)
    lowpass.connect(context.destination)
    this.master = master
    this.lowpass = lowpass
    this.caveDry = caveDry
    this.caveWet = caveWet

    this.buildAmbience(context, master)

    // The carousel waltz bus: distance sets gain + its own muffle filter.
    const waltzGain = context.createGain()
    waltzGain.gain.value = 0
    const waltzFilter = context.createBiquadFilter()
    waltzFilter.type = 'lowpass'
    waltzFilter.frequency.value = 6000
    waltzGain.connect(waltzFilter).connect(master)
    this.waltzGain = waltzGain
    this.waltzFilter = waltzFilter

    const organGain = context.createGain()
    organGain.gain.value = this.grottoInterior * 0.16
    organGain.connect(master)
    this.organGain = organGain

    const fountainGain = context.createGain()
    fountainGain.gain.value = 0.0001
    const fountainPanner = context.createPanner()
    fountainPanner.panningModel = 'HRTF'
    fountainPanner.distanceModel = 'inverse'
    fountainPanner.refDistance = 12
    fountainPanner.maxDistance = 220
    fountainPanner.rolloffFactor = 0.72
    fountainPanner.positionX.value = PARK_PLAN.tidalCourt.x
    fountainPanner.positionY.value = anchorGround(PARK_PLAN.tidalCourt) + 5
    fountainPanner.positionZ.value = PARK_PLAN.tidalCourt.z
    fountainGain.connect(fountainPanner).connect(master)
    this.fountainGain = fountainGain
    this.setFountainActive()
  }

  /** Distance-mix the waltz every frame; schedule the next loop as needed. */
  update(ctx: GameContext): void {
    const context = this.context
    if (!context) return
    const listener = context.listener
    const camera = ctx.camera
    camera.getWorldDirection(this.listenerForward)
    this.listenerUp.copy(camera.up).applyQuaternion(camera.quaternion)
    listener.positionX.value = camera.position.x
    listener.positionY.value = camera.position.y
    listener.positionZ.value = camera.position.z
    listener.forwardX.value = this.listenerForward.x
    listener.forwardY.value = this.listenerForward.y
    listener.forwardZ.value = this.listenerForward.z
    listener.upX.value = this.listenerUp.x
    listener.upY.value = this.listenerUp.y
    listener.upZ.value = this.listenerUp.z
    if (this.grottoInterior > 0.12 && context.currentTime > this.organLoopEnd - 1) {
      this.scheduleShellOrgan()
    }
    if (
      this.fountainActive
      && this.fountainGain
      && context.currentTime > this.fountainLoopEnd - 1.2
    ) {
      this.scheduleFountainPhrase()
    }
    if (!this.waltzGain || !this.waltzFilter || !this.waltzSource) return
    const d = ctx.camera.position.distanceTo(this.waltzSource)
    const gain = Math.min(0.55, 36 / Math.max(9, d * d) + (d < 26 ? 0.22 : 0))
    this.waltzGain.gain.setTargetAtTime(gain, context.currentTime, 0.4)
    this.waltzFilter.frequency.setTargetAtTime(
      Math.max(700, 7000 - d * 55),
      context.currentTime,
      0.5,
    )
    if (context.currentTime > this.waltzLoopEnd - 1.5) this.scheduleWaltzLoop()
  }

  /** Deterministic 3.8 s impulse: long stone chamber, dense quiet tail. */
  private createCaveImpulse(context: AudioContext): AudioBuffer {
    const seconds = 3.8
    const buffer = context.createBuffer(2, Math.ceil(context.sampleRate * seconds), context.sampleRate)
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel)
      for (let i = 0; i < data.length; i++) {
        const time = i / context.sampleRate
        const envelope = Math.exp(-time * 1.72) * (1 - Math.exp(-time * 38))
        data[i] = deterministicNoise(i + channel * 104729) * envelope * 0.55
      }
    }
    return buffer
  }

  /** Slow five-note shell-organ phrase; audible only through the cave bus. */
  private scheduleShellOrgan(): void {
    const context = this.context
    const out = this.organGain
    if (!context || !out) return
    const start = Math.max(context.currentTime + 0.05, this.organLoopEnd)
    const notes = [130.81, 196, 261.63, 220, 164.81]
    notes.forEach((frequency, index) => this.organTone(frequency, start + index * 1.55, 2.8, out))
    this.organLoopEnd = start + 10.5
  }

  private organTone(frequency: number, at: number, duration: number, out: GainNode): void {
    const context = this.context
    if (!context) return
    const carrier = context.createOscillator()
    carrier.type = 'sine'
    carrier.frequency.value = frequency
    const breath = context.createOscillator()
    breath.type = 'triangle'
    breath.frequency.value = frequency * 2.005
    const breathGain = context.createGain()
    breathGain.gain.value = 0.12
    const gain = context.createGain()
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(0.12, at + 0.22)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
    carrier.connect(gain)
    breath.connect(breathGain).connect(gain)
    gain.connect(out)
    carrier.start(at)
    breath.start(at)
    carrier.stop(at + duration + 0.05)
    breath.stop(at + duration + 0.05)
  }

  private setFountainActive(): void {
    const context = this.context
    const gain = this.fountainGain
    if (!context || !gain) return
    gain.gain.cancelScheduledValues(context.currentTime)
    gain.gain.setTargetAtTime(this.fountainActive ? 0.34 : 0.0001, context.currentTime, this.fountainActive ? 1.8 : 0.8)
    if (this.fountainActive && context.currentTime > this.fountainLoopEnd - 1) {
      this.scheduleFountainPhrase()
    }
  }

  /** Sixteen-bar glass-and-brass theme, continuously scheduled while the show runs. */
  private scheduleFountainPhrase(): void {
    const context = this.context
    const out = this.fountainGain
    if (!context || !out || !this.fountainActive) return
    const beat = 0.625
    const bar = beat * 4
    const start = Math.max(context.currentTime + 0.05, this.fountainLoopEnd)
    const roots = [130.81, 174.61, 196, 146.83, 130.81, 164.81, 196, 174.61]
    const intervals = [
      [1, 1.25, 1.5],
      [1, 1.2, 1.5],
      [1, 1.25, 1.5],
      [1, 1.2, 1.498],
    ]
    for (let barIndex = 0; barIndex < 16; barIndex++) {
      const root = roots[barIndex % roots.length]
      const chord = intervals[barIndex % intervals.length]
      const at = start + barIndex * bar
      this.pluck(root, at, 1.7, 0.09, out)
      chord.forEach((ratio, noteIndex) => {
        this.pluck(root * ratio * 2, at + noteIndex * beat, 0.72, 0.042, out)
      })
      const crest = root * (barIndex % 4 === 3 ? 4 : 3)
      this.bell(crest, at + beat * 3, 1.6, 0.045, out)
    }
    this.fountainLoopEnd = start + 16 * bar
  }

  private playDrip(): void {
    const context = this.context
    const master = this.master
    if (!context || !master || this.grottoInterior < 0.08) return
    const at = context.currentTime
    const oscillator = context.createOscillator()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(1180, at)
    oscillator.frequency.exponentialRampToValueAtTime(430, at + 0.12)
    const gain = context.createGain()
    gain.gain.setValueAtTime(0.045, at)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.24)
    oscillator.connect(gain).connect(master)
    oscillator.start(at)
    oscillator.stop(at + 0.26)
  }

  /**
   * The whale arrives in sound twelve seconds before it arrives in sight:
   * three slowly bending sub-bass partials plus a filtered breath layer.
   */
  private playWhaleSong(): void {
    const context = this.context
    const master = this.master
    if (!context || !master) return
    const at = context.currentTime + 0.05
    const bus = context.createGain()
    bus.gain.setValueAtTime(0.0001, at)
    bus.gain.exponentialRampToValueAtTime(0.13, at + 2.8)
    bus.gain.setValueAtTime(0.13, at + 8.5)
    bus.gain.exponentialRampToValueAtTime(0.0001, at + 16)
    const filter = context.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(260, at)
    filter.frequency.exponentialRampToValueAtTime(680, at + 10)
    bus.connect(filter).connect(master)

    for (const [frequency, bend, level] of [
      [38, 47, 0.7],
      [56, 51, 0.42],
      [76, 91, 0.2],
    ] as const) {
      const oscillator = context.createOscillator()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequency, at)
      oscillator.frequency.exponentialRampToValueAtTime(bend, at + 7)
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.84, at + 15.5)
      const gain = context.createGain()
      gain.gain.value = level
      oscillator.connect(gain).connect(bus)
      oscillator.start(at)
      oscillator.stop(at + 16.1)
    }

    const breathBuffer = context.createBuffer(1, Math.ceil(context.sampleRate * 8), context.sampleRate)
    const breath = breathBuffer.getChannelData(0)
    for (let i = 0; i < breath.length; i++) breath[i] = deterministicNoise(i + 9059) * 0.18
    const breathSource = context.createBufferSource()
    breathSource.buffer = breathBuffer
    breathSource.loop = true
    const breathFilter = context.createBiquadFilter()
    breathFilter.type = 'bandpass'
    breathFilter.frequency.value = 180
    breathFilter.Q.value = 0.8
    breathSource.connect(breathFilter).connect(bus)
    breathSource.start(at)
    breathSource.stop(at + 16.1)
  }

  /** One 16-bar music-box waltz loop (3/4, ~96 bpm), scheduled ahead. */
  private scheduleWaltzLoop(): void {
    const context = this.context
    const bus = this.waltzGain
    if (!context || !bus) return
    const beat = 0.625
    const bar = beat * 3
    const start = Math.max(context.currentTime + 0.1, this.waltzLoopEnd)
    // A-major lilt: bass on 1, chord plucks on 2 & 3, singing top line.
    const A2 = 110, E3 = 164.81, D3 = 146.83, Fs3 = 185
    const bass = [A2, E3, A2, D3, A2, E3, Fs3, E3, A2, E3, D3, E3, A2, D3, E3, A2]
    const chord: [number, number][] = [
      [277.18, 329.63], [277.18, 415.3], [277.18, 329.63], [293.66, 369.99],
      [277.18, 329.63], [329.63, 415.3], [369.99, 440], [329.63, 415.3],
      [277.18, 329.63], [329.63, 415.3], [293.66, 369.99], [329.63, 415.3],
      [277.18, 329.63], [293.66, 369.99], [329.63, 415.3], [277.18, 329.63],
    ]
    const melody: [number, number][][] = [
      [[659.26, 0]], [[554.37, 0], [659.26, 2]], [[739.99, 0]], [[659.26, 0], [554.37, 2]],
      [[440, 0]], [[493.88, 0], [554.37, 1], [587.33, 2]], [[554.37, 0]], [[493.88, 0]],
      [[440, 0], [659.26, 2]], [[880, 0]], [[739.99, 0], [659.26, 2]], [[587.33, 0]],
      [[554.37, 0], [587.33, 1], [659.26, 2]], [[554.37, 0]], [[493.88, 0], [440, 2]], [[440, 0]],
    ]
    for (let barIndex = 0; barIndex < 16; barIndex++) {
      const t0 = start + barIndex * bar
      this.pluck(bass[barIndex], t0, 1.4, 0.16, bus)
      for (const beatIndex of [1, 2]) {
        for (const f of chord[barIndex]) this.pluck(f, t0 + beatIndex * beat, 0.5, 0.05, bus)
      }
      for (const [f, onBeat] of melody[barIndex]) {
        this.pluck(f * 2, t0 + onBeat * beat, 0.9, 0.085, bus)
      }
    }
    this.waltzLoopEnd = start + 16 * bar
  }

  /** Music-box pluck: bright partial + fast decay. */
  private pluck(frequency: number, at: number, duration: number, level: number, out: GainNode): void {
    const context = this.context
    if (!context) return
    const gain = context.createGain()
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(level, at + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
    const osc = context.createOscillator()
    osc.frequency.value = frequency
    const partial = context.createOscillator()
    partial.frequency.value = frequency * 4.02
    const partialGain = context.createGain()
    partialGain.gain.setValueAtTime(level * 0.22, at)
    partialGain.gain.exponentialRampToValueAtTime(0.0001, at + duration * 0.4)
    osc.connect(gain)
    partial.connect(partialGain).connect(gain)
    gain.connect(out)
    osc.start(at)
    partial.start(at)
    osc.stop(at + duration + 0.05)
    partial.stop(at + duration + 0.05)
  }

  /** Deep, soft ambience: pink-ish noise through a slow-breathing filter. */
  private buildAmbience(context: AudioContext, out: GainNode): void {
    const seconds = 6
    const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate)
    const data = buffer.getChannelData(0)
    let b0 = 0
    let b1 = 0
    let b2 = 0
    for (let i = 0; i < data.length; i++) {
      const white = deterministicNoise(i + 4099)
      b0 = 0.997 * b0 + 0.029 * white
      b1 = 0.985 * b1 + 0.032 * white
      b2 = 0.95 * b2 + 0.048 * white
      data[i] = (b0 + b1 + b2) * 0.32
    }
    const source = context.createBufferSource()
    source.buffer = buffer
    source.loop = true

    const filter = context.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 320
    const lfo = context.createOscillator()
    lfo.frequency.value = 0.05
    const lfoGain = context.createGain()
    lfoGain.gain.value = 120
    lfo.connect(lfoGain).connect(filter.frequency)
    lfo.start()

    const gain = context.createGain()
    gain.gain.value = 0.35
    source.connect(filter).connect(gain).connect(out)
    source.start()

    // Faint shimmer pad: two detuned sines far up, very quiet.
    const shimmerVoices = [
      [523.25, 0.012],
      [659.26, 0.009],
    ] as const
    for (const [index, [frequency, level]] of shimmerVoices.entries()) {
      const osc = context.createOscillator()
      osc.frequency.value = frequency
      osc.detune.value = deterministicNoise(index + 8303) * 4
      const g = context.createGain()
      g.gain.value = level
      const trem = context.createOscillator()
      trem.frequency.value = 0.095 + deterministicNoise(index + 12109) * 0.025
      const tremGain = context.createGain()
      tremGain.gain.value = level * 0.6
      trem.connect(tremGain).connect(g.gain)
      trem.start()
      osc.connect(g).connect(out)
      osc.start()
    }
  }

  private readonly hums = new Map<string, { gain: GainNode; stop: () => void }>()

  /** Machinery hum: low sine + slow-filtered noise, faded in and out. */
  private startHum(name: string, frequency: number, level: number): void {
    const context = this.context
    const master = this.master
    if (!context || !master || this.hums.has(name)) return
    const gain = context.createGain()
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.linearRampToValueAtTime(level, context.currentTime + 1.4)

    const osc = context.createOscillator()
    osc.frequency.value = frequency
    const oscB = context.createOscillator()
    oscB.frequency.value = frequency * 1.996 // near-octave beat
    const noise = context.createBufferSource()
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate)
    const data = buffer.getChannelData(0)
    const noiseSeed = deterministicStringHash(name)
    for (let i = 0; i < data.length; i++) data[i] = deterministicNoise(i + noiseSeed)
    noise.buffer = buffer
    noise.loop = true
    const noiseFilter = context.createBiquadFilter()
    noiseFilter.type = 'bandpass'
    noiseFilter.frequency.value = frequency * 4
    noiseFilter.Q.value = 6
    const noiseGain = context.createGain()
    noiseGain.gain.value = 0.3
    osc.connect(gain)
    oscB.connect(gain)
    noise.connect(noiseFilter).connect(noiseGain).connect(gain)
    gain.connect(master)
    osc.start()
    oscB.start()
    noise.start()
    this.hums.set(name, {
      gain,
      stop: () => {
        osc.stop()
        oscB.stop()
        noise.stop()
      },
    })
  }

  private stopHum(name: string): void {
    const context = this.context
    const hum = this.hums.get(name)
    if (!context || !hum) return
    this.hums.delete(name)
    hum.gain.gain.linearRampToValueAtTime(0.0001, context.currentTime + 0.9)
    window.setTimeout(() => hum.stop(), 1100)
  }

  /** FM bell voice. */
  private bell(
    frequency: number,
    at: number,
    duration = 2.6,
    level = 0.16,
    output: AudioNode | null = null,
  ): void {
    const context = this.context
    const master = this.master
    if (!context || !master) return
    const carrier = context.createOscillator()
    carrier.frequency.value = frequency
    const modulator = context.createOscillator()
    modulator.frequency.value = frequency * 2.76
    const modGain = context.createGain()
    modGain.gain.setValueAtTime(frequency * 1.4, at)
    modGain.gain.exponentialRampToValueAtTime(1, at + duration)
    modulator.connect(modGain).connect(carrier.frequency)

    const gain = context.createGain()
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(level, at + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
    carrier.connect(gain).connect(output ?? master)
    modulator.start(at)
    carrier.start(at)
    modulator.stop(at + duration + 0.1)
    carrier.stop(at + duration + 0.1)
  }

  private playKrakenBell(power: number, x: number, y: number, z: number): void {
    const context = this.context
    const master = this.master
    if (!context || !master) return
    const panner = context.createPanner()
    panner.panningModel = 'HRTF'
    panner.distanceModel = 'inverse'
    panner.refDistance = 4
    panner.maxDistance = 90
    panner.rolloffFactor = 1.2
    panner.positionX.value = x
    panner.positionY.value = y
    panner.positionZ.value = z
    panner.connect(master)
    const at = context.currentTime + 0.02
    this.bell(110, at, 3.8, 0.16 + power * 0.08, panner)
    this.bell(440, at + 0.03, 3.2, 0.1 + power * 0.05, panner)
    window.setTimeout(() => panner.disconnect(), 4200)
  }

  /** The park's five-note call (a rising pearl of a motif). */
  playChimes(): void {
    const context = this.context
    if (!context) return
    const t = context.currentTime + 0.05
    const notes = [523.25, 659.26, 783.99, 659.26, 1046.5]
    notes.forEach((note, i) => this.bell(note, t + i * 0.55, 2.8, i === 4 ? 0.18 : 0.12))
  }

  playPunch(): void {
    const context = this.context
    const master = this.master
    if (!context || !master) return
    const t = context.currentTime
    const osc = context.createOscillator()
    osc.type = 'square'
    osc.frequency.setValueAtTime(220, t)
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.06)
    const gain = context.createGain()
    gain.gain.setValueAtTime(0.2, t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09)
    osc.connect(gain).connect(master)
    osc.start(t)
    osc.stop(t + 0.1)
    this.bell(1318.5, t + 0.1, 1.2, 0.08)
  }
}

function deterministicNoise(value: number): number {
  let h = Math.imul(value ^ 0x9e3779b9, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2) - 1
}

function deterministicStringHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
