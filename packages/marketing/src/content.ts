/**
 * Public copy for the download site.
 * Facts match the player client and the shared rules: 6 or 10 reds, robot
 * practice only, invitation matches, an 8-player knockout, and a virtual
 * in-app balance. This page does not offer deposits, withdrawals, or cash.
 */

export const PAGE_TITLE = 'Snooker Stake — 3D snooker for Android'

export const PAGE_DESCRIPTION =
  'Snooker Stake is Android snooker in 3D: robot practice, live opponents, and an 8-player knockout. The server runs the rules. Stakes are virtual, not cash.'

export const APP_NAME = 'Snooker Stake'
export const PACKAGE_ID = 'com.snookerx.game'
export const MIN_SDK = 23
export const MIN_ANDROID = '6.0'

export interface Faq {
  question: string
  answer: string
}

export const FAQS: readonly Faq[] = [
  {
    question: 'Is Snooker Stake real-money gambling?',
    answer:
      'No. This website does not take deposits, pay withdrawals, or offer cash prizes. Inside the app, table stakes use a virtual balance. The app labels that balance USDT. Treat it as in-app play. Nothing on this site moves real money.'
  },
  {
    question: 'Where is the Android download?',
    answer:
      'The player app is Snooker Stake, package com.snookerx.game. This page links to an APK only when a public https address is configured. Until then there is no file to install, and the page says so. The staff app is a different package and is not offered here.'
  },
  {
    question: 'Is it on Google Play?',
    answer:
      'No. This site is not a Google Play listing and does not claim that Google has reviewed a file. Installing an APK means Android’s prompt to allow unknown apps. That prompt is a setting on your phone, not a security certificate from us.'
  },
  {
    question: 'Can I practise against the computer?',
    answer:
      'Yes. Practice has Easy, Medium, and Hard robots. The robot is only used on the practice table. A live match or a tournament will not seat a bot opposite you. Practice has no stake. If your in-app balance is zero, practice is limited to three matches a day. With a balance above zero, that daily cap is not applied.'
  },
  {
    question: 'How do I play another person?',
    answer:
      'Online play is an invitation, not a list of open tables you browse. Open a table and it is offered to people who are connected, or invite one friend. An offer lasts about 90 seconds. Your balance is not held while you wait. Both stakes lock only if someone accepts. You can add a friend by searching their unique username. Players who are offline are not offered the table.'
  },
  {
    question: 'How many reds are on the table?',
    answer:
      'Practice, and any match staked below 100 on the in-app balance, uses 6 reds. From 100 upward, including every Master Match, the rack is 10 reds. The six colours and the white cue ball are always there. This game does not award a free ball.'
  },
  {
    question: 'How long is a match, and how do tournaments work?',
    answer:
      'A match is one frame, best of 3, or best of 5. A tournament seats eight people and starts when the eighth player joins. The default length is best of 3, and a new tournament defaults to no entry fee. The bracket is a knockout: quarter-finals, semi-finals, then the final. Bots cannot join.'
  },
  {
    question: 'What rules will I actually meet?',
    answer:
      'While reds remain, the first contact has to be a red. Potting a red scores one and you may then nominate a colour. That colour is re-spotted while reds are still out, and you return to a red. After the last red, colours stay down in order: yellow, green, brown, blue, pink, black. A legal pot keeps the visit. Fouls give the opponent at least four points, or the value of the highest ball involved, up to seven. The cue ball is placed inside the D at the break-off and when it is potted or leaves the table. Any other foul is played from where the cue ball lies. Each visit has a shot clock. The default is 30 seconds, and the operator can change it. If it runs out with no shot, that is a foul and the visit passes. The server simulates the stroke and your phone replays it.'
  },
  {
    question: 'What does my phone need?',
    answer:
      'The player project targets Android with a minimum SDK of 23, which is Android 6.0. Graphics default to automatic: lower on a weak phone, higher on a stronger one. You can pin Low, Medium, or High in settings. This page does not publish a file size or a build number, because no public APK address is part of the source. We do not claim a malware scan or a Play Protect verdict.'
  },
  {
    question: 'Does a new account start with a balance?',
    answer:
      'A new account starts with a welcome balance of 1 in-app unit. You can share an invite code. If the invited player finishes a first real match, the inviter can receive 1 in-app unit. That is a ledger credit inside the app, not a cash payment from this website. A practice match counts toward that invite only when the operator turns that option on. It is off by default.'
  }
]

export interface Step {
  title: string
  body: string
}

