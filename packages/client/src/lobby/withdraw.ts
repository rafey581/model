import { WITHDRAW_COPY } from './content.js'
import { accentHeadline, el } from './dom.js'
import { ICONS } from './icons.js'
import { api } from '../game/network.js'

/**
 * The withdraw screen: the player picks a USDT amount and their own Solana
 * address. The request travels to the admins with a snapshot of the player's
 * recent matches; on approval the same USDT amount is debited from the wallet
 * and the operator pays the USDT out of band.
 */

export interface WithdrawInfo {
  enabled: boolean
  network: string
  currency: string
  minUsdt: number
  maxUsdt: number
  matchSnapshotCount: number
}

export interface WithdrawRow {
  id: string
  amount: string | number
  currency: string
  network: string
  status: string
  address: string
  deducted: string | number | null
  rejectReason: string | null
  createdAt: string
}

export interface WithdrawViewData {
  info: WithdrawInfo
  history: WithdrawRow[]
}

export interface WithdrawActions {
  walletBalance: number
  onBack: () => void
  onSubmitted: () => void
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

function statusPill(status: string): HTMLElement {
  const pill = el('span', `gl-deposit-pill gl-deposit-pill--${status.toLowerCase()}`)
  pill.textContent = status
  return pill
}

function fmtDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ')
}

/** A USDT amount shown to the player: whole numbers stay whole, else 2dp. */
function fmtUsdt(value: number): string {
  const n = Number.isFinite(value) ? value : 0
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

export function renderWithdraw(data: WithdrawViewData | null, actions: WithdrawActions): HTMLElement {
  const screen = el('div', 'gl-screen')
  screen.dataset.view = 'withdraw'

  const top = el('div', 'gl-home-head')
  top.append(backButton(WITHDRAW_COPY.back, actions.onBack))
  const head = el('div', 'gl-deposit-head')
  head.append(el('div', 'gl-label', WITHDRAW_COPY.eyebrow), accentHeadline(WITHDRAW_COPY.headline, 2))
  top.appendChild(head)
  screen.appendChild(top)

  if (!data) {
    const loading = el('div', 'gl-panel gl-deposit-loading')
    loading.textContent = 'Loading…'
    screen.appendChild(loading)
    return screen
  }

  if (!data.info.enabled) {
    screen.appendChild(el('div', 'gl-panel gl-deposit-note', WITHDRAW_COPY.disabled))
    return screen
  }

  const grid = el('div', 'gl-deposit')
  grid.appendChild(renderForm(data.info, actions))
  grid.appendChild(renderHistory(data.history))
  screen.appendChild(grid)

  return screen
}

function renderForm(info: WithdrawInfo, actions: WithdrawActions): HTMLElement {
  const panel = el('div', 'gl-panel gl-deposit-form')

  panel.appendChild(el('p', 'gl-deposit-intro', WITHDRAW_COPY.intro))

  // --- Balance --------------------------------------------------------------
  const balanceRow = el('div', 'gl-deposit-balance')
  balanceRow.appendChild(el('div', 'gl-deposit-label', WITHDRAW_COPY.balanceLabel))
  const balanceCode = el('code', 'gl-deposit-address-code', `${fmtUsdt(actions.walletBalance)} USDT`)
  balanceRow.appendChild(balanceCode)
  panel.appendChild(balanceRow)

  // --- Amount -----------------------------------------------------------------
  panel.appendChild(el('div', 'gl-deposit-label', WITHDRAW_COPY.amountLabel))
  const amount = el('input', 'gl-deposit-input') as HTMLInputElement
  amount.type = 'number'
  amount.min = String(info.minUsdt)
  amount.max = String(info.maxUsdt)
  amount.step = '1'
  amount.placeholder = String(info.minUsdt)
  panel.appendChild(amount)
  panel.appendChild(
    el('div', 'gl-deposit-hint', WITHDRAW_COPY.amountHint(info.minUsdt, info.maxUsdt))
  )

  // --- Receiving address ------------------------------------------------------
  panel.appendChild(el('div', 'gl-deposit-label', WITHDRAW_COPY.addressLabel))
  const address = el('input', 'gl-deposit-input') as HTMLInputElement
  address.type = 'text'
  address.placeholder = WITHDRAW_COPY.addressPlaceholder
  address.maxLength = 120
  address.autocomplete = 'off'
  panel.appendChild(address)

  // --- Submit --------------------------------------------------------------------
  const submit = el('button', 'gl-deposit-submit') as HTMLButtonElement
  submit.type = 'button'
  submit.textContent = WITHDRAW_COPY.submit
  const setSubmitting = (busy: boolean): void => {
    submit.disabled = busy
    submit.textContent = busy ? WITHDRAW_COPY.submitting : WITHDRAW_COPY.submit
  }
  submit.onclick = async () => {
    const value = Number(amount.value)
    if (!Number.isFinite(value) || value <= 0) {
      actions.toast('enter a valid amount', 'error')
      return
    }
    if (value < info.minUsdt || value > info.maxUsdt) {
      actions.toast(`amount must be between ${info.minUsdt} and ${info.maxUsdt} ${info.currency}`, 'error')
      return
    }
    const needed = value
    if (actions.walletBalance < needed) {
      actions.toast(`${WITHDRAW_COPY.insufficient} (need ${fmtUsdt(needed)} USDT)`, 'error')
      return
    }
    const addr = address.value.trim()
    if (addr.length < 20) {
      actions.toast('enter the wallet address that should receive the funds', 'error')
      return
    }
    setSubmitting(true)
    try {
      await api<{ id: string }>('/withdrawals', {
        method: 'POST',
        body: { amountUsdt: value, address: addr }
      })
      actions.toast(WITHDRAW_COPY.submitted)
      amount.value = ''
      address.value = ''
      actions.onSubmitted()
    } catch (error) {
      actions.toast((error as Error).message, 'error')
      setSubmitting(false)
    }
  }
  panel.appendChild(submit)

  return panel
}

function renderHistory(rows: WithdrawRow[]): HTMLElement {
  const panel = el('div', 'gl-panel gl-deposit-history')
  panel.appendChild(el('div', 'gl-deposit-label', WITHDRAW_COPY.historyTitle))

  if (rows.length === 0) {
    panel.appendChild(el('div', 'gl-deposit-empty', WITHDRAW_COPY.empty))
    return panel
  }

  for (const row of rows) {
    const item = el('div', 'gl-deposit-item')
    const head = el('div', 'gl-deposit-item-head')
    const left = el('div')
    const amount = `${Number(row.amount)} ${row.currency}`
    left.appendChild(el('div', 'gl-deposit-item-amount', amount))
    left.appendChild(el('div', 'gl-deposit-item-meta', `${row.network} · ${fmtDate(row.createdAt)}`))
    head.append(left, statusPill(row.status))

    const details = el('div', 'gl-deposit-item-details')
    const addr = el('code', undefined, row.address)
    addr.title = row.address
    details.appendChild(addr)
    if (row.status === 'APPROVED' && row.deducted !== null && row.deducted !== undefined) {
      details.appendChild(el('div', 'gl-deposit-item-credited', WITHDRAW_COPY.deducted(Number(row.deducted))))
    }
    if (row.status === 'REJECTED' && row.rejectReason) {
      details.appendChild(el('div', 'gl-deposit-item-reject', `${WITHDRAW_COPY.rejectedPrefix}${row.rejectReason}`))
    }
    item.append(head, details)
    panel.appendChild(item)
  }
  return panel
}