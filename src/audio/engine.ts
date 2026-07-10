import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'

/**
 * Fully procedural audio (plan §12): no files, everything synthesized.
 * - Underwater ambience: filtered noise bed + slow shimmer pad.
 * - Chimes: FM bell peals on the park schedule.
 * - Interaction ticks (ticket punch).
 * The submerged state sweeps a master low-pass — crossing the waterline
 * audibly swaps worlds. Positional ride sources attach in later stages.
 */
export class AudioEngineSystem implements GameSystem {
  readonly id = 'audio'

  private context: AudioContext | null = null
  private master: GainNode | null = null
  private lowpass: BiquadFilterNode | null = null
  private started = false

  init(ctx: GameContext): void {
    // The context must start from a user gesture: the enter click.
    ctx.events.on('park/entered', () => this.start(ctx))
    ctx.events.on('schedule/event', ({ name, phase }) => {
      if (name === 'chimes' && phase === 'start') this.playChimes()
    })
    ctx.events.on('ticket/punched', () => this.playPunch())
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
  }

  private start(_ctx: GameContext): void {
    if (this.started) return
    this.started = true
    const context = new AudioContext()
    this.context = context

    const master = context.createGain()
    master.gain.value = 0.55
    const lowpass = context.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.value = 1900 // guests begin underwater
    lowpass.Q.value = 0.4
    master.connect(lowpass).connect(context.destination)
    this.master = master
    this.lowpass = lowpass

    this.buildAmbience(context, master)
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
      const white = Math.random() * 2 - 1
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
    for (const [frequency, level] of [
      [523.25, 0.012],
      [659.26, 0.009],
    ]) {
      const osc = context.createOscillator()
      osc.frequency.value = frequency
      osc.detune.value = Math.random() * 8 - 4
      const g = context.createGain()
      g.gain.value = level
      const trem = context.createOscillator()
      trem.frequency.value = 0.07 + Math.random() * 0.05
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
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
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
  private bell(frequency: number, at: number, duration = 2.6, level = 0.16): void {
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
    carrier.connect(gain).connect(master)
    modulator.start(at)
    carrier.start(at)
    modulator.stop(at + duration + 0.1)
    carrier.stop(at + duration + 0.1)
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
