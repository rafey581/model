import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * Loader for the Blender-built snooker table (packages/client/public/snooker_table.glb).
 *
 * The .glb is authored in metres, Blender Z-up, exported +Y up, origin at the centre of the
 * cloth with the cloth top at y = 0. Blender X (length) -> three X, Blender Y (width) -> three -Z.
 * The table is symmetric, so the Z flip has no visible effect; the ball box sits under the -X
 * (baulk) end, which matches tableX(BAULK_LINE_X) < 0.
 *
 * Usage:
 *   preloadTableModel()                      // once at app boot (online path has no async window)
 *   const src = tableModelIfReady()          // inside Scene3D, synchronous
 *   if (src) scene.add(instantiateTableModel(src, materials, { cloth: 'model' }))
 *   else     ...build the code table as before...
 *
 * instantiateTableModel() clones and merges geometry per material on every call, so each
 * Scene3D owns its geometry and Scene3D.dispose() can free it safely (scene is rebuilt per match).
 */

export const TABLE_MODEL_URL = '/snooker_table.glb'

export const TABLE_MATERIAL_NAMES = [
  'Wood',
  'Brass',
  'JawCloth',
  'Leather',
  'NetCord',
  'DarkInterior',
  'Nameplate',
  'Iron',
  'Cloth'
] as const
export type TableMaterialName = (typeof TABLE_MATERIAL_NAMES)[number]
export type TableMaterials = Partial<Record<TableMaterialName, THREE.Material>>

/**
 * Suffix on the mesh name of everything under the table: the legs.
 *
 * They are merged apart from the rest of their material so the scene can give them a
 * cheaper finish when frames are short, without touching the rails, cushions and pockets
 * the player is actually looking at.
 */
export const TABLE_LEGS_SUFFIX = ':legs'

/** Metres in the file -> millimetres in the game. */
const MODEL_SCALE = 1000

let loading: Promise<THREE.Group | null> | null = null
let loaded: THREE.Group | null = null

/** Start (or reuse) the download + parse. Never rejects: resolves null on failure. */
export function preloadTableModel(url: string = TABLE_MODEL_URL): Promise<THREE.Group | null> {
  if (loading) return loading
  const pending = (async (): Promise<THREE.Group | null> => {
    console.info('[tableModel] preload start', url)
    try {
      // Fetch first rather than GLTFLoader.loadAsync so an SPA fallback is visible:
      // a dev server with no /public entry answers a missing .glb with HTTP 200 and
      // text/html (index.html), and the loader would then fail as a JSON parse error
      // that says nothing about the real cause. Logging the content-type names it.
      const res = await fetch(url)
      const contentType = res.headers.get('content-type') ?? ''
      console.info(`[tableModel] preload ${url} -> HTTP ${res.status} ${contentType}`)
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      const buffer = await res.arrayBuffer()
      console.info(`[tableModel] preload ${url} -> ${buffer.byteLength} bytes`)
      const gltf = await new GLTFLoader().parseAsync(buffer, '')
      const group: THREE.Group = gltf.scene
      group.updateMatrixWorld(true)
      loaded = group
      console.info(`[tableModel] preload success ${url} (${group.children.length} root nodes)`)
      return group
    } catch (err) {
      console.warn(`[tableModel] preload FAILED ${url} - falling back to the code-built table`, err)
      loading = null // allow a retry on the next match
      return null
    }
  })()
  loading = pending
  return pending
}

/** The parsed model if the preload has finished, else null (synchronous, for Scene3D). */
export function tableModelIfReady(): THREE.Group | null {
  return loaded
}

