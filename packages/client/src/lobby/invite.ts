import { APP_TITLE } from '@snooker/shared'
import { INVITE_COPY } from './content.js'
import { accentHeadline, el } from './dom.js'
import { ICONS } from './icons.js'
import { api } from '../game/network.js'

/**
 * The invite screen: show the player's unique code and link, make them easy to
 * share, and track the players they brought in. The screen loads its own data so
 * it stays correct after the code is minted on first open.
 */

export interface ReferralRow {
  username: string
  joinedAt: string
  rewarded: boolean
  rewardedAt: string | null
}

export interface ReferralSummary {
  enabled: boolean
  code: string
  link: string
  bonusUsdt: number
  invitedCount: number
  rewardedCount: number
  pendingCount: number
  earnedUsdt: number
  referrals: ReferralRow[]
}

export interface InviteActions {
  onBack: () => void
  toast: (message: string, kind?: 'error' | 'info') => void
}

function backButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = el('button', 'gl-link-back') as HTMLButtonElement
  btn.type = 'button'
  const icon = el('span')
  icon.innerHTML = ICONS.back
  btn.append(icon, document.createTextNode(label))
  btn.onclick = onClick
  return btn
}

function actionButton(label: string, variant: string, onClick: () => void): HTMLButtonElement {
  const btn = el('button', `gl-friends-btn gl-friends-btn--${variant}`) as HTMLButtonElement
  btn.type = 'button'
  btn.textContent = label
  btn.onclick = onClick
  return btn
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function renderInvite(actions: InviteActions): HTMLElement {
  const screen = el('div', 'gl-screen')
  screen.dataset.view = 'invite'

  const top = el('div', 'gl-home-head')
  top.append(backButton(INVITE_COPY.back, actions.onBack))
  const head = el('div', 'gl-deposit-head')
  head.append(el('div', 'gl-label', INVITE_COPY.eyebrow), accentHeadline(INVITE_COPY.headline, 2))
  top.appendChild(head)
  screen.appendChild(top)

  const grid = el('div', 'gl-invite')
  const sharePanel = el('div', 'gl-panel gl-invite-share')
  const peoplePanel = el('div', 'gl-panel gl-invite-people')
  grid.append(sharePanel, peoplePanel)
  screen.appendChild(grid)

  sharePanel.appendChild(el('p', 'gl-deposit-intro', 'Loading…'))

  const refresh = async (): Promise<void> => {
    try {
      const data = await api<ReferralSummary>('/referrals')
      sharePanel.textContent = ''
      peoplePanel.textContent = ''

      if (!data.enabled) {
        sharePanel.appendChild(el('div', 'gl-deposit-note', INVITE_COPY.disabled))
        return
      }

      const copyCode = async (): Promise<void> => {
        const ok = await copyToClipboard(data.code)
        actions.toast(ok ? INVITE_COPY.copied : INVITE_COPY.copyFailed, ok ? 'info' : 'error')
      }
      const copyLink = async (): Promise<void> => {
        const ok = await copyToClipboard(data.link)
        actions.toast(ok ? INVITE_COPY.copied : INVITE_COPY.copyFailed, ok ? 'info' : 'error')
      }
      const share = async (): Promise<void> => {
        if (typeof navigator.share === 'function') {
          try {
            await navigator.share({
              title: APP_TITLE,
              text: INVITE_COPY.shareText(data.bonusUsdt),
              url: data.link
            })
            return
          } catch {
            // The player dismissed the sheet — nothing to report.
            return
          }
        }
        await copyLink()
      }

      // ── Left: the code, the link, and the buttons to pass them on ──────────
      sharePanel.appendChild(el('p', 'gl-deposit-intro', INVITE_COPY.intro))

      sharePanel.appendChild(el('div', 'gl-deposit-label', INVITE_COPY.codeLabel))
      sharePanel.appendChild(el('div', 'gl-invite-code', data.code))

      const buttons = el('div', 'gl-invite-actions')
      buttons.append(
        actionButton(INVITE_COPY.copyCode, 'primary', () => void copyCode()),
        actionButton(INVITE_COPY.copyLink, 'accept', () => void copyLink())
      )
      if (typeof navigator.share === 'function') {
        buttons.appendChild(actionButton(INVITE_COPY.share, 'primary', () => void share()))
      }
      sharePanel.appendChild(buttons)

      sharePanel.appendChild(el('div', 'gl-deposit-label', INVITE_COPY.linkLabel))
      const linkRow = el('div', 'gl-deposit-address-row')
      const linkCode = el('code', 'gl-deposit-address-code', data.link)
      linkCode.title = data.link
      const linkCopy = el('button', 'ghost gl-deposit-copy') as HTMLButtonElement
      linkCopy.type = 'button'
      linkCopy.textContent = INVITE_COPY.copyLink
      linkCopy.onclick = () => void copyLink()
      linkRow.append(linkCode, linkCopy)
      sharePanel.appendChild(linkRow)

      const stats = el('div', 'gl-invite-stats')
      stats.append(
        statCell(INVITE_COPY.statInvited, String(data.invitedCount)),
        statCell(INVITE_COPY.statPlayed, String(data.rewardedCount)),
        statCell(INVITE_COPY.statEarned, `${data.earnedUsdt} ${INVITE_COPY.earnedSuffix}`)
      )
      sharePanel.appendChild(stats)

      // ── Right: who signed up and whether their first match has paid out ─────
      peoplePanel.appendChild(el('div', 'gl-deposit-label', INVITE_COPY.peopleTitle))
      if (data.referrals.length === 0) {
        peoplePanel.appendChild(el('div', 'gl-friends-empty', INVITE_COPY.empty))
        return
      }
      const list = el('div', 'gl-friends-list')
      for (const row of data.referrals) {
        list.appendChild(personRow(row))
      }
      peoplePanel.appendChild(list)
    } catch (error) {
      actions.toast((error as Error).message, 'error')
      sharePanel.textContent = ''
      sharePanel.appendChild(el('div', 'gl-deposit-note', INVITE_COPY.empty))
    }
  }

  void refresh()
  return screen
}

function statCell(label: string, value: string): HTMLElement {
  const cell = el('div', 'gl-invite-stat')
  cell.append(el('div', 'gl-invite-stat-value', value), el('div', 'gl-invite-stat-label', label))
  return cell
}

function personRow(row: ReferralRow): HTMLElement {
  const item = el('div', 'gl-friends-person')
  const info = el('div', 'gl-friends-person-info')
  info.appendChild(el('div', 'gl-friends-person-name', row.username))
  const meta = row.rewarded ? INVITE_COPY.statusPlayed : INVITE_COPY.statusWaiting
  info.appendChild(el('div', 'gl-friends-person-meta', `${meta} · ${INVITE_COPY.joinedOn(row.joinedAt)}`))
  item.appendChild(info)
  if (row.rewarded) {
    const pill = el('span', 'gl-deposit-pill gl-deposit-pill--approved', 'PAID')
    item.appendChild(pill)
  } else {
    const pill = el('span', 'gl-deposit-pill gl-deposit-pill--pending', 'PENDING')
    item.appendChild(pill)
  }
  return item
}
