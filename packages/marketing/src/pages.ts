import { COLOUR_BALLS } from './content'
import { docHero, siteFooter, siteHeader, type SitePage } from './chrome'
import { escapeHtml } from './html'
import type { SiteConfig } from './site-config'

function colours(): string {
  return COLOUR_BALLS.map(
    (ball) =>
      `<li><span class="swatch ${ball.swatch}" aria-hidden="true"></span><span>${escapeHtml(ball.name)}</span><b>${escapeHtml(ball.value)}</b></li>`
  ).join('')
}

function frame(page: SitePage, config: SiteConfig, main: string): string {
  return `${siteHeader(config, page)}
    <main id="content">${main}</main>
    ${siteFooter()}`
}

export function renderRulesBody(config: SiteConfig): string {
  return frame(
    'rules',
    config,
    `${docHero(
      'The table',
      'The rules this table <em>actually plays.</em>',
      'This is the snooker in the app, not a claim that every official competition rule is switched on. Where the game is shorter or different, the page says so.',
      'Play snooker. Sharpen your skills. Own the table.'
    )}
    <div class="wrap narrow doc">
      <section>
        <h2>The rack</h2>
        <p>Practice, and any match staked below 100 on the in-app balance, is racked with <strong>6 reds</strong>. From 100 upward, including every Master Match, the rack is <strong>10 reds</strong>. It is not a 15-red frame. The six colours and the white cue ball are always there.</p>
        <ol class="colours">${colours()}</ol>
        <p>A red is worth 1. Yellow 2, green 3, brown 4, blue 5, pink 6, black 7. There is <strong>no free ball</strong>.</p>
      </section>
      <section>
        <h2>A visit</h2>
        <p>While reds remain, the ball on is a red. The first ball you touch has to be a red. Pot a red and you score one point for each red potted on that stroke, and you stay at the table. You then nominate a colour. Any colour still on the table may be struck first. Pot it and it scores its own value, then it is re-spotted, and you go back to a red.</p>
        <p>When the last red is gone, colours are played in order and they stay down: yellow, green, brown, blue, pink, black. A legal pot keeps the visit. A miss, or a foul, ends it.</p>
        <p>The server simulates the stroke. The phone replays what the server decided.</p>
      </section>
      <section>
        <h2>Fouls</h2>
        <p>A foul is at least 4 points, or the value of the highest ball involved, up to 7. Involved means the ball on, the first ball struck, and any ball potted. The points go to the opponent, and your break goes back to zero.</p>
        <ul>
          <li>Potting the cue ball.</li>
          <li>Missing a legal contact, or hitting the wrong ball first.</li>
          <li>Potting a colour while a red is the ball on, or potting a red while a colour is on.</li>
          <li>While colours are being cleared, potting a colour that is not the one on.</li>
        </ul>
        <p>After a foul played as a stroke, the opponent chooses: play on from the new position, or have the balls put back so the offender plays the shot again. A visit that simply runs out of time is not that choice. The clock foul is given, and the visit passes.</p>
      </section>
      <section>
        <h2>The D</h2>
        <p>The cue ball is in hand, and it may be placed only inside the D, at the break-off, when it is potted, and when it leaves the table. A foul that leaves the cue ball on the cloth does not let you pick it up. The next stroke is played from where it lies.</p>
      </section>
      <section>
        <h2>The clock, and a dropped connection</h2>
        <p>Each visit has a shot clock. The source default is 30 seconds, and the operator can change it. If it expires with no stroke, the foul is at least 4, or the value of the ball on if that is higher.</p>
        <p>If a player disconnects during a live match, the other player is shown a countdown. The source default is 30 seconds, also changeable. Come back inside it and the match continues. If one player does not, the player still connected is settled as the winner. If both are gone and the frames are level, the stake is refunded to the ledger. If both are gone and one player is ahead on frames, that player is settled as the winner. A practice match is closed as abandoned. None of this is a promise about a cash payout.</p>
      </section>
      <section>
        <h2>How long you play</h2>
        <p>A match is one frame, best of 3, or best of 5. A tournament seats eight people and starts when the eighth joins. New tournaments default to best of 3 and an entry of zero. The bracket is quarters, semis, and a final. The robot is only on the practice table. It cannot take a competitive seat.</p>
        <p class="fine">A longer official rulebook also covers things this game does not claim, including a free ball. Play what is on this page.</p>
      </section>
    </div>`
  )
}

export function renderLedgerBody(config: SiteConfig): string {
  return frame(
    'ledger',
    config,
    `${docHero(
      'The ledger',
      'A balance for the table, <em>not a cashier.</em>',
      'This website does not take deposits, show a wallet address, or pay withdrawals. A public real-money launch is not offered here.',
      'Your next great break starts here.'
    )}
    <div class="wrap narrow doc">
      <p class="banner">Do not send cryptocurrency, bank transfers, or any other funds because of this page. There is no address, QR code, or amount to pay on it.</p>
      <section>
        <h2>What the app keeps today</h2>
        <p>Inside the player app, table stakes use a virtual balance. The app labels that unit USDT. A new account starts with 1. Open tables are 1, 5, 10, 20, 50, or 100. Master Match is 500, 1000, 2000, 3000, or 5000. Nothing is held while an invitation waits. Both stakes lock only when someone accepts.</p>
        <p>On a staked match the software can take a platform fee from the combined stake. The source default is 10 percent, and an operator can change that percentage. Practice is unstaked. A new tournament is created with no entry fee and no platform fee. An invite can credit the inviter 1 in-app unit after the invited player finishes a first real match. A practice match counts toward that only if the operator turns the option on. It is off in the source by default. None of these credits are a cash payment from this website.</p>
      </section>
      <section>
        <h2>What is not switched on</h2>
        <p>Automatic crypto routes do not move money. With <span class="mono">REAL_MONEY_ENABLED</span> left false, <span class="mono">POST /api/crypto/deposit</span> and <span class="mono">POST /api/crypto/withdraw</span> answer 403. Turning that flag on does not finish them. They still answer 501, because no payment provider is connected.</p>
        <p>Two other switches, <span class="mono">DEPOSIT_ENABLED</span> and <span class="mono">WITHDRAW_ENABLED</span>, gate a manual bookkeeping flow. If the environment variable is unset, the source defaults them to on. That is a fact about the code, not a reading of the live server, and not permission to use the flow. This website does not know the live values, does not change them, and does not offer the flow.</p>
      </section>
      <section>
        <h2>Manual deposit, only if it is later authorized</h2>
        <p>If an operator has a legal basis and explicitly enables it inside the app, the software’s manual deposit works like this. The coins never pass through the game server.</p>
        <ol class="sheet">
          <li>
            <h3>An address would appear in the app</h3>
            <p>The player would be shown an operator wallet on Solana. This website does not publish that address.</p>
          </li>
          <li>
            <h3>The player would send USDT or USDC themselves</h3>
            <p>The transfer happens in the player’s own wallet. The app then asks for the transaction id and a PNG or JPG screenshot.</p>
          </li>
          <li>
            <h3>Staff approve, or they do not</h3>
            <p>Staff are told to check the transaction before crediting anyone. Approval credits the ledger the same amount, one for one. A transaction id can be used once. A rejection does not credit the balance.</p>
          </li>
        </ol>
        <p>If the amount settings are left unset, the source defaults are a minimum of 5 and a maximum of 1000, and a proof image up to 4 MB. Those numbers describe the code. They are not a live limit, not a fee, and not an amount anyone should send.</p>
      </section>
      <section>
        <h2>Manual withdrawal, only if it is later authorized</h2>
        <p>The same condition applies. Nothing on this page is a withdrawal desk, and there is no promise of a payout time.</p>
        <ol class="sheet">
          <li>
            <h3>The player names an amount and their own Solana address</h3>
            <p>The amount is held at once, moved from available to locked, so it cannot be staked or requested again while the request is open.</p>
          </li>
          <li>
            <h3>Staff review, then approve</h3>
            <p>The request carries a short snapshot of recent non-practice matches. Approval takes the held amount off the ledger. The staff screen then says to send that amount. The transfer is a separate manual step after approval, not before it.</p>
          </li>
          <li>
            <h3>Reject or cancel</h3>
            <p>If staff reject a pending request, or the player cancels it, the hold goes back to available. The app does not adjudicate a legal dispute. There is no payout deadline in the software.</p>
          </li>
        </ol>
        <p class="fine">The same unset defaults of 5 and 1000 apply to a withdrawal request in the source. Again, that is not a live figure and not an instruction.</p>
      </section>
    </div>`
  )
}

export function renderPoliciesBody(config: SiteConfig): string {
  return frame(
    'policies',
    config,
    `${docHero(
      'Draft',
      'How the table is run, <em>still in draft.</em>',
      'Some of this page is what the software already does. The rest is a draft the owner has to finish with a lawyer before anyone treats it as terms. This website is not a cashier.',
      'Play snooker. Sharpen your skills. Own the table.'
    )}
    <div class="wrap narrow doc">
      <p class="banner">Draft for the owner. Not an approved legal document. No company, licence, court, or support address is stated here, because those decisions have not been made.</p>
      <section>
        <h2>Accounts <span class="tag">In the software</span></h2>
        <p>Creating an account asks for an email, a unique username, a name, a phone number, a password, and a date of birth. The password is stored as a hash. The source default refuses a date of birth that makes the player younger than 18. An operator can change that number. The check is the date entered at signup. The software does not describe a separate identity document or KYC review.</p>
        <p>When direct registration is on, which is the source default, the account is marked email-verified without a proof code. That switch can be turned off. A one-time email code exists in the code for when mail is configured. This page does not know which path the live server uses.</p>
        <p>An optional device id can be sent. A referral code can be entered. Self-referral is refused.</p>
      </section>
      <section>
        <h2>Fair play <span class="tag">In the software</span></h2>
        <p>The server decides the balls, the score, and the winner. The phone shows that result. A robot is available only on the practice table. A live match or a tournament will not seat one opposite you. Match stakes lock only when an invitation is accepted. Disconnects are handled by the countdown described on the <a href="/rules.html">rules page</a>.</p>
      </section>
      <section>
        <h2>Virtual balance <span class="tag">In the software</span></h2>
        <p>Stakes, welcome credit, invite credit, and any platform fee are movements on an in-app ledger. They are not a cash balance offered by this website. The fee and the manual deposit and withdrawal notes, including what is not enabled, are on the <a href="/ledger.html">balance page</a>.</p>
      </section>
      <section>
        <h2>Responsible play <span class="tag tag-draft">Draft</span></h2>
        <p>Play it as a game. This website is not asking you to deposit, and it is not a place to recover losses. The software does not currently publish a self-exclusion switch, a deposit limit, or a cool-off timer for this marketing site to describe.</p>
        <p>Before any public real-money launch, the owner has to decide those tools and whatever the law of the operating country requires. That decision is open. It is not done here.</p>
      </section>
      <section>
        <h2>Privacy <span class="tag tag-draft">Draft</span></h2>
        <p>This marketing site does not run third-party analytics, advertising pixels, or a consent banner that secretly loads them. Fonts are files shipped with the site. The only extra request the page makes is its own <span class="mono">site-config.json</span>, so a published APK address can be attached later.</p>
        <p>The player app, which is separate, stores the account fields above, session cookies or a bearer token, and the match record. If the manual money flow is enabled in the app, a deposit also stores a transaction id and a screenshot, and a withdrawal stores the address the player typed. This page does not collect those.</p>
        <p>The owner still has to set a retention period, a lawful basis, a contact for access or deletion, and any processor list. None of those are in the source, so none are invented here. Do not treat this section as a finished privacy notice.</p>
      </section>
      <section>
        <h2>Terms <span class="tag tag-draft">Draft</span></h2>
        <p>There is no named legal entity, no jurisdiction, no gambling licence, and no support desk on this site. The Android file, when one is published, is a sideload of package <span class="mono">com.snookerx.game</span>. It is not a Play Store listing. The in-app balance is not a promise that you can withdraw cash.</p>
        <p>Refund timing, chargeback rights, a payout deadline, a security warranty, and a dispute forum are not specified in the software and are not specified here. They have to be written, reviewed, and then published before a public launch that involves other people’s money. Until that document exists, this draft is only a map of the open decisions.</p>
      </section>
      <section>
        <h2>Open before a public launch</h2>
        <ul>
          <li>Who operates the service, in which country, and under what licence if real-money play is ever intended.</li>
          <li>A contact for players, and how long account, match, and payment-proof data is kept.</li>
          <li>Whether manual deposits and withdrawals will be offered at all, and on what final limits.</li>
          <li>Responsible-play tools and any age check beyond the date of birth already in signup.</li>
          <li>How a dispute is handled, and any refund or payout timing the law requires.</li>
        </ul>
      </section>
    </div>`
  )
}
