import * as THREE from 'three'
import { qualityConfig } from './qualityConfig.js'

/**
 * Photo finishes for the rails and the pocket leather.
 *
 * The loose plates in `public/textures` are the birch and hide the table was
 * authored from. They replace the model's embedded maps once they arrive, so a
 * slow phone still has a table on the first frame. Low quality keeps the colour
 * plates only: bump and roughness are extra samples on the biggest surfaces
 * beside the cloth.
 */

const WOOD_REPEAT: readonly [number, number] = [2.4, 1.15]
const LEATHER_REPEAT: readonly [number, number] = [1.8, 1.8]

function loadMap(url: string, srgb: boolean, repeat: readonly [number, number]): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        tex.wrapS = THREE.RepeatWrapping
        tex.wrapT = THREE.RepeatWrapping
        tex.repeat.set(repeat[0], repeat[1])
        tex.anisotropy = Math.max(1, qualityConfig().anisotropy)
        tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace
        tex.needsUpdate = true
        resolve(tex)
      },
      undefined,
      () => reject(new Error(url))
    )
  })
}

type WoodSet = { color: THREE.Texture; bump: THREE.Texture | null; rough: THREE.Texture | null }
type LeatherSet = { albedo: THREE.Texture; grain: THREE.Texture | null }

let woodPromise: Promise<WoodSet> | null = null
let leatherPromise: Promise<LeatherSet> | null = null

function woodMaps(): Promise<WoodSet> {
  if (!woodPromise) {
    const low = qualityConfig().name === 'low'
    woodPromise = Promise.all([
      loadMap('/textures/wood_birch_color.jpg', true, WOOD_REPEAT),
      low ? Promise.resolve(null) : loadMap('/textures/wood_birch_bump1.jpg', false, WOOD_REPEAT),
      low ? Promise.resolve(null) : loadMap('/textures/wood_birch_glossy_rough.jpg', false, WOOD_REPEAT)
    ]).then(([color, bump, rough]) => ({ color, bump, rough }))
  }
  return woodPromise
}

function leatherMaps(): Promise<LeatherSet> {
  if (!leatherPromise) {
    const low = qualityConfig().name === 'low'
    leatherPromise = Promise.all([
      loadMap('/textures/leath02c.jpg', true, LEATHER_REPEAT),
      // The green hide is used as grain, not as colour: its luminance is the pebble.
      low ? Promise.resolve(null) : loadMap('/textures/leath03b.jpg', false, LEATHER_REPEAT)
    ]).then(([albedo, grain]) => ({ albedo, grain }))
  }
  return leatherPromise
}

type FinishMaterial = THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial

/** Birch colour, bump and gloss over a rail. The material colour stays the stain. */
export function requestWoodPhoto(material: FinishMaterial): void {
  void woodMaps()
    .then(({ color, bump, rough }) => {
      material.map = color
      if (bump) {
        material.bumpMap = bump
        material.bumpScale = 0.045
      }
      if (rough) material.roughnessMap = rough
      material.needsUpdate = true
    })
    .catch(() => {
      // Procedural or embedded maps stay. A missing plate is not a broken table.
    })
}

/**
 * Brown hide (`leath02c`) under a cream stain, with the second plate as pebble.
 * Pocket leather on a match table is pale; the photo supplies the grain.
 */
export function requestLeatherPhoto(material: FinishMaterial): void {
  void leatherMaps()
    .then(({ albedo, grain }) => {
      material.map = albedo
      material.color = new THREE.Color('#f0e2c8')
      if (grain) {
        material.roughnessMap = grain
        material.bumpMap = grain
        material.bumpScale = 0.028
      }
      if ('sheen' in material) {
        material.sheen = Math.max(material.sheen, 0.42)
        material.sheenColor = new THREE.Color('#fff4df')
        material.sheenRoughness = 0.48
      }
      material.needsUpdate = true
    })
    .catch(() => {})
}

/** Dress every mahogany rail and leather pocket on a built table. */
export function dressPhotoTable(group: THREE.Object3D): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as FinishMaterial
    if (!mat?.isMeshStandardMaterial) return
    if (mat.name === 'Mahogany') requestWoodPhoto(mat)
    if (mat.name === 'Leather') requestLeatherPhoto(mat)
  })
}
