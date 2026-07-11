import './styles.css'
import { PerspectiveCamera, Scene } from 'three'
import { AudioEngineSystem } from './audio/engine'
import { getBookmark, parseFlags } from './core/debug'
import { DebugOverlaySystem } from './core/debugOverlay'
import { EventBus } from './core/events'
import type { GameEvents } from './core/gameEvents'
import { recordAutoRuntimeSample, selectInitialQuality } from './core/autoQuality'
import { Rng } from './core/prng'
import { QualityState } from './core/quality'
import { auditPostcardBookmarks } from './core/postcards'
import { SchedulerSystem } from './core/scheduler'
import { MaterialsSystem } from './materials/materialsSystem'
import { PhysicsSystem } from './physics/physicsWorld'
import { HeldItemSystem } from './player/heldItems'
import { InteractionSystem } from './player/interact'
import { PlayerSystem } from './player/player'
import { SeatSystem } from './player/seats'
import { LensDripSystem } from './render/lensDrips'
import { RenderPipelineSystem } from './render/pipeline'
import { createRenderer, webgpuAvailable } from './render/renderer'
import { enableMainDetailLayer } from './render/layers'
import { FramePerformanceMonitor } from './render/performanceMonitor'
import { CarouselSystem } from './rides/carousel'
import { DescentBellSystem } from './rides/descentBell'
import { GreatWheelSystem } from './rides/greatWheel'
import { GrottoSystem } from './rides/grotto/grottoSystem'
import { GamesSystem } from './games/gamesSystem'
import { PearlLineSystem } from './rides/pearlLine'
import { TorrentSystem } from './rides/torrent'
import type { GameContext } from './runtime/context'
import { GameLoop } from './runtime/loop'
import { SystemRegistry } from './runtime/registry'
import { SeaMediumSystem } from './sea/medium'
import { SeaSystem } from './sea/seaSystem'
import { SkySystem } from './sky/skySystem'
import { BubbleFountainSystem } from './shows/bubbleFountain'
import { ScheduleBoardSystem } from './shows/scheduleBoard'
import { createTicketScreen } from './ui/ticketScreen'
import { PauseCardSystem } from './ui/pauseCard'
import { ArrivalSystem } from './world/arrival'
import { DevOrbitSystem } from './world/devOrbit'
import type { DistrictServices } from './world/districts/atrium'
import { AtriumSystem } from './world/districts/atrium'
import { FacilitySignsSystem } from './world/facilitySigns'
import { FloraSystem } from './world/flora'
import { ParkAssemblySystem } from './world/parkAssembly'
import { ParkAmenitiesSystem } from './world/parkAmenities'
import { TerrainSystem, terrainHeight } from './world/terrain'
import { TestGallerySystem } from './world/testGallery'
import { WildlifeSystem } from './wildlife/wildlifeSystem'

const DEFAULT_SEED = 19051906 // the year the gates first opened

async function boot(): Promise<void> {
  const ticket = createTicketScreen(document.body)
  const flags = parseFlags()

  if (!(await webgpuAvailable())) {
    ticket.showError(
      'This experience requires WebGPU',
      'The Pearl is rendered with WebGPU only. Please visit with a current Chrome, Edge, or Safari on a machine whose GPU is supported.',
    )
    return
  }

  const canvas = document.createElement('canvas')
  canvas.id = 'scene'
  document.body.prepend(canvas)

  ticket.setProgress('render-pipeline', 0.05)
  let renderer
  try {
    renderer = await createRenderer(canvas)
  } catch {
    ticket.showError(
      'This experience requires WebGPU',
      'A WebGPU adapter was found but could not be initialized. Please update your browser or graphics drivers.',
    )
    return
  }

  ticket.setProgress('quality-benchmark', 0.075)
  const qualitySelection = await selectInitialQuality(renderer, flags.tier)
  canvas.dataset.qualitySelection = JSON.stringify(qualitySelection)

  const scene = new Scene()
  // Far plane covers the sky dome (3400 m) and ocean skirt; near stays tight
  // for held items. WebGPU float depth keeps this ratio artifact-free.
  const camera = new PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 5000)
  enableMainDetailLayer(camera)

  const ctx: GameContext = {
    renderer,
    scene,
    camera,
    events: new EventBus<GameEvents>(),
    rng: new Rng(flags.seed ?? DEFAULT_SEED),
    flags,
    quality: new QualityState(qualitySelection.tier, qualitySelection.initialRenderScale),
    // The park clock begins at the gate click, not while the ticket waits.
    time: {
      elapsed: flags.fixedTime ?? 0,
      sim: flags.fixedTime ?? 0,
      frame: 0,
      paused: true,
    },
  }

  const handleResize = (): void => {
    const width = window.innerWidth
    const height = window.innerHeight
    renderer.setSize(width, height)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    ctx.events.emit('render/resized', { width, height, renderScale: ctx.quality.renderScale })
  }
  window.addEventListener('resize', handleResize)

  const registry = new SystemRegistry()
  const pipeline = new RenderPipelineSystem()
  if (flags.debug) registry.add(new DebugOverlaySystem())
  if (flags.view === 'gallery') {
    registry.add(new TestGallerySystem())
    registry.add(new DevOrbitSystem())
  } else {
    registry.add(new SkySystem())
    const sea = registry.add(new SeaSystem())
    const medium = registry.add(new SeaMediumSystem(pipeline, sea))
    registry.add(new LensDripSystem(pipeline))
    registry.add(new TerrainSystem(medium))
    registry.add(new FloraSystem(medium))
    const physics = registry.add(new PhysicsSystem())
    const materials = registry.add(new MaterialsSystem(medium))
    const amenities = registry.add(new ParkAmenitiesSystem(materials))
    registry.add(new ArrivalSystem(physics, materials))
    const services: DistrictServices = { physics, materials, amenities }
    let player: PlayerSystem | null = null
    let heldItems: HeldItemSystem | null = null
    if (flags.view) {
      // Fixed validation cameras inspect with orbit controls, not the player.
      registry.add(new DevOrbitSystem())
    } else {
      player = registry.add(new PlayerSystem(physics))
      registry.add(new PauseCardSystem(player))
      const interaction = registry.add(new InteractionSystem())
      const seats = registry.add(new SeatSystem(player, interaction))
      services.seats = seats
      services.interaction = interaction
      heldItems = registry.add(new HeldItemSystem())
    }
    registry.add(new AtriumSystem(services))
    registry.add(new ParkAssemblySystem(services))
    registry.add(new FacilitySignsSystem(services, terrainHeight))
    registry.add(new DescentBellSystem(services, player))
    registry.add(new PearlLineSystem(services, player))
    registry.add(new GreatWheelSystem(services, player))
    registry.add(new TorrentSystem(services, player))
    registry.add(new GrottoSystem(services, player, medium))
    const carousel = registry.add(new CarouselSystem(services, player))
    registry.add(new WildlifeSystem(services, medium))
    registry.add(new BubbleFountainSystem(services, medium))
    registry.add(new ScheduleBoardSystem(services))
    registry.add(new GamesSystem(services, medium, heldItems))
    registry.add(new SchedulerSystem())
    const audio = registry.add(new AudioEngineSystem())
    audio.waltzSource = carousel.center
  }
  registry.add(pipeline)

  await registry.init(ctx, (label, index, total) =>
    ticket.setProgress(label, 0.1 + 0.9 * (index / Math.max(1, total))),
  )
  const postcardAudit = auditPostcardBookmarks()
  canvas.dataset.postcardAudit = JSON.stringify(postcardAudit)
  if (!postcardAudit.complete) {
    throw new Error(`Missing postcard bookmarks: ${postcardAudit.missing.join(', ')}`)
  }

  // Postcard/validation cameras: ?view=<bookmark>. Default pose: arrival.
  const startView = flags.view ?? 'arrival'
  const bookmark = getBookmark(startView)
  if (bookmark) {
    camera.position.set(...bookmark.position)
    camera.lookAt(...bookmark.look)
  }

  if (flags.debug) {
    // Console/automation handle for live inspection (agents + humans).
    ;(window as unknown as { __pearl: object }).__pearl = {
      ctx,
      registry,
      qualitySelection,
      postcardAudit,
    }
  }

  const loop = new GameLoop(ctx, registry)
  loop.renderFrame = () => pipeline.render()
  const performanceMonitor = new FramePerformanceMonitor(renderer)
  loop.onFrameEnd = (timing) => {
    performanceMonitor.sample(timing, ctx.time.frame)
    ctx.quality.submitFrame(timing.frameIntervalMs, timing.nowMs)
    if (ctx.time.frame % 60 === 0) {
      const info = renderer.info
      const performance = performanceMonitor.snapshot()
      recordAutoRuntimeSample(
        qualitySelection,
        ctx.quality.tier,
        ctx.quality.renderScale,
        performance.presentedFrameMs,
      )
      canvas.dataset.performance = JSON.stringify({
        ...performance,
        tier: ctx.quality.tier,
        renderScale: ctx.quality.renderScale,
        drawCalls: info.render.drawCalls,
        triangles: info.render.triangles,
        points: info.render.points,
        computeCalls: info.compute.frameCalls,
        renderTargets: info.memory.renderTargets,
        gpuResourceBytes: info.memory.total,
      })
    }
  }
  loop.start()

  // Validation shortcuts (?view / ?pass) skip the enter gate entirely.
  const validationMode = flags.view !== null || flags.pass !== 'final' || flags.fixedTime !== null
  if (!validationMode) await ticket.showEnter()
  ticket.hide()
  ctx.time.paused = false
  ctx.events.emit('park/entered', {})
}

void boot()
