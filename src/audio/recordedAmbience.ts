import oceanAmbienceUrl from '../assets/ocean_ambiance.mp3?url'
import seagullsUrl from '../assets/seagulls.mp3?url'
import underwaterAmbienceUrl from '../assets/underwater.mp3?url'
import waterSplashUrl from '../assets/water_splash.mp3?url'

const LOOP_CROSSFADE_SECONDS = 3
const MEDIUM_CROSSFADE_SECONDS = 1.4
const ABOVE_WATER_SUBMERGE_TAIL_SECONDS = 4.5

// Dedicated source levels sit before the user's master-volume control. The
// seagull recording is naturally quieter, so it needs much less attenuation.
const OCEAN_LEVEL = 0.16
const SEAGULL_LEVEL = 0.62
const UNDERWATER_LEVEL = 0.18
const SPLASH_LEVEL = 0.28
const SPLASH_FADE_OUT_SECONDS = 0.35
const SPLASH_COOLDOWN_SECONDS = 0.75

export interface EncodedRecordedAmbience {
  ocean: ArrayBuffer
  seagulls: ArrayBuffer
  underwater: ArrayBuffer
  splash: ArrayBuffer
}

/** Fetch during park loading so entering never starts a network request. */
export async function preloadRecordedAmbience(): Promise<EncodedRecordedAmbience> {
  const [ocean, seagulls, underwater, splash] = await Promise.all([
    fetchAudioAsset(oceanAmbienceUrl, 'ocean ambience'),
    fetchAudioAsset(seagullsUrl, 'seagulls'),
    fetchAudioAsset(underwaterAmbienceUrl, 'underwater ambience'),
    fetchAudioAsset(waterSplashUrl, 'water splash'),
  ])
  return { ocean, seagulls, underwater, splash }
}

/**
 * The only recorded layer in the audio engine: seamless ambience loops
 * selected by the camera medium, plus a waterline-crossing one-shot.
 */
export class RecordedAmbience {
  private readonly context: AudioContext
  private readonly output: AudioNode
  private readonly oceanSource: AudioBufferSourceNode
  private readonly seagullSource: AudioBufferSourceNode
  private readonly underwaterSource: AudioBufferSourceNode
  private readonly splashBuffer: AudioBuffer
  private readonly oceanGain: GainNode
  private readonly seagullGain: GainNode
  private readonly underwaterGain: GainNode
  private lastSplashAt = -Infinity

  static async create(
    context: AudioContext,
    output: AudioNode,
    encoded: EncodedRecordedAmbience,
    submerged: boolean,
  ): Promise<RecordedAmbience> {
    const [decodedOcean, decodedSeagulls, decodedUnderwater, splash] = await Promise.all([
      context.decodeAudioData(encoded.ocean),
      context.decodeAudioData(encoded.seagulls),
      context.decodeAudioData(encoded.underwater),
      context.decodeAudioData(encoded.splash),
    ])

    const ocean = createCrossfadedLoopBuffer(context, decodedOcean, LOOP_CROSSFADE_SECONDS)
    const seagulls = createCrossfadedLoopBuffer(
      context,
      decodedSeagulls,
      LOOP_CROSSFADE_SECONDS,
    )
    const underwater = createCrossfadedLoopBuffer(
      context,
      decodedUnderwater,
      LOOP_CROSSFADE_SECONDS,
    )
    return new RecordedAmbience(
      context,
      output,
      ocean,
      seagulls,
      underwater,
      splash,
      submerged,
    )
  }

  private constructor(
    context: AudioContext,
    output: AudioNode,
    oceanBuffer: AudioBuffer,
    seagullBuffer: AudioBuffer,
    underwaterBuffer: AudioBuffer,
    splashBuffer: AudioBuffer,
    submerged: boolean,
  ) {
    this.context = context
    this.output = output
    this.splashBuffer = splashBuffer

    this.oceanGain = context.createGain()
    this.oceanGain.gain.value = submerged ? 0 : OCEAN_LEVEL
    this.oceanGain.connect(output)
    this.oceanSource = createLoopSource(context, oceanBuffer, this.oceanGain)

    this.seagullGain = context.createGain()
    this.seagullGain.gain.value = submerged ? 0 : SEAGULL_LEVEL
    this.seagullGain.connect(output)
    this.seagullSource = createLoopSource(context, seagullBuffer, this.seagullGain)

    this.underwaterGain = context.createGain()
    this.underwaterGain.gain.value = submerged ? UNDERWATER_LEVEL : 0
    this.underwaterGain.connect(output)
    this.underwaterSource = createLoopSource(context, underwaterBuffer, this.underwaterGain)

    const at = context.currentTime + 0.02
    this.oceanSource.start(at)
    this.seagullSource.start(at)
    this.underwaterSource.start(at)
  }

  setSubmerged(submerged: boolean): void {
    const at = this.context.currentTime
    const aboveWaterFadeSeconds = submerged
      ? ABOVE_WATER_SUBMERGE_TAIL_SECONDS
      : MEDIUM_CROSSFADE_SECONDS
    rampGain(this.oceanGain.gain, submerged ? 0 : OCEAN_LEVEL, at, aboveWaterFadeSeconds)
    rampGain(this.seagullGain.gain, submerged ? 0 : SEAGULL_LEVEL, at, aboveWaterFadeSeconds)
    rampGain(
      this.underwaterGain.gain,
      submerged ? UNDERWATER_LEVEL : 0,
      at,
      MEDIUM_CROSSFADE_SECONDS,
    )
  }

  playSplash(): void {
    const at = this.context.currentTime
    if (at - this.lastSplashAt < SPLASH_COOLDOWN_SECONDS) return
    this.lastSplashAt = at

    const source = this.context.createBufferSource()
    source.buffer = this.splashBuffer
    const gain = this.context.createGain()
    const end = at + this.splashBuffer.duration
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(SPLASH_LEVEL, at + 0.025)
    gain.gain.setValueAtTime(SPLASH_LEVEL, end - SPLASH_FADE_OUT_SECONDS)
    gain.gain.linearRampToValueAtTime(0, end)
    source.connect(gain).connect(this.output)
    source.addEventListener('ended', () => {
      source.disconnect()
      gain.disconnect()
    })
    source.start(at)
  }

  dispose(): void {
    this.oceanSource.stop()
    this.seagullSource.stop()
    this.underwaterSource.stop()
    this.oceanSource.disconnect()
    this.seagullSource.disconnect()
    this.underwaterSource.disconnect()
    this.oceanGain.disconnect()
    this.seagullGain.disconnect()
    this.underwaterGain.disconnect()
  }
}

function createLoopSource(
  context: AudioContext,
  buffer: AudioBuffer,
  output: AudioNode,
): AudioBufferSourceNode {
  const source = context.createBufferSource()
  source.buffer = buffer
  source.loop = true
  source.connect(output)
  return source
}

function rampGain(param: AudioParam, target: number, at: number, duration: number): void {
  param.cancelAndHoldAtTime(at)
  param.linearRampToValueAtTime(target, at + duration)
}

/**
 * Bake an equal-power fade-out/fade-in across each file's tail and head, then
 * use the browser's native AudioBuffer loop. This keeps looping reliable even
 * when rendering or timers are throttled in a background tab.
 */
function createCrossfadedLoopBuffer(
  context: AudioContext,
  input: AudioBuffer,
  crossfadeSeconds: number,
): AudioBuffer {
  const requestedFadeFrames = Math.round(crossfadeSeconds * input.sampleRate)
  const fadeFrames = Math.min(requestedFadeFrames, Math.floor(input.length / 4))
  const bodyFrames = input.length - fadeFrames * 2
  const loopFrames = input.length - fadeFrames
  const output = context.createBuffer(input.numberOfChannels, loopFrames, input.sampleRate)

  for (let channel = 0; channel < input.numberOfChannels; channel++) {
    const source = input.getChannelData(channel)
    const destination = output.getChannelData(channel)
    destination.set(source.subarray(fadeFrames, input.length - fadeFrames))

    for (let frame = 0; frame < fadeFrames; frame++) {
      const phase = ((frame + 1) / fadeFrames) * Math.PI * 0.5
      const fadeOut = Math.cos(phase)
      const fadeIn = Math.sin(phase)
      destination[bodyFrames + frame] =
        source[input.length - fadeFrames + frame] * fadeOut + source[frame] * fadeIn
    }
  }

  return output
}

async function fetchAudioAsset(url: string, label: string): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Could not load ${label}: ${response.status} ${response.statusText}`)
  }
  return response.arrayBuffer()
}