export const START_STEPS: readonly Step[] = [
  {
    title: 'Install the player app',
    body: 'Use the Android download on this page once it is published. Until that button is live, there is no file to install.'
  },
  {
    title: 'Create an account',
    body: 'A new account opens with a welcome balance of 1 in-app unit. That balance is for table stakes inside the app.'
  },
  {
    title: 'Pick who you face',
    body: 'Practice seats a robot. Online play offers the table to people who are connected, or to one friend you choose.'
  },
  {
    title: 'Play the shot',
    body: 'Aim on the cloth, set the power, add spin if you want it, and release. The server runs the balls and the phone shows the result.'
  }
]

export const CONTROL_STEPS: readonly Step[] = [
  {
    title: 'Aim',
    body: 'Move a finger across the cloth to point the cue. The aim line runs from the cue ball toward the target. A pointer does the same thing.'
  },
  {
    title: 'Power',
    body: 'Drag the power slider or hold to charge the shot. On a keyboard, the up and down keys trim the strength before you play.'
  },
  {
    title: 'Spin',
    body: 'The spin dial moves the cue tip: side, top, or bottom. On a keyboard, left and right are side spin, and W and S are top and bottom.'
  },
  {
    title: 'Shoot',
    body: 'Release the charge to play the shot. On a keyboard, Space does it. The server simulates the stroke and the phone replays it.'
  },
  {
    title: 'Camera',
    body: 'The camera tool in a match switches cue-ball, broadcast, side, close-up, and overhead views. With a mouse, right-drag or middle-drag orbits the table.'
  },
  {
    title: 'Cue ball in the D',
    body: 'Place the cue ball inside the D at the break-off, and again when it comes back in hand after leaving the table. A foul that leaves the cue ball on the cloth does not let you move it.'
  },
  {
    title: 'Shot clock',
    body: 'Each visit has a turn clock. The default is 30 seconds. If it runs out with no stroke, a foul is given and the visit changes. The operator can change the length.'
  }
]

export const RULES: readonly Step[] = [
  {
    title: 'Opening contact',
    body: 'While reds remain, the ball on is a red. Your first contact must be a red. Potting a red scores one and keeps the visit.'
  },
  {
    title: 'Colour after a red',
    body: 'After a red you nominate a colour. Pot it for its value and it is re-spotted while reds are still on the table. You then go back to a red.'
  },
  {
    title: 'Clearing the colours',
    body: 'When the last red is gone, colours are taken in order: yellow, green, brown, blue, pink, black. They stay down once potted in this phase.'
  },
  {
    title: 'Fouls',
    body: 'A foul gives the opponent at least four points, or the value of the highest ball involved, up to seven for the black. There is no free ball on this table.'
  },
  {
    title: 'Cue ball in hand',
    body: 'The cue ball is in hand at the break-off and when it is potted or leaves the table. It may be placed only inside the D. Any other foul is played from where the cue ball lies.'
  }
]

export const INSTALL_STEPS: readonly Step[] = [
  {
    title: 'Download the player file',
    body: 'When the button on this page is live, it is the player APK for com.snookerx.game. Do not install a staff or admin build in its place.'
  },
  {
    title: 'Open it on the phone',
    body: 'Android may block the file. That is the usual prompt for an app that did not come from a store listing.'
  },
  {
    title: 'Allow the install, if you choose to',
    body: 'In Settings, find “install unknown apps” (often under Apps, then Special app access) and allow the browser or files app you used. The switch is on your phone. This site cannot grant it, and turning it on is not a review of the file.'
  },
  {
    title: 'Check the name, then confirm',
    body: 'The install prompt should name Snooker Stake and the package com.snookerx.game. Confirm only if that is the app you expected.'
  },
  {
    title: 'Open the app and create an account',
    body: 'You will need a network path to the game server the app was built against. This website is only the download page. It does not sign you in and it does not start a match.'
  }
]

export interface ColourBall {
  name: string
  value: string
  swatch: string
}

export const COLOUR_BALLS: readonly ColourBall[] = [
  { name: 'Red', value: '1', swatch: 'red' },
  { name: 'Yellow', value: '2', swatch: 'yellow' },
  { name: 'Green', value: '3', swatch: 'green' },
  { name: 'Brown', value: '4', swatch: 'brown' },
  { name: 'Blue', value: '5', swatch: 'blue' },
  { name: 'Pink', value: '6', swatch: 'pink' },
  { name: 'Black', value: '7', swatch: 'black' },
  { name: 'Cue', value: '—', swatch: 'cue' }
]
