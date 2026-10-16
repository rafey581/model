import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
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

export const TABLE_MODEL_URL = '/snookerx_table.glb'

/**
 * Where the Draco decoder is served from (copied from three's examples/jsm/libs/draco/gltf).
 *
 * The table file is Draco-compressed — 3.5 MB on the wire instead of 21 — and the decoder is
 * a small WebAssembly module that runs in a worker, only while the table is being parsed.
 */
const DRACO_DECODER_PATH = '/draco/gltf/'

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
      const draco = new DRACOLoader()
      draco.setDecoderPath(DRACO_DECODER_PATH)
      const loader = new GLTFLoader()
      loader.setDRACOLoader(draco)
      let gltf
      try {
        gltf = await loader.parseAsync(buffer, '')
      } finally {
        // The decoder worker is only needed for the parse; nothing else in the game is Draco.
        draco.dispose()
      }
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
/** How light a cushion's vertical face, its top and its throats beside a pocket are, as a fraction of its green. */
interface CushionTones {
  face: number
  top: number
  throat: number
}

/** The old table's cushions: a strong split between the lit top and the face. */
const CUSHION_TONES_CLASSIC: CushionTones = { face: 0.56, top: 1, throat: 0.4 }

/**
 * The textured table's cushions: only a gentle roll from top to face. Its cushions are
 * properly rounded and smooth-shaded, so the shape carries itself, and a hard split
 * between the two tones drew a line along every cushion.
 */
const CUSHION_TONES_STUDIO: CushionTones = { face: 0.92, top: 1, throat: 0.8 }

function applyCushionShading(geo: THREE.BufferGeometry, tones: CushionTones = CUSHION_TONES_CLASSIC): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined
  if (!pos || !nrm) return
  const FACE = tones.face
  const TOP = tones.top
  const THROAT = tones.throat
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

/* ------------------------------------------------------------------ *
 * The textured table: a model that brings its own materials.
 * ------------------------------------------------------------------ */

/**
 * Whether a loaded model is the textured table rather than the old flat-shaded one.
 *
 * The old model carried placeholder materials the game replaced wholesale; this one carries
 * real ones — the mahogany grain, the leather, the brass — and they are kept. It is told
 * apart by its wood material's name.
 */
export function isTexturedTableModel(source: THREE.Group): boolean {
  let found = false
  source.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || found) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    if (mats.some((m) => m?.name === 'Mahogany')) found = true
  })
  return found
}

export interface TexturedTableOptions {
  /** The game's felt, for the bed: the cloth texture, its painted light and the markings' UVs. */
  bed: THREE.Material
  /** The game's cushion cloth: the same green as the bed, shaded by vertex colour. */
  cushion: THREE.Material
  /** Lowest tier: skip the lacquer coat on the wood. */
  low: boolean
}

/**
 * How much the wood's figure is deepened: the map's lighter and darker grain pushed apart
 * by this power around its own average.
 *
 * The map is pale birch with soft grain, and stained down to mahogany the grain all but
 * vanished: the rails read as a flat brown. Real mahogany under lacquer shows its dark
 * figure lines clearly, so the map's own contrast is raised — the lines are still the
 * model's, only deeper.
 */
const WOOD_FIGURE_POWER = 2.4

/** The average brightness of a texture's pixels, in linear light, measured once off a small copy. */
function meanLinearLuminance(texture: THREE.Texture | null): number {
  const image = texture?.image as CanvasImageSource | undefined
  if (!image || typeof document === 'undefined') return 0.35
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 32
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return 0.35
    ctx.drawImage(image, 0, 0, 32, 32)
    const px = ctx.getImageData(0, 0, 32, 32).data
    let sum = 0
    for (let i = 0; i < px.length; i += 4) {
      const lin = (v: number): number => {
        const c = v / 255
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
      }
      sum += 0.2126 * lin(px[i]!) + 0.7152 * lin(px[i + 1]!) + 0.0722 * lin(px[i + 2]!)
    }
    return Math.max(0.02, sum / (px.length / 4))
  } catch {
    return 0.35
  }
}

/** Deepen the grain of a wood material's map (see {@link WOOD_FIGURE_POWER}). */
function withWoodFigure<T extends THREE.MeshStandardMaterial>(material: T): T {
  const mean = { value: meanLinearLuminance(material.map) }
  const power = { value: WOOD_FIGURE_POWER }
  material.onBeforeCompile = (shader) => {
    shader.uniforms.woodFigureMean = mean
    shader.uniforms.woodFigurePower = power
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <map_pars_fragment>',
        '#include <map_pars_fragment>\nuniform float woodFigureMean;\nuniform float woodFigurePower;'
      )
      .replace(
        '#include <map_fragment>',
        [
          '#include <map_fragment>',
          '#ifdef USE_MAP',
          '\tfloat woodLum = dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );',
          '\tdiffuseColor.rgb *= clamp( pow( max( woodLum, 1e-4 ) / woodFigureMean, woodFigurePower - 1.0 ), 0.15, 2.2 );',
          '#endif'
        ].join('\n')
      )
  }
  material.customProgramCacheKey = () => 'wood-figure'
  return material
}

/** What is under the slate, seen only down a pocket: unlit and near black. */
const UNDERSIDE = new THREE.MeshBasicMaterial({ name: 'Underside', color: 0x060606 })

/**
 * The colour the mahogany is stained to.
 *
 * The model's wood map is pale birch; in Blender a stain over it made it mahogany, and that
 * stain was a node the export could not carry. Multiplying the map by this puts the colour
 * back: a deep red-brown with the birch's figure still in it.
 */
const MAHOGANY_STAIN = '#5a2c16'

/**
 * How strongly each of the model's polished materials mirrors the lamps, once the scene hands
 * them its lamp-only reflection map (see {@link dressTableReflections}).
 */
const LAMP_REFLECTION: Record<string, number> = {
  Mahogany: 0.85,
  Gold: 3,
  'Gold metal': 3,
  Leather: 1.2,
  Label: 1.2
}

/**
 * Give the table's polished surfaces the lamps to reflect, instead of the room.
 *
 * Under the scene's own environment a lacquered rail mirrored the blue walls and the red
 * carpet, and at a low angle the mahogany went purple. A real lacquered rail under a canopy
 * shows the canopy and nothing else: a long bright streak on dark wood. The map handed in is
 * that — black with the lamps in it — the one the balls already use.
 */
export function dressTableReflections(group: THREE.Object3D, lampOnly: THREE.Texture, canopy?: THREE.Texture): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    const material = mesh.material as THREE.MeshStandardMaterial
    const strength = material?.isMeshStandardMaterial ? LAMP_REFLECTION[material.name] : undefined
    if (strength === undefined) return
    // The lacquered wood mirrors the canopy itself, a broad bright panel overhead, so its top
    // carries a soft sheen from wherever it is seen; the brass and leather take the lamps.
    material.envMap = material.name === 'Mahogany' && canopy ? canopy : lampOnly
    material.envMapIntensity = strength
    material.needsUpdate = true
  })
}

/** The playing area in mm (cushion nose to cushion nose): the physics' own numbers. */
const PLAY_LENGTH_MM = 3569
const PLAY_WIDTH_MM = 1778

/**
 * Build the textured table: one merged mesh per material, the model's own materials kept.
 *
 * Two things are the game's rather than the model's. The bed cloth takes the game's felt —
 * the model's cloth was a Blender procedural that does not survive export — with its UVs
 * laid flat across the playing area so the painted light and the markings line up. The
 * cushion cloth takes the matching cushion felt. Everything else is exactly as authored.
 *
 * The model is then fitted to the physics: the cushion noses are measured off the mesh and
 * the table is shifted and stretched (by well under a percent) so they sit on the planes the
 * balls actually bounce off.
 */
export function instantiateTexturedTable(source: THREE.Group, opts: TexturedTableOptions): THREE.Group {
  source.updateMatrixWorld(true)
  const buckets = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[] }>()
  const add = (key: string, material: THREE.Material, geo: THREE.BufferGeometry): void => {
    const bucket = buckets.get(key)
    if (bucket) bucket.geos.push(geo)
    else buckets.set(key, { material, geos: [geo] })
  }

  source.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material
    // Blender suffixes a copied material ("Mahogany.001"); it is the same material.
    const name = (material?.name ?? '').replace(/\.\d+$/, '')
    if (material && material.name !== name) material.name = name
    // GLTFLoader splits a multi-material Blender object into one mesh per material under a
    // group named after the object, so the object's name is the parent's when there is one.
    const parent = mesh.parent
    const objectName = (parent && !(parent as THREE.Scene).isScene ? parent.name : '') || mesh.name
    const geo = normaliseAttributes(mesh.geometry.clone())
    geo.applyMatrix4(mesh.matrixWorld)
    geo.scale(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE)
    if (name === 'Cloth') {
      geo.computeBoundingBox()
      if (/bed/i.test(objectName) && !/support/i.test(objectName)) add('Cloth', opts.bed, geo)
      // Cloth wrapped under the slate is only ever seen down a pocket, where a real table is dark.
      else if (geo.boundingBox!.max.y < -20) add('Underside', UNDERSIDE, geo)
      else add('JawCloth', opts.cushion, geo)
      return
    }
    add(/legs/i.test(objectName) ? name + TABLE_LEGS_SUFFIX : name, material, geo)
  })

  // Fit to the physics, measured off the cushion cloth: the innermost points of the four
  // cushions between the height of the bed and the top of the rubber.
  const fit = measureCushionNoses(buckets.get('JawCloth')?.geos ?? [])

  const group = new THREE.Group()
  group.name = 'snooker-table-model'
  for (const [key, { material, geos }] of buckets) {
    const legs = key.endsWith(TABLE_LEGS_SUFFIX)
    const name = legs ? key.slice(0, -TABLE_LEGS_SUFFIX.length) : key
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false)
    if (geos.length > 1) geos.forEach((g) => g.dispose())
    if (!merged) {
      console.warn(`[tableModel] could not merge geometry for material "${name}"`)
      continue
    }
    if (fit) {
      merged.translate(-fit.cx, 0, -fit.cz)
      merged.scale(fit.sx, 1, fit.sz)
    }
    if (name === 'Cloth') layBedUVs(merged)
    // The cushions keep the normals Blender exported: they are what make the few strips
    // round the nose read as one smooth roll, exactly as the model looks in Blender.
    // Recomputing them split the nose into a band per strip.
    if (name === 'JawCloth') applyCushionShading(merged, CUSHION_TONES_STUDIO)
    merged.computeBoundingBox()
    merged.computeBoundingSphere()

    const finished =
      name === 'Cloth' || name === 'JawCloth' || name === 'Underside' ? material : dressModelMaterial(material, opts.low)
    // The pocket nets are the model's "Knot": named as the old nets so the pocket liners find them.
    const meshName = name === 'Knot' ? 'NetCord' : name
    const out = new THREE.Mesh(merged, finished)
    out.name = `table:${meshName || 'unnamed'}${legs ? TABLE_LEGS_SUFFIX : ''}`
    // The bed never samples the depth map (see Scene3D.selfCheck); thin nets would only
    // speckle it with acne.
    out.castShadow = name !== 'Cloth' && name !== 'Knot'
    out.receiveShadow = name !== 'Cloth'
    if (name === 'Cloth') out.renderOrder = -1
    group.add(out)
  }
  if (fit) {
    console.info(
      `[tableModel] fitted to the physics: x x${fit.sx.toFixed(5)} (centre ${fit.cx.toFixed(2)}mm), ` +
        `z x${fit.sz.toFixed(5)} (centre ${fit.cz.toFixed(2)}mm)`
    )
  }
  return group
}

/**
 * Where the four cushion noses are, and the shift and stretch that put them on the physics.
 *
 * Returns null — and the model is left exactly as it is — if the measurement looks wrong,
 * rather than stretching the table by anything more than a rounding error.
 */
function measureCushionNoses(
  geos: THREE.BufferGeometry[]
): { cx: number; cz: number; sx: number; sz: number } | null {
  let right = Infinity
  let left = -Infinity
  let near = Infinity
  let far = -Infinity
  for (const geo of geos) {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const y = pos.getY(i)
      const z = pos.getZ(i)
      // A straight cushion is an extrusion: its vertices are at its two ends, where it turns
      // into the pocket jaws, and nowhere in between. The jaws curve away from the bed, so the
      // innermost vertex of each cushion is on its straight nose wherever it is found.
      if (y < 5 || y > 60) continue
      if (Math.abs(z) < 850) {
        if (x > 1000) right = Math.min(right, x)
        else if (x < -1000) left = Math.max(left, x)
      }
      if (Math.abs(x) < 1760) {
        if (z > 500) near = Math.min(near, z)
        else if (z < -500) far = Math.max(far, z)
      }
    }
  }
  if (![right, left, near, far].every(Number.isFinite)) return null
  const sx = PLAY_LENGTH_MM / (right - left)
  const sz = PLAY_WIDTH_MM / (near - far)
  if (Math.abs(sx - 1) > 0.01 || Math.abs(sz - 1) > 0.01) {
    console.warn('[tableModel] cushion noses are far off the physics; leaving the model unfitted', { right, left, near, far })
    return null
  }
  return { cx: (right + left) / 2, cz: (near + far) / 2, sx, sz }
}

/**
 * The bed's UVs, laid flat across the playing area exactly as the code-built bed lays them:
 * u along the length, v across it, 0..1 from cushion nose to cushion nose. The felt's painted
 * light and the cushion shade are drawn in that space.
 */
function layBedUVs(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) + PLAY_LENGTH_MM / 2) / PLAY_LENGTH_MM
    uv[i * 2 + 1] = (-pos.getZ(i) + PLAY_WIDTH_MM / 2) / PLAY_WIDTH_MM
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
}

/**
 * The model's material, finished for the game's light.
 *
 * Kept as authored — the maps are the model's — with the few numbers glTF could not carry:
 * the mahogany gets a lacquer coat, the brass a polished but not mirrored finish (the export
 * left one fully rough and the other perfectly smooth), the nets are two-sided, and nothing
 * reflects the room more than its surface would.
 */
function dressModelMaterial(source: THREE.Material, low: boolean): THREE.Material {
  const std = source as THREE.MeshStandardMaterial
  if (!std.isMeshStandardMaterial) return source.clone()
  switch (std.name) {
    case 'Mahogany':
      return withWoodFigure(
        new THREE.MeshPhysicalMaterial({
          name: std.name,
          map: std.map,
          color: std.color.clone().multiply(new THREE.Color(MAHOGANY_STAIN)),
          roughnessMap: std.roughnessMap,
          roughness: 1,
          metalness: 0,
          // A thin satin coat, not a mirror: under the canopy lights a thicker one threw
          // a white glare along the rails from the overhead view.
          clearcoat: low ? 0 : 0.12,
          clearcoatRoughness: 0.3,
          specularIntensity: 0.3,
          envMapIntensity: 0.3
        })
      )
    case 'Gold':
    case 'Gold metal': {
      const brass = std.clone()
      brass.metalness = 1
      brass.roughness = std.name === 'Gold' ? 0.32 : 0.24
      brass.envMapIntensity = 1.2
      return brass
    }
    case 'Leather': {
      const leather = std.clone()
      leather.roughness = 0.6
      leather.envMapIntensity = 0.35
      return leather
    }
    case 'Knot': {
      const net = std.clone()
      net.side = THREE.DoubleSide
      net.roughness = 0.8
      net.envMapIntensity = 0.2
      return net
    }
    case 'Label': {
      const label = std.clone()
      label.roughness = 0.35
      label.envMapIntensity = 0.4
      return label
    }
    default: {
      const other = std.clone()
      other.envMapIntensity = Math.min(other.envMapIntensity, 0.5)
      return other
    }
  }
}