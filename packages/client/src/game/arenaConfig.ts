/**
 * ARENA_CONFIG — every tunable number behind the World Championship venue.
 *
 * All distances are millimetres and all angles are degrees, the same units the rest of
 * the 3D scene works in. `y` is 0 at the cloth, so the carpet at -790 matches the height
 * the table's legs stand on and `floorY` is the number that keeps them together.
 *
 * The values are chosen to read as a broadcast venue from the two poses the camera rig
 * actually holds, and several of them are chosen for reasons that are only obvious once
 * you know those poses:
 *
 *  - `lightRig.y` sits above `camera.ts`'s `MAX_CAMERA_HEIGHT_MM` (6000) on purpose. The
 *    overhead view climbs as high as 6000mm on a narrow canvas, and anything hung over
 *    the table below that line is drawn between the lens and the bed. The rig clears it.
 *  - `bowl.tiers` and `bowl.wallRadius` together fix the arena's outer radius, which has to
 *    stay inside the perspective camera's 20000mm far plane *plus* the 3000mm the camera rig
 *    is allowed to pull back off the table. The far side of the stand is that far from the
 *    lens, so anything past about 17000mm is simply not drawn.
 *  - `carpet.y` matches `floorY`, and the arena hides the old room's two big planes rather
 *    than trying to sit on top of them, so the two surfaces never fight for the same depth.
 *    That step has to happen *after* `buildTable`, because the two planes it targets are
 *    built inside that call: doing it earlier finds nothing and leaves a floor at exactly
 *    the carpet's own height, which is a z-fight no depth buffer can resolve.
 *  - `render` carries the two renderer numbers the arena is allowed to own. Both are seeded
 *    with the values the scene already used, so enabling them changes nothing until you
 *    move them: tone mapping itself stays the scene's business (ACES, or Neutral behind its
 *    own flag) and this file only sets the exposure it is given.
 */

/** How much geometry the arena is allowed to cost. One enum, one switch, three sizes. */
export type ArenaQuality = 'low' | 'medium' | 'high'

/** A stand deck: a row of seats on a step, and the step under it. */
export interface ArenaTier {
  /** How many rows of seats the deck has. The quality budget may ask for fewer. */
  rows: number
  /** Millimetres of radial depth one row takes, seat to seat. */
  rowPitch: number
  /** How much higher each row sits than the one in front of it. */
  rowRise: number
  /** Millimetres of gap left in front of the deck, over and above one row's pitch. */
  aisle: number
}

/** One row of seats: where it sits, and the deck it belongs to. */
export interface ArenaSeatRow {
  /** Radius of the row's floor, in millimetres. */
  radius: number
  /** Height of the row's floor above the cloth, in millimetres. */
  y: number
  /** Which deck the row belongs to, counting from the hoardings out. */
  tier: number
  /** Which row within that deck, counting from its landing. */
  rowInTier: number
  /** The deck's radial pitch. */
  pitch: number
  /** The deck's rise per row. */
  rise: number
}

/** The scaling `quality` applies, resolved once per build rather than read per seat. */
export interface ArenaBudget {
  tiers: number
  rows: number
  /** Centre-to-centre seat spacing in millimetres. */
  seatPitch: number
  /** Curve segments per full turn on every ring the arena builds. */
  curveSegments: number
  /** Longest edge on a generated texture. */
  textureSize: number
  /** Stand decks drawn as separate step rings. */
  stepRings: boolean
  /** Whether the carpet carries a bump map as well as its weave map. */
  carpetBump: boolean
  /** Half-segments per hoop of the roof rig, so it reads as pipe not as a smooth tube. */
  trussSegments: number
}

/**
 * `seatPitch` is the spacing along a row, and it deliberately did NOT shrink with the
 * chairs: at 250mm wide with pitch 560 the high plan is 531 chairs / 19,116 triangles
 * (the test caps it at 700 / 25,200, and the frame budget wants no more than the 596 /
 * 21,456 this all started at). If the rows ever look too sparse, lower these three
 * numbers — the cost is chairs, and it is paid in triangles. `rows` must stay strictly
 * low < medium < high or the bowl-plan test fails.
 */
const QUALITY_BUDGETS: Record<ArenaQuality, ArenaBudget> = {
  low: { tiers: 3, rows: 3, seatPitch: 900, curveSegments: 24, textureSize: 256, stepRings: false, carpetBump: false, trussSegments: 4 },
  medium: { tiers: 4, rows: 4, seatPitch: 700, curveSegments: 40, textureSize: 512, stepRings: true, carpetBump: true, trussSegments: 6 }, // rows was 5
  high: { tiers: 4, rows: 5, seatPitch: 560, curveSegments: 64, textureSize: 1024, stepRings: true, carpetBump: true, trussSegments: 8 } // rows was 7 (6 after E2)
}

export interface ArenaConfig {
  /** Which budget the build uses. Drop to `medium` or `low` first if the frame rate goes. */
  quality: ArenaQuality

  /**
   * The two renderer numbers the arena owns.
   *
   * Applied after `buildLighting` and before the shadow bake, which is the only window in
   * the scene's construction where both can still be changed: the lamp's shadow map does
   * not exist yet when the map size is set, so the bake renders it at this size.
   */
  render: {
    exposure: number
    /** Edge length of the lamp's baked shadow map, in texels. Power of two. */
    shadowSize: number
    /**
     * The scene's two whole-room fills, seeded here so the venue can own the room's
     * brightness without the scene's own lighting becoming a second place to edit.
     *
     * Kept deliberately modest: the lamp over the table is what makes the cloth the
     * brightest thing in the frame, and these only stop the arena reading as a void.
     */
    ambientColor: string
    ambientIntensity: number
    /** Sky colour of the hemisphere fill, which lights everything from above. */
    hemiSky: string
    hemiIntensity: number
  }

  /**
   * The arena's structural colours.
   *
   * Every surface the venue owns rather than the table. They are grouped here because
   * they are tuned together: a broadcast hall reads as one palette, and moving the
   * terraces darker without moving the wall with them just splits the room in half.
   */
  palette: {
    /** The terraces, risers, landings and the face of the bowl. */
    concrete: string
    /** The wall behind the top row. */
    wall: string
    /** The band of fascia between the top row and the roof. */
    fascia: string
    /** Frames, kick plates, capping rails and the lip of the roof mouth. */
    darkSteel: string
    /** The polished members of the roof rig. */
    steel: string
    /** The camera tripods. Chosen to read as equipment rather than as holes. */
    cameraRig: string
  }

  /**
   * The carpet's red.
   *
   * The weave texture is a light grey, so the map multiplies this down by roughly 0.9;
   * brighten it here rather than in the texture.
   */
  carpetColor: string
  carpetY: number
  carpetRadius: number
  /** Fully matte: this is a floor, not a floor polish. */
  carpetRoughness: number
  carpetMetalness: number
  carpetTextureRepeat: number
  /** How far the bump map pushes the weave, in millimetres. */
  carpetBumpScale: number
  /**
   * Whether the carpet takes the table lamp's shadow.
   *
   * It has to. The old room's floor was the scene's only shadow receiver at ground level —
   * the cloth is forbidden from receiving one — so switching this off drops the table's
   * shadow on the floor entirely and leaves the table looking like it is floating. Nothing
   * else in the arena casts, so what lands here is the table's own silhouette.
   */
  carpetReceiveShadow: boolean

  bowl: {
    /** Radius of the hoardings: the inner edge of the bowl. */
    innerRadius: number
    /** How far the lowest tier sits behind the hoardings before its first row. */
    firstRowInset: number
    /** Height of the hoardings' top edge above the carpet. */
    boardHeight: number
    /** Clearance left between the top of the hoardings and the first row's floor. */
    firstRowClearance: number
    /** Height of the outside face of the terrace steps, used to lay out the tiers. */
    firstRowLift: number
    tiers: ArenaTier[]
    /** Height of the wall behind the top row. */
    wallHeight: number
    /** Radius of that wall, which is also the roof's. */
    wallRadius: number
    /** How far the fascia above the top row rises before the roof. */
    fasciaHeight: number
    /** Half-extent of the rectangular mouth cut in the roof, along the table's length. */
    roofHoleX: number
    /** Half-extent of the same mouth across the table. */
    roofHoleZ: number
    /** How deep the mouth's rim hangs below the roof. */
    roofHoleLip: number
  }

  seats: {
    /** Seat colours, picked per seat so a block reads as one colour and the tiers differ. */
    palette: string[]
    /** A darker shade of a block's own colour, for every `patternEvery` blocks. */
    stripeColor: string
    patternEvery: number
    /**
     * Seats per block.
     *
     * The bowl's circumference is divided into blocks of this many seats and each block is
     * then filled with whole seats only, so a row ends on a block boundary with a strip of
     * empty floor behind it. Those strips are the aisles.
     */
    blockSize: number
    /** Seat pan width. */
    width: number
    /** Seat pan depth. */
    depth: number
    /** How far the pan stands off the riser it sits on. */
    frontGap: number
    /** Height of the pan above its own floor. */
    seatHeight: number
    /** Height of the back above its own floor. */
    backHeight: number
    /** How far the back leans back. */
    backLean: number
    /** Thickness of pan and back. */
    thickness: number
  }

  hoardings: {
    panels: number
    /** Advert panels drawn per texture tile, so the ring's repeat is `panels / perTile`. */
    panelsPerTile: number
    /** How bright the boards' own light is. They are lit surfaces pretending to be screens. */
    emissiveIntensity: number
    /** Text the ring carries. Generic on purpose: no real sponsor, no real venue. */
    slogans: string[]
  }

  wall: {
    /** Horizontal repeat of the upper wall's rib texture. */
    textureRepeat: number
    /** Vertical repeat. */
    repeatY: number
  }

  roof: {
    color: string
    /** How many structural bands cross the ceiling. */
    bands: number
    /** Half-width of each band. */
    bandHalfWidth: number
    /** How far each band stands below the roof. */
    drop: number
    /** How bright the catwalk grating is left. */
    intensity: number
  }

  rig: {
    /** Height of the main truss and its fixtures above the cloth. */
    y: number
    /** Half-extent of the truss along the table's length. */
    extentX: number
    /** Half-extent across the table. */
    extentZ: number
    /** Radius of a fixture's lens housing. */
    fixtureRadius: number
    /** How many fixtures hang on each of the two long rails. */
    fixtures: number
    /** How far a fixture drops below the truss it hangs on. */
    fixtureDrop: number
    /** How bright the fixture faces glow. */
    emissiveIntensity: number
    /** Vertical droppers and bracing between the truss and the roof. */
    hangers: number
  }

  cameras: {
    /**
     * Radius of the camera stands.
     *
     * Outside the hoardings (`innerRadius`) and on the landing in front of the first row,
     * which runs from there to `innerRadius + firstRowInset - rowPitch/2`. The landing is
     * the only ground in the venue with no seats on it, so it is where a stand can go
     * without being buried in the front row; the width of that landing is what caps
     * `legSplay`. The stands are hidden (`buildCameraStands: false`), kept on the landing
     * so re-enabling them lands somewhere sane.
     */
    radius: number
    /** How tall a stand is, measured from its own base to the head. */
    height: number
    /** Legs per tripod. */
    legs: number
    /** How far a leg splays from the column. */
    legSplay: number
    /** Body and lens. */
    bodyWidth: number
    bodyHeight: number
    bodyDepth: number
    lensLength: number
    lensRadius: number
    /** Where the lens points, in degrees: at the table, along each stand's own radius. */
    yaw: number
  }

  lights: {
    /**
     * Grazing washes that light the stands.
     *
     * Placed far out and low so the direction they travel is nearly horizontal: a stand's
     * risers and seat backs face sideways and take almost all of it, while the bed faces
     * up and only sees `sin(elevation)` of it. That is how the seats get lit without the
     * cloth being flattened by a fourth source.
     */
    standCount: number
    standIntensity: number
    standAzimuthDeg: number
    standRadius: number
    standElevationDeg: number
  }

  /**
   * The old room's two big planes, matched by size so this file can step over them.
   *
   * `hideLegacyRoom` (exported, called by the scene after `buildTable`) hides every plane
   * whose *shortest* edge reaches `legacyFloorSpan`. At the moment that is exactly the old
   * floor (16000 x 9000) and the old back wall (14000 x 7000); nothing else in the scene is
   * anywhere near that big, which is what makes the shortest edge the right one to test
   * against — the arena's own roof cap is wider than the old floor but nowhere near as
   * deep. The old wall is the one that has to go: the arena's outer wall is far behind it,
   * so a flat blue plane 4600mm behind the table would stand inside the bowl and read
   * straight through it. The old floor is worse than harmless without this: it sits at
   * exactly `carpetY`, so leaving it in place puts two ground planes at the same depth and
   * they flicker against each other as the camera moves. Its job as the scene's only
   * ground-level shadow receiver is handed to the carpet.
   *
   * The order matters. Both planes are built inside `buildTable`, so this can only run
   * after that call — earlier it finds nothing.
   */
  legacyFloorSpan: number
  /** Set to false to leave the old room alone and draw the arena over it. */
  hideLegacyRoom: boolean

  /**
   * Off: no outer wall, fascia, roof, roof mouth or structural bands. What is left is an
   * open bowl under a dark clear colour — the old room's shell read as a bright sky-blue
   * barrel around the table, and it is the single biggest thing behind the venue feeling
   * like a hangar instead of a darkened hall.
   */
  buildShell: boolean
  /** Off: no lighting truss. It hangs from the roof mouth, so it goes with the shell. */
  buildRig: boolean
  /** Off: no fixed pedestal cameras on the landing. */
  buildCameraStands: boolean
}

/**
 * The config as written, plus the resolved quality budget, which is filled in at build
 * time by `resolveArenaBudget` rather than being duplicated here.
 */
export interface ResolvedArena extends ArenaConfig {
  budget: ArenaBudget
}

/** The one config the arena is built from. Change a number here, not in the builders. */
export const ARENA_CONFIG: ArenaConfig = {
  quality: 'high',

  // Tone mapping stays where the scene put it: ACES by default, Neutral behind its flag.
  render: {
    exposure: 1.1,
    shadowSize: 2048,
    ambientColor: '#dfe8ff',
    ambientIntensity: 0.45,
    hemiSky: '#fff1d8',
    hemiIntensity: 0.68
  },

  palette: {
    concrete: '#0a1226',
    wall: '#9aa6bd',
    fascia: '#3b4767',
    darkSteel: '#39415a',
    steel: '#7e879b',
    cameraRig: '#454d61'
  },

  carpetColor: '#b03038',
  carpetY: -790,
    carpetRadius: 12600, // was 10800: the bowl's back edge is now 12550, so the carpet reaches it
  // Fully matte, and non-metal: a floor polish would put a moving specular highlight on
  // it, and a highlight that travels as the camera moves is what reads as a shimmering
  // surface rather than as cloth.
  carpetRoughness: 1,
  carpetMetalness: 0,
  // Coarser than it looks. At 44 repeats the weave's crosshatch landed inside the range
  // where minification is fighting the mip chain and the carpet's own grain started to
  // crawl when the camera moved between the overhead and the play pose. Half that, and
  // half the bump under it, keeps the grain as a suggestion at playing distance.
  carpetTextureRepeat: 26,
  carpetBumpScale: 0.4,
  carpetReceiveShadow: true,

  bowl: {
    // The arena distance. Everything else in the bowl is either relative to this (the
    // first row via `firstRowInset`) or derived from it in code, so pushing the whole
    // venue back is this one number.
    innerRadius: 7000, // was 5600 (4300 before Part E)
    // 1500 behind the boards puts the first row's centre at 8500 and its front edge at
    // 8050 — a 1050mm walk left behind the boards, and the whole backdrop another 1400
    // out from the table than the last pass. The gap is relative to the boards, so it
    // moves with `innerRadius` untouched.
    firstRowInset: 1500, // was 1100
    // Low boards: 750 (was 900) puts the top edge at y=-40, just under the bed, so the
    // sponsors read without standing between the camera and the table — the ring is a
    // dark band at the carpet's edge rather than a wall the eye has to climb over.
    boardHeight: 750,
    firstRowClearance: 700,
    // The first row's floor, 300 above the carpet (unchanged). At the shallower rise
    // below, the bowl's front edge lands 6mm above the carpet instead of 120mm below it,
    // so the face draws as a sliver and the front landing draws as a walkway flush with
    // the carpet — both were skipped entirely at the old 420mm rise.
    firstRowLift: -490,
    /**
     * One bank of five rows, 294mm up per 900mm out: an 18.2-degree rake (was seven rows
     * at 420/900 = 25 degrees). Five rows at that rake puts the top row's floor 686 above
     * the cloth — under half the old 2030 — so the bank reads as a distant dark edge
     * rather than something leaning over the table. `budget.rows` on high quality says the
     * same five; low and medium take fewer rows out of the same bank.
     */
    tiers: [{ rows: 5, rowPitch: 900, rowRise: 294, aisle: 0 }], // was rows 6 (7 before E2), rowRise 420
    // The outer wall, dormant behind `buildShell: false` but scaled down with the bowl so
    // it still fits: 13500 now reaches only 950 past the bowl's 12550 back edge.
    wallHeight: 7500, // was 10000
    wallRadius: 13500, // was 16000
    fasciaHeight: 1200, // was 1500
    /**
     * The mouth cut in the roof, and the reason there is one: an arena's lighting rig
     * hangs from the structure it is aimed through, so the ceiling opens over the table
     * and the truss below it hangs from solid roof. `rig.extentX/Z` sit just outside the
     * hole for that reason.
     */
    roofHoleX: 4600,
    roofHoleZ: 2400,
    roofHoleLip: 900
  },

  seats: {
    // One dark blue everywhere, and a stripe a shade darker rather than a second colour:
    // the bowl has to read as a single mass of blue under one lamp, not as a pattern.
    palette: ['#0a1c4a'],
    stripeColor: '#06122f',
    patternEvery: 3,
    blockSize: 8,
    // The chairs themselves, down to about half their original size (470/440/450/830/90/60
    // at Part E's start; 330/310/315/580/63 after the first 70-percent cut): a chair that is
    // half as tall sits half as far into the sightline, which is what keeps the bowl reading
    // as backdrop instead of furniture. Row spacing did not shrink: see QUALITY_BUDGETS.
    width: 250, // was 330 (470 originally)
    depth: 240, // was 310 (440)
    frontGap: 30, // was 42 (60)
    seatHeight: 240, // was 315 (450)
    // 190 of backrest over the pan (was 265, originally 380): enough to read as a chair
    // from across the arena and no more, since a taller back hides the row behind it.
    backHeight: 430, // was 580 (830)
    backLean: 9,
    thickness: 50 // was 63 (90)
  },

  hoardings: {
    // 80 panels at r=7000 = 550mm of arc each, against the old 40 at r=4300 = 675mm: about
    // 20 percent shorter even after the ring moved out again, so each advert sits in a
    // frame its own size instead of being stretched around a wider ring. 80/4 = 20 whole
    // texture tiles, so the ring closes on a seam.
    panels: 80, // was 64 (40 before E3)
    panelsPerTile: 4,
    emissiveIntensity: 0.25,
    slogans: ['SNOOKERX', 'WORLD CHAMPIONSHIP', 'SNOOKER ARENA', 'LIVE ON STREAM', 'TOP BREAK 112', 'NEXT FRAME']
  },

  wall: {
    textureRepeat: 37, // was 44: the same wrap rate around a 13500 wall instead of a 16000 one
    repeatY: 2 // was 3: the same vertical density on a 7500 wall instead of a 10000 one
  },

  roof: {
    color: '#141c2e',
    bands: 6,
    bandHalfWidth: 190,
    drop: 620,
    intensity: 0.5
  },

  rig: {
    y: 7200,
    extentX: 4800,
    extentZ: 2600,
    fixtureRadius: 430,
    fixtures: 5,
    fixtureDrop: 520,
    emissiveIntensity: 1.5,
    hangers: 9
  },

  cameras: {
    // On the landing between the hoardings and the front of the first row (7000..8050 now
    // the boards sit at 7000), so the stand is past the playing area but still beside the
    // front tier. The landing is 1050mm deep, which is what holds the splay down.
    radius: 7300, // was 5800 (4500 originally)
    // 2050 to the head, plus the body: about 2.5m standing on the landing, which is what
    // a venue camera on a fixed pedestal actually measures.
    height: 2050,
    legs: 3,
    legSplay: 210,
    bodyWidth: 430,
    bodyHeight: 300,
    bodyDepth: 520,
    lensLength: 360,
    lensRadius: 120,
    yaw: 0
  },

  lights: {
    standCount: 4,
    standIntensity: 0.9,
    standAzimuthDeg: 45,
    standRadius: 16000,
    standElevationDeg: 22
  },

  legacyFloorSpan: 6500,
  hideLegacyRoom: true,

  buildShell: false,
  buildRig: false,
  buildCameraStands: false
}

/** The budget a quality level resolves to. */
export function resolveArenaBudget(quality: ArenaQuality): ArenaBudget {
  return QUALITY_BUDGETS[quality]
}

/** Where a chosen quality can come from: the URL, a remembered choice, or a guess. */
const QUALITY_STORAGE_KEY = 'snooker.quality'

function isArenaQuality(value: unknown): value is ArenaQuality {
  return value === 'low' || value === 'medium' || value === 'high'
}

/**
 * The quality this device should build the arena at.
 *
 * Three sources, in this order: `?quality=low|medium|high` in the URL, which is the
 * override that lets every size be seen from one machine without a rebuild;
 * `localStorage['snooker.quality']`, which is a player's own remembered choice; and a
 * guess from what the browser says about the device.
 *
 * The guess is biased towards the smaller budgets on purpose. A venue one tier short reads
 * as a slightly smaller arena and nothing else, while a venue that costs a dropped frame
 * reads as a broken game — and the frames the arena spends go straight off the budget
 * the table, the balls and the aim guide need.
 */
export function pickArenaQuality(): ArenaQuality {
  try {
    const search = globalThis.location?.search
    if (search) {
      const fromUrl = new URLSearchParams(search).get('quality')
      if (isArenaQuality(fromUrl)) return fromUrl
    }
    const stored = globalThis.localStorage?.getItem(QUALITY_STORAGE_KEY)
    if (isArenaQuality(stored)) return stored
  } catch {
    // Storage refused, or there is no location at all (the unit tests). Either way the
    // guess below needs neither, so there is nothing to fall back from.
  }
  return autoArenaQuality()
}

/** What the device itself looks like, when no quality has been asked for by name. */
function autoArenaQuality(): ArenaQuality {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined
  if (!nav) return 'medium'
  // A coarse pointer means a phone or a tablet, and those run out of fill rate first: the
  // small budget is the difference between the venue playing and the venue not.
  if (globalThis.matchMedia?.('(pointer: coarse)').matches) return 'low'
  const memory = nav.deviceMemory
  if ((memory !== undefined && memory <= 4) || (nav.hardwareConcurrency ?? 8) <= 4) return 'medium'
  return 'high'
}

/** What each quality asks of the two renderer-side numbers, both of which are expensive. */
const QUALITY_RENDER: Record<ArenaQuality, { shadowSize: number; standLights: number }> = {
  low: { shadowSize: 1024, standLights: 2 },
  medium: { shadowSize: 2048, standLights: 4 },
  high: { shadowSize: 2048, standLights: 4 }
}

/**
 * Resolves the quality onto the config the arena is about to be built from.
 *
 * Called once, immediately before `buildArenaEnvironment`, and never during a frame: the
 * budget, the shadow map and the stand washes are all read at build time, so this is the
 * only moment any of them can still be changed. Returns the quality it chose, so a caller
 * can report it.
 */
export function applyArenaQuality(
  config: ArenaConfig = ARENA_CONFIG,
  quality: ArenaQuality = pickArenaQuality()
): ArenaQuality {
  const render = QUALITY_RENDER[quality]
  config.quality = quality
  config.render.shadowSize = render.shadowSize
  config.lights.standCount = render.standLights
  return quality
}