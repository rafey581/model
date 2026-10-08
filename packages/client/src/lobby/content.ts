/**
 * Lobby copy and static help text — presentation only.
 * Controls match the in-game help overlay + input/placement behaviour.
 * Rules match packages/shared snooker + frame (no free-ball: not implemented).
 */

export const BG_IMAGE = '/lobby-pic-blurred.jpg'

export const HOME_COPY = {
  eyebrow: 'table ready',
  headline: 'PICK YOUR MATCH',
  heroTag: '3D SNOOKER / 15 REDS',
  heroTitle: 'PLAY SNOOKER',
  heroSubtitle: 'Aim, power, and spin on a full 3D table.',
  heroCta: 'choose your opponent',
  statsEmpty: 'no completed matches yet',
  footerMode: 'Lobby · free practice & online tables'
} as const

export const SETUP_COPY = {
  back: 'back to lobby',
  eyebrow: 'match options',
  headline: 'SET THE TABLE',
  step: '01 / MODE',
  titleAi: 'Who are you\nplaying?',
  vsAiTitle: 'VS AI',
  vsAiDesc: 'play against the computer',
  onlineTitle: 'ONLINE',
  onlineDesc: 'play against a real opponent',
  difficultyLabel: 'AI DIFFICULTY',
  lengthLabel: 'MATCH LENGTH',
  stakeLabel: 'STAKE',
  facts: ['15 reds', '6 colours', '1 white cue ball'] as const,
  panelBrand: 'SNOOKERX',
  panelBadge: 'LIVE TABLE',
  panelTitle: 'Ready when you are',
  panelBody: 'Confirm the mode and start when the table feels right.',
  start: 'START MATCH',
  formats: {
    BO1: { label: 'SINGLE FRAME', hint: '1 frame' },
    BO3: { label: 'BEST OF 3', hint: 'first to 2' },
    BO5: { label: 'BEST OF 5', hint: 'first to 3' }
  } as const
}

export const STATS_COPY = {
  pageName: 'Statistics',
  eyebrow: 'completed matches',
  title: 'YOUR RECORD',
  emptyRecent: 'no completed matches yet, your record begins at the table',
  returnLobby: 'RETURN TO LOBBY',
  yourPanel: 'Your record',
  recentPanel: 'Recent matches',
  oppPanel: 'Opponent record'
} as const

export const INFO_COPY = {
  back: 'back to lobby',
  eyebrow: 'learn the table',
  headline: 'HOW TO PLAY',
  panelTitle: 'Stay sharp at the baulk end',
  panelBody: 'Controls and rules in one place — written for the way this table actually plays.',
  chips: ['Aim & power', 'Spin & camera', 'Fouls 4–7'] as const
} as const

export const SETTINGS_COPY = {
  eyebrow: 'preferences',
  headline: 'SETTINGS',
  soundLabel: 'Table sounds',
  soundHint: 'Pots, cushions, fouls, and crowd cues share one mute.'
} as const

export interface NumberedSection {
  title: string
  body: string
}

export const CONTROLS_SECTIONS: readonly NumberedSection[] = [
  {
    title: 'Aiming',
    body: 'Move the pointer or finger across the cloth to point the cue. The aim line follows the cue ball toward your target.'
  },
  {
    title: 'Power',
    body: 'Drag the power slider, hold to charge, or use the up and down keys to trim strength before you shoot.'
  },
  {
    title: 'Spin',
    body: 'Side spin uses the left and right keys; top and bottom spin use W and S. The dial shows the tip offset you have set.'
  },
  {
    title: 'Shoot',
    body: 'Release the charge gesture or press Space to play the shot. The server simulates the stroke; your client replays it.'
  },
  {
    title: 'Camera',
    body: 'Right-drag or middle-drag orbits the view. Use the camera tool in a match to switch cue-ball, broadcast, side, close-up, or overhead.'
  },
  {
    title: 'Cue ball in the D',
    body: 'At the start of a frame the cue ball must be placed inside the D. After a mid-frame foul that leaves the cue in hand, you may place it anywhere legal on the cloth.'
  },
  {
    title: 'Shot timer',
    body: 'Each visit has a turn clock. If time runs out with no stroke, a foul is awarded and the visit changes.'
  }
]

export const RULES_SECTIONS: readonly NumberedSection[] = [
  {
    title: 'Opening contact',
    body: 'While reds remain, the ball on is a red. Your first contact must be a red; potting a red scores one point and keeps the visit.'
  },
  {
    title: 'Colour after a red',
    body: 'After a red you may nominate any colour. Pot that colour for its value, then it is re-spotted while reds are still on the table, and you return to a red.'
  },
  {
    title: 'Clearing the colours',
    body: 'When the last red is gone, colours are taken in order: yellow, green, brown, blue, pink, black. They stay down once potted in this phase.'
  },
  {
    title: 'Visits and ends',
    body: 'A legal pot keeps your visit. Missing, failing to hit the ball on, or potting the wrong ball ends the visit and may foul.'
  },
  {
    title: 'Foul values',
    body: 'Fouls award the opponent at least four points, or the value of the highest ball involved up to seven (black). The cue ball is re-spotted when it is potted.'
  },
  {
    title: 'Cue ball in hand',
    body: 'After certain fouls the next striker places the cue ball. Break-offs must stay in the D; other in-hand placements may go anywhere on the cloth that is clear.'
  }
]