export interface InstantiateOptions {
  /**
   * 'model'  -> keep the model's Cloth mesh (its outline follows the cushion knuckles and the
   *             set-back middle pockets exactly). Give it the game's clothMat; its UVs use the
   *             same 0..1 mapping across the playing area as bedGeo.
   * 'hidden' -> drop it and keep the game's own bed (only correct if the bed's pocket notches
   *             are updated to the model's pocket geometry, see notes).
   */
  cloth?: 'model' | 'hidden'
  /**
   * Add per-vertex shading to the JawCloth geometry so the cushion reads as a raised, lit
   * roll (top brighter than the vertical face, throats darker) without editing the .glb.
   * Requires the JawCloth material to have `vertexColors: true`.
   */
  cushionShading?: boolean
  /** Rotate the wood grain on the short-rail caps so it runs along the table, not across it. */
  rotateShortRailWoodUV?: boolean
}

/** Build a fresh, game-ready group: one merged mesh per material (9 draw calls). */
export function instantiateTableModel(
  source: THREE.Group,
  materials: TableMaterials,
  opts: InstantiateOptions = {}
): THREE.Group {
  const clothMode = opts.cloth ?? 'model'
  source.updateMatrixWorld(true)

  const buckets = new Map<string, THREE.BufferGeometry[]>()
  source.traverse((obj: THREE.Object3D) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const material = mat?.name ?? ''
    // The model names its under-table parts `Legs_*`; they keep their material but get a
    // bucket, and so a mesh, of their own.
    const name = /^Legs/i.test(mesh.name) ? material + TABLE_LEGS_SUFFIX : material
    const geo = normaliseAttributes(mesh.geometry.clone())
    geo.applyMatrix4(mesh.matrixWorld)
    const list = buckets.get(name)
    if (list) list.push(geo)
    else buckets.set(name, [geo])
  })

  const group = new THREE.Group()
  group.name = 'snooker-table-model'
  for (const [bucket, geos] of buckets) {
    const legs = bucket.endsWith(TABLE_LEGS_SUFFIX)
    const name = legs ? bucket.slice(0, -TABLE_LEGS_SUFFIX.length) : bucket
    if (name === 'Cloth' && clothMode === 'hidden') {
      geos.forEach((g) => g.dispose())
      continue
    }
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false)
    if (geos.length > 1) geos.forEach((g) => g.dispose())
    if (!merged) {
      console.warn(`[tableModel] could not merge geometry for material "${name}"`)
      continue
    }
    merged.scale(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE)
    if (name === 'Cloth') {
      // Blender's glTF exporter writes v as (1 - v). The game's felt is a CanvasTexture with
      // flipY = true on bedGeo's convention v = (shapeY + W/2) / W, so undo the export flip
      // to get the markings pixel-identical to the code-built bed.
      const uv = merged.getAttribute('uv') as THREE.BufferAttribute | undefined
      if (uv) {
        for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i))
        uv.needsUpdate = true
      }
    }
    if (name === 'JawCloth' && opts.cushionShading) applyCushionShading(merged)
    if (name === 'Wood' && opts.rotateShortRailWoodUV) applyShortRailWoodUV(merged)
    merged.computeBoundingBox()
    merged.computeBoundingSphere()

    const material = materials[name as TableMaterialName] ?? fallbackMaterial(name)
    const mesh = new THREE.Mesh(merged, material)
    mesh.name = `table:${name || 'unnamed'}${legs ? TABLE_LEGS_SUFFIX : ''}`
    // Cloth must never receive shadows (selfCheck relies on it); thin nets make shadow acne.
    mesh.castShadow = name !== 'Cloth' && name !== 'NetCord'
    mesh.receiveShadow = name !== 'Cloth'
    if (name === 'Cloth') mesh.renderOrder = -1
    group.add(mesh)
  }
  return group
}

