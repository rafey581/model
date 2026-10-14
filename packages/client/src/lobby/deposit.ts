import { DEPOSIT_COPY } from './content.js'
import { accentHeadline, el } from './dom.js'
import { ICONS } from './icons.js'
import { api } from '../game/network.js'

/**
 * The deposit screen: instructions + the request form on the left, the player's
 * deposit history on the right.
 *
 * This is a manual, admin-verified flow. No crypto moves through the game server:
 * the player sends USDT to the operator's external wallet, then posts a
 * transaction id and a screenshot. The form here only creates the request; the
 * credit is applied when an admin approves it in the admin app.
 */

export interface DepositInfo {
  enabled: boolean
  network: string
  currency: string
  walletAddress: string
  minUsdt: number
  maxUsdt: number
  screenshotMaxBytes: number
}

export interface DepositRow {
  id: string
  amount: string | number
  currency: string
  network: string
  status: string
  txHash: string | null
  creditedAmount: string | number | null
  rejectReason: string | null
  createdAt: string
  reviewedAt: string | null
}

export interface DepositViewData {
  info: DepositInfo
  history: DepositRow[]
}

export interface DepositActions {
  onBack: () => void
  /** Called after a successful request so the screen can reload the history. */
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

export function renderDeposit(data: DepositViewData | null, actions: DepositActions): HTMLElement {
  const screen = el('div', 'gl-screen')
  screen.dataset.view = 'deposit'

  const top = el('div', 'gl-home-head')
  top.append(backButton(DEPOSIT_COPY.back, actions.onBack))
  const head = el('div', 'gl-deposit-head')
  head.append(el('div', 'gl-label', DEPOSIT_COPY.eyebrow), accentHeadline(DEPOSIT_COPY.headline, 2))
  top.appendChild(head)
  screen.appendChild(top)

  if (!data) {
    const loading = el('div', 'gl-panel gl-deposit-loading')
    loading.textContent = 'Loading…'
    screen.appendChild(loading)
    return screen
  }

  if (!data.info.enabled) {
    screen.appendChild(el('div', 'gl-panel gl-deposit-note', DEPOSIT_COPY.disabled))
    return screen
  }
  if (!data.info.walletAddress) {
    screen.appendChild(el('div', 'gl-panel gl-deposit-note', DEPOSIT_COPY.notConfigured))
    return screen
  }

  const grid = el('div', 'gl-deposit')
  grid.appendChild(renderForm(data.info, actions))
  grid.appendChild(renderHistory(data.history))
  screen.appendChild(grid)

  return screen
}

function renderForm(info: DepositInfo, actions: DepositActions): HTMLElement {
  const panel = el('div', 'gl-panel gl-deposit-form')

  panel.appendChild(el('p', 'gl-deposit-intro', DEPOSIT_COPY.intro))

  // --- Address to send to ----------------------------------------------------
  const addressRow = el('div', 'gl-deposit-address')
  addressRow.appendChild(el('div', 'gl-deposit-label', DEPOSIT_COPY.addressLabel))
  const addressWrap = el('div', 'gl-deposit-address-row')
  const addressCode = el('code', 'gl-deposit-address-code', info.walletAddress)
  addressCode.title = info.walletAddress
  const copyBtn = el('button', 'ghost gl-deposit-copy') as HTMLButtonElement
  copyBtn.type = 'button'
  copyBtn.textContent = DEPOSIT_COPY.copyAddress
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(info.walletAddress)
      actions.toast(DEPOSIT_COPY.copied)
    } catch {
      actions.toast('could not copy the address', 'error')
    }
  }
  addressWrap.append(addressCode, copyBtn)
  addressRow.appendChild(addressWrap)
  panel.appendChild(addressRow)

  // --- Amount -----------------------------------------------------------------
  panel.appendChild(el('div', 'gl-deposit-label', DEPOSIT_COPY.amountLabel))
  const amount = el('input', 'gl-deposit-input') as HTMLInputElement
  amount.type = 'number'
  amount.min = String(info.minUsdt)
  amount.max = String(info.maxUsdt)
  amount.step = '1'
  amount.placeholder = String(info.minUsdt)
  panel.appendChild(amount)
  panel.appendChild(el('div', 'gl-deposit-hint', DEPOSIT_COPY.amountHint(info.minUsdt, info.maxUsdt)))

  // --- Transaction id ----------------------------------------------------------
  panel.appendChild(el('div', 'gl-deposit-label', DEPOSIT_COPY.txLabel))
  const txHash = el('input', 'gl-deposit-input') as HTMLInputElement
  txHash.type = 'text'
  txHash.placeholder = DEPOSIT_COPY.txPlaceholder
  txHash.maxLength = 200
  txHash.autocomplete = 'off'
  panel.appendChild(txHash)

  // --- Proof screenshot ---------------------------------------------------------
  panel.appendChild(el('div', 'gl-deposit-label', DEPOSIT_COPY.proofLabel))
  let screenshot: string | null = null
  const preview = el('div', 'gl-deposit-preview')
  preview.style.display = 'none'
  const file = el('input', 'gl-deposit-file') as HTMLInputElement
  file.type = 'file'
  file.accept = 'image/png,image/jpeg,image/webp'
  file.style.display = 'none'
  const fileBtn = el('button', 'ghost') as HTMLButtonElement
  fileBtn.type = 'button'
  fileBtn.textContent = DEPOSIT_COPY.chooseFile
  fileBtn.onclick = () => file.click()
  file.onchange = () => {
    const chosen = file.files?.[0]
    if (!chosen) return
    // Rough guard before we read the whole file into memory.
    if (chosen.size > info.screenshotMaxBytes) {
      actions.toast('that image is too large — try a smaller screenshot', 'error')
      file.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      screenshot = typeof reader.result === 'string' ? reader.result : null
      if (screenshot) {
        const img = el('img') as HTMLImageElement
        img.src = screenshot
        img.alt = 'proof screenshot preview'
        img.referrerPolicy = 'no-referrer'
        preview.replaceChildren(img)
        preview.style.display = ''
        fileBtn.textContent = DEPOSIT_COPY.changeFile
      }
    }
    reader.readAsDataURL(chosen)
  }
  panel.append(fileBtn, file, preview)
  panel.appendChild(el('p', 'gl-deposit-hint', DEPOSIT_COPY.proofHint))

  // --- Submit --------------------------------------------------------------------
  const submit = el('button', 'gl-deposit-submit') as HTMLButtonElement
  submit.type = 'button'
  submit.textContent = DEPOSIT_COPY.submit
  const setSubmitting = (busy: boolean): void => {
    submit.disabled = busy
    submit.textContent = busy ? DEPOSIT_COPY.submitting : DEPOSIT_COPY.submit
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
    const tx = txHash.value.trim()
    if (tx.length < 8) {
      actions.toast('enter the transaction id', 'error')
      return
    }
    if (!screenshot) {
      actions.toast('upload the proof screenshot', 'error')
      return
    }
    setSubmitting(true)
    try {
      await api<{ id: string }>('/deposits', {
        method: 'POST',
        body: { amountUsdt: value, txHash: tx, screenshot }
      })
      actions.toast(DEPOSIT_COPY.submitted)
      amount.value = ''
      txHash.value = ''
      file.value = ''
      screenshot = null
      preview.replaceChildren()
      preview.style.display = 'none'
      fileBtn.textContent = DEPOSIT_COPY.chooseFile
      actions.onSubmitted()
    } catch (error) {
      actions.toast((error as Error).message, 'error')
      setSubmitting(false)
    }
  }
  panel.appendChild(submit)

  return panel
}

function renderHistory(rows: DepositRow[]): HTMLElement {
  const panel = el('div', 'gl-panel gl-deposit-history')
  panel.appendChild(el('div', 'gl-deposit-label', DEPOSIT_COPY.historyTitle))

  if (rows.length === 0) {
    panel.appendChild(el('div', 'gl-deposit-empty', DEPOSIT_COPY.empty))
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
    if (row.txHash) {
      const tx = el('code', undefined, row.txHash)
      tx.title = row.txHash
      details.appendChild(tx)
    }
    if (row.status === 'APPROVED' && row.creditedAmount !== null && row.creditedAmount !== undefined) {
      details.appendChild(el('div', 'gl-deposit-item-credited', DEPOSIT_COPY.credited(Number(row.creditedAmount))))
    }
    if (row.status === 'REJECTED' && row.rejectReason) {
      details.appendChild(el('div', 'gl-deposit-item-reject', `${DEPOSIT_COPY.rejectedPrefix}${row.rejectReason}`))
    }
    item.append(head, details)
    panel.appendChild(item)
  }
  return panel
}