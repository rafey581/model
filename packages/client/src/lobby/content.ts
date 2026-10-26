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
  tableLabel: 'TABLE',
  tableOpen: 'OPEN TABLE',
  tableOpenHint: '1 – 100 USDT',
  tableMaster: 'MASTER MATCH',
  tableMasterHint: '500 – 5000 USDT',
  opponentLabel: 'OPPONENT',
  opponentAnyone: 'ANYONE',
  opponentAnyoneHint: 'broadcast to online players',
  opponentFriend: 'A FRIEND',
  opponentFriendHint: 'invite one friend',
  friendPickLabel: 'WHICH FRIEND',
  friendEmpty: 'no friends yet — add one from the FRIENDS screen first',
  facts: ['15 reds', '6 colours', '1 white cue ball'] as const,
  panelBrand: 'SNOOKER STAKE',
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
  soundHint: 'Pots, cushions, fouls, and crowd cues share one mute.',
  qualityLabel: 'Graphics quality',
  qualityHint: 'Auto picks for this device and adjusts while you play. A fixed level stays exactly as chosen.',
  qualityApplied: 'Applies from your next match.',
  qualityOptions: [
    { value: 'auto', label: 'Auto', hint: 'Recommended' },
    { value: 'low', label: 'Low', hint: 'Fastest' },
    { value: 'medium', label: 'Medium', hint: 'Balanced' },
    { value: 'high', label: 'High', hint: 'Sharpest' }
  ],
  musicLabel: 'Music',
  musicHint: 'Slow background music. It lowers during a shot and pauses when you leave the app.',
  musicVolume: 'Volume',
  musicTracks: [
    { value: 'piano', label: 'Piano' },
    { value: 'guitar', label: 'Guitar' },
    { value: 'violin', label: 'Violin' },
    { value: 'flute', label: 'Flute' },
    { value: 'mix', label: 'Mix', hint: 'Rotates' }
  ]
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

/**
 * Friends screen copy: search by the player's unique username and manage
 * incoming requests.
 */
export const FRIENDS_COPY = {
  eyebrow: 'social',
  headline: 'FRIENDS',
  back: 'back to lobby',
  searchHint:
    'Type part of a player’s unique username and search. Only players with an ' +
    'active account appear, and you cannot add yourself.',
  searchLabel: 'FIND A PLAYER',
  searchPlaceholder: 'their unique username',
  search: 'search',
  searching: 'searching…',
  noResults: 'no players found with that username',
  addFriend: 'add friend',
  requestSent: 'request sent',
  alreadyFriends: 'already friends',
  theyAskedYou: 'they asked you first — accept it below',
  incomingTitle: 'INCOMING',
  outgoingTitle: 'SENT',
  requestsTitle: 'FRIEND REQUESTS',
  incomingEmpty: 'no incoming requests',
  outgoingEmpty: 'no requests you sent',
  waiting: 'waiting for them to accept',
  friendsTitle: 'YOUR FRIENDS',
  friendsEmpty: 'no friends yet — search for a username above to add someone',
  friendsSince: (iso: string) => `friends since ${new Date(iso).toISOString().slice(0, 10)}`,
  challenge: 'challenge',
  challengeHint: 'invite this friend to a staked table',
  accept: 'accept',
  decline: 'decline',
  added: 'Friend request sent.',
  accepted: 'You are now friends.',
  declined: 'Request declined.'
} as const

/**
 * Invite screen copy. Every account has one shareable code; the inviter earns
 * `bonusUsdt` once the invited player finishes a first match.
 */
export const INVITE_COPY = {
  eyebrow: 'earn',
  headline: 'INVITE & EARN',
  back: 'back to lobby',
  intro:
    'Share your invite code or link. Every player you bring in gets the normal ' +
    'welcome balance — and you earn USDT the moment they finish their first match.',
  codeLabel: 'YOUR INVITE CODE',
  linkLabel: 'INVITE LINK',
  copyCode: 'copy code',
  copyLink: 'copy link',
  share: 'share',
  copied: 'copied to clipboard',
  copyFailed: 'could not copy — select it and copy manually',
  shareText: (bonus: number) => `Join me on Snooker Stake. Sign up and play — I earn ${bonus} USDT when you finish your first match.`,
  statInvited: 'INVITED',
  statPlayed: 'PLAYED',
  statEarned: 'EARNED',
  earnedSuffix: 'USDT',
  peopleTitle: 'PLAYERS YOU INVITED',
  empty: 'no one yet — share your code to get started',
  statusPlayed: 'first match played — bonus paid',
  statusWaiting: 'signed up — bonus pending their first match',
  disabled: 'The invite programme is currently paused.',
  joinedOn: (iso: string) => `joined ${new Date(iso).toISOString().slice(0, 10)}`
} as const

/**
 * Deposit screen copy. `amountHint` becomes a sentence, so it is a function of
 * the live min/max rather than a string constant.
 */
export const DEPOSIT_COPY = {
  eyebrow: 'wallet',
  headline: 'FUND YOUR BALANCE',
  back: 'back to lobby',
  intro:
    'Send USDT on the Solana network to the address below, then submit the transaction id ' +
    'and a screenshot of the payment. An admin verifies the transaction from their side and ' +
    'credits your balance with the same USDT amount.',
  addressLabel: 'PLATFORM USDT ADDRESS — SOLANA NETWORK',
  copyAddress: 'copy',
  copied: 'address copied',
  amountLabel: 'AMOUNT (USDT)',
  txLabel: 'TRANSACTION ID',
  txPlaceholder: 'the solana signature of your transfer',
  proofLabel: 'PROOF SCREENSHOT',
  proofHint: 'upload a screenshot of the sent transaction — an admin checks it against the transaction id',
  chooseFile: 'choose image',
  changeFile: 'change image',
  submit: 'send deposit request',
  submitting: 'submitting…',
  notConfigured: 'Deposits are not configured yet. Please check back later.',
  disabled: 'Deposits are currently disabled.',
  historyTitle: 'YOUR DEPOSITS',
  empty: 'no deposits yet',
  statusPending: 'PENDING',
  statusApproved: 'APPROVED',
  statusRejected: 'REJECTED',
  credited: (n: number) => `${n} USDT credited`,
  rejectedPrefix: 'reason: ',
  submitted: 'Deposit request sent. An admin will verify it shortly.',
  amountHint: (min: number, max: number) => `min ${min} · max ${max} USDT`
} as const

/**
 * Withdraw screen copy. Like deposits, the hints are functions of the live
 * limits so they never drift from the server config.
 */
export const WITHDRAW_COPY = {
  eyebrow: 'wallet',
  headline: 'WITHDRAW TO USDT',
  back: 'back to lobby',
  intro:
    'Request a cash-out. Enter the USDT amount you want and your own Solana address — ' +
    'an admin verifies your account (including your recent matches) and sends the USDT ' +
    'out of band. On approval the same amount is deducted from your balance.',
  addressLabel: 'YOUR USDT ADDRESS — SOLANA NETWORK',
  addressPlaceholder: 'the solana address that should receive the funds',
  balanceLabel: 'YOUR BALANCE',
  amountLabel: 'AMOUNT (USDT)',
  submit: 'send withdraw request',
  submitting: 'submitting…',
  disabled: 'Withdrawals are currently disabled.',
  insufficient: 'You do not have enough balance for this amount.',
  historyTitle: 'YOUR REQUESTS',
  empty: 'no withdrawal requests yet',
  statusPending: 'PENDING',
  statusApproved: 'APPROVED',
  statusRejected: 'REJECTED',
  deducted: (n: number) => `${n} USDT deducted`,
  rejectedPrefix: 'reason: ',
  submitted: 'Withdraw request sent. An admin will verify it and pay out shortly.',
  amountHint: (min: number, max: number) => `min ${min} · max ${max} USDT`
} as const