/** Keep only position / normal / uv (all indexed) so mergeGeometries accepts every mesh. */
function normaliseAttributes(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const key of Object.keys(geo.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'uv') geo.deleteAttribute(key)
  }
  const position = geo.getAttribute('position') as THREE.BufferAttribute | undefined
  const count = position ? position.count : 0
  if (!geo.getAttribute('normal')) geo.computeVertexNormals()
  if (!geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2))
  if (!geo.index) {
    const idx = count > 65535 ? new Uint32Array(count) : new Uint16Array(count)
    for (let i = 0; i < count; i++) idx[i] = i
    geo.setIndex(new THREE.BufferAttribute(idx, 1))
  }
  geo.morphAttributes = {}
  geo.clearGroups()
  return geo
}

/** Flat placeholders matching the Blender script, used for any material the game does not supply. */
const FALLBACK: Record<string, [number, number, number, number, number]> = {
  //            r      g      b      metal  rough
  Wood: [0.13, 0.018, 0.012, 0.0, 0.18],
  Brass: [0.86, 0.6, 0.2, 1.0, 0.28],
  JawCloth: [0.04, 0.38, 0.09, 0.0, 0.85],
  Leather: [0.86, 0.79, 0.66, 0.0, 0.55],
  NetCord: [0.93, 0.93, 0.91, 0.0, 0.75],
  DarkInterior: [0.015, 0.015, 0.015, 0.0, 0.9],
  Nameplate: [0.9, 0.9, 0.88, 0.0, 0.22],
  Iron: [0.03, 0.03, 0.03, 1.0, 0.4],
  Cloth: [0.05, 0.36, 0.08, 0.0, 0.9]
}

function fallbackMaterial(name: string): THREE.Material {
  const [r, g, b, metalness, roughness] = FALLBACK[name] ?? [0.5, 0.5, 0.5, 0, 0.6]
  return new THREE.MeshStandardMaterial({
    name,
    color: new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace),
    metalness,
    roughness,
    side: name === 'NetCord' ? THREE.DoubleSide : THREE.FrontSide
  })
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Cushions, baked to vertex colours (multiplied by the material's own green).
 *
 * The cushions' vertical faces and their tops are the same material, so without this the
 * whole rubber roll is one flat tone. A vertex colour keyed off the surface normal lifts the
 * top (which faces the lamp) above the face, and drops the throats beside each pocket into
 * shadow — the difference between a moulded roll and a flat band. Done here rather than in
 * the .glb because the model must not be edited, and it costs nothing per frame.
 */
function applyCushionShading(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined
  if (!pos || !nrm) return
  const FACE = 0.56
  const TOP = 1.0
  const THROAT = 0.4
  const colors = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const ny = nrm.getY(i)
    const py = pos.getY(i)
    let f: number
    if (py < 0.5 && Math.abs(ny) < 0.2) {
      f = THROAT
    } else {
      f = FACE + (TOP - FACE) * smoothstep(0.15, 0.85, Math.max(0, ny))
    }
    colors[i * 3] = f
    colors[i * 3 + 1] = f
    colors[i * 3 + 2] = f
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
}

/**
 * Short-rail grain rotation.
 *
 * The box-projected UVs run the wood grain along the table's X axis everywhere, which is
 * right for the long rails and wrong for the two end caps: there the grain runs across the
 * 500mm-wide cap and reads as a painted stripe. For wood past the playing length (|x| >
 * 1828.5mm) the top/bottom faces get their UVs swapped, and the vertical end faces are
 * re-projected straight off world (z, y) so the grain follows the cap's length. Legs and
 * capitals sit inside the |x| bound and are left exactly as authored.
 */
function applyShortRailWoodUV(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (!pos || !nrm || !uv) return
  const X_BOUND = 1828.5
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    if (Math.abs(x) <= X_BOUND) continue
    const ny = nrm.getY(i)
    const nx = nrm.getX(i)
    if (Math.abs(ny) > 0.7) {
      uv.setXY(i, uv.getY(i), uv.getX(i))
    } else if (Math.abs(nx) > 0.7) {
      uv.setXY(i, pos.getZ(i) / 500, pos.getY(i) / 500)
    }
  }
  uv.needsUpdate = true
}