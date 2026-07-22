// Structural audit of the compressed fauna GLBs in public/fauna/ — the
// loaded-animal counterpart of auditFaunaGeometry. Parses the glTF JSON
// chunk directly (no three, no decoders) and asserts the pipeline contract:
// size budget, required clips, triangle budget, a skinned rig, WebP-only
// textures, and no extensions the runtime pipeline can't or shouldn't
// handle (unlit/spec-gloss/draco are all normalized away at build time by
// the offline gltf-transform pass — see dev_docs/systems/wildlife.md).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const FAUNA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../public/fauna')

/** Soft target is <1 MB per animal ("we can afford to lose res"); the audit
 *  ceiling leaves headroom for re-exports without letting a 6 MB raw file
 *  sneak back in. */
const MAX_BYTES = 1_100_000

const EXPECTED = [
  { file: 'shark.glb', clips: ['swimming'], maxTriangles: 30_000 },
  { file: 'hammerhead.glb', clips: ['Action'], maxTriangles: 16_000 },
  { file: 'blue-whale.glb', clips: ['Take 001'], maxTriangles: 24_000 },
  { file: 'eagle-ray.glb', clips: ['Swim cycle'], maxTriangles: 15_000 },
  { file: 'crab.glb', clips: ['Animation'], maxTriangles: 13_000 },
  { file: 'angelfish.glb', clips: ['Swim3_Long_Wide'], maxTriangles: 3_500 },
  { file: 'tuna.glb', clips: ['SKM_Tuna|SKM_Tuna|Tuna_Swim'], maxTriangles: 4_000 },
  { file: 'seahorse.glb', clips: ['Animation'], maxTriangles: 29_000 },
]

const ALLOWED_EXTENSIONS = new Set([
  'EXT_meshopt_compression',
  'KHR_mesh_quantization',
  'EXT_texture_webp',
  'KHR_texture_transform',
])

function parseGlbJson(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB container')
  let offset = 12
  while (offset < buffer.byteLength) {
    const length = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    if (type === 0x4e4f534a) {
      return JSON.parse(Buffer.from(buffer.subarray(offset + 8, offset + 8 + length)).toString('utf8'))
    }
    offset += 8 + length + (length % 4 === 0 ? 0 : 4 - (length % 4))
  }
  throw new Error('no JSON chunk')
}

export function auditFaunaAssets() {
  const failures = []
  const assets = []
  for (const expected of EXPECTED) {
    const path = join(FAUNA_DIR, expected.file)
    let buffer
    try {
      buffer = readFileSync(path)
    } catch {
      failures.push(`${expected.file}: missing from public/fauna`)
      continue
    }
    let json
    try {
      json = parseGlbJson(buffer)
    } catch (error) {
      failures.push(`${expected.file}: unreadable GLB (${String(error)})`)
      continue
    }

    const triangles = (json.meshes ?? [])
      .flatMap((mesh) => mesh.primitives)
      .reduce((sum, prim) => {
        const indices = prim.indices !== undefined
          ? json.accessors[prim.indices].count
          : json.accessors[prim.attributes?.POSITION]?.count ?? 0
        return sum + indices / 3
      }, 0)
    const clipNames = (json.animations ?? []).map((animation) => animation.name)
    const extensions = [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]
    const nonWebp = (json.images ?? []).filter((image) => image.mimeType !== 'image/webp')

    assets.push({
      file: expected.file,
      kilobytes: Math.round(buffer.byteLength / 1024),
      triangles: Math.round(triangles),
      skins: (json.skins ?? []).length,
      clips: clipNames,
    })

    if (buffer.byteLength > MAX_BYTES) {
      failures.push(`${expected.file}: ${buffer.byteLength} bytes exceeds the ${MAX_BYTES} budget`)
    }
    if (triangles > expected.maxTriangles) {
      failures.push(`${expected.file}: ${Math.round(triangles)} triangles exceeds budget ${expected.maxTriangles}`)
    }
    if ((json.skins ?? []).length === 0) {
      failures.push(`${expected.file}: no skinned rig — the authored animation is gone`)
    }
    for (const clip of expected.clips) {
      if (!clipNames.includes(clip)) {
        failures.push(`${expected.file}: required clip '${clip}' missing (has: ${clipNames.join(', ') || 'none'})`)
      }
    }
    for (const extension of extensions) {
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        failures.push(`${expected.file}: unexpected extension '${extension}' — the pipeline should have normalized it away`)
      }
    }
    if (nonWebp.length > 0) {
      failures.push(`${expected.file}: ${nonWebp.length} non-WebP texture(s) (${nonWebp.map((image) => image.mimeType).join(', ')})`)
    }
  }
  return { assets, failures }
}
