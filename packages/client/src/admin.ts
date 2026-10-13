import { api } from './game/network.js'
import { renderReplayViewer, type ReplayEvent } from './adminReplay.js'

type ToastFn = (message: string, kind?: 'info' | 'error') => void

interface AdminUser {
  id: string
  username: string
  email: string
  role: string
  status: string
  createdAt: string
  wallet: { available: string | number } | null | undefined
}

interface AdminMatchPlayer {
  seat: number
  userId: string
  user: { id: string; username: string }
}

interface AdminMatch {
  id: string
  matchType: string
  stakePerPlayer: string | number
  format: string
  status: string
  winnerId: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  resultJson: string | null
  players: AdminMatchPlayer[]
}

interface AdminGameEvent {
  seq: number
  type: string
  data: unknown
}

interface FraudFlagRow {
  id: string
  userId: string
  username: string | null
  kind: string
  confidence: number
  reason: string | null
  createdAt: string
}

interface LedgerInvariance {
  ok: boolean
  checked: number
  violations: Array<{ userId: string; expected: number; actual: number; delta: number }>
}

interface AdminActionRow {
  id: string
  adminId: string
  adminUsername: string | null
  action: string
  targetType: string
  targetId: string | null
  meta: unknown
  createdAt: string
}

interface AdminDeposit {
  id: string
  userId: string
  network: string
  address: string
  amount: string | number
  currency: string
  status: string
  txHash: string | null
  screenshot: string | null
  creditedAmount: string | number | null
  rejectReason: string | null
  createdAt: string
  reviewedAt: string | null
  user: { id: string; username: string; email: string | null }
  reviewedBy: { id: string; username: string } | null
}

interface AdminDepositsPayload {
  items: AdminDeposit[]
  pending: number
}

interface AdminWithdrawalMatch {
  matchId: string
  mode: string
  format: string
  stake: number
  status: string
  finishedAt: string | null
  result: 'WIN' | 'LOSS' | 'UNKNOWN'
  opponent: string | null
}

interface AdminWithdrawal {
  id: string
  userId: string
  network: string
  address: string
  amount: string | number
  currency: string
  status: string
  deducted: string | number | null
  matchHistory: AdminWithdrawalMatch[] | null
  rejectReason: string | null
  createdAt: string
  reviewedAt: string | null
  user: { id: string; username: string; email: string | null }
  reviewedBy: { id: string; username: string } | null
}

interface AdminWithdrawalsPayload {
  items: AdminWithdrawal[]
  pending: number
}

const TABS = ['dashboard', 'users', 'matches', 'deposits', 'withdrawals', 'settings', 'fraud', 'audit'] as const
type Tab = (typeof TABS)[number]
let currentTab: Tab = 'dashboard'
/** Deposit list filter ('' = all, else a status) — survives tab re-renders. */
let depositFilter: string = ''
/** Withdrawal list filter ('' = all, else a status) — survives tab re-renders. */
let withdrawalFilter: string = ''

interface TabContext {
  content: HTMLElement
  toast: ToastFn
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function renderAdminPanel(app: HTMLElement, toast: ToastFn): void {
  app.querySelector('.admin')?.remove()
  const panel = el('div', 'admin')
  const nav = el('div', 'admin-nav')
  for (const tab of TABS) {
    const btn = el('button', tab === currentTab ? 'admin-tab active' : 'admin-tab', tab)
    btn.onclick = () => {
      currentTab = tab
      renderAdminPanel(app, toast)
    }
    nav.appendChild(btn)
  }
  const content = el('div', 'admin-content')
  content.id = 'admin-content'
  panel.append(nav, content)
  app.appendChild(panel)
  void loadTab({ content, toast })
}

async function loadTab(ctx: TabContext): Promise<void> {
  const loading = el('div', 'muted admin-loading', 'Loading…')
  ctx.content.replaceChildren(loading)
  try {
    let view: HTMLElement
    switch (currentTab) {
      case 'dashboard':
        view = await dashboardView()
        break
      case 'users':
        view = await usersView(ctx)
        break
      case 'matches':
        view = await matchesView(ctx)
        break
      case 'deposits':
        view = await depositsView(ctx)
        break
      case 'withdrawals':
        view = await withdrawalsView(ctx)
        break
      case 'settings':
        view = await settingsView(ctx)
        break
      case 'fraud':
        view = await fraudView()
        break
      case 'audit':
        view = await auditView()
        break
    }
    ctx.content.replaceChildren(view)
  } catch (error) {
    loading.textContent = (error as Error).message
  }
}

async function dashboardView(): Promise<HTMLElement> {
  const stats = await api<{
    users: number
    activeMatches: number
    completedMatches: number
    deposits: number
    withdrawals: number
    pendingDeposits: number
    pendingWithdrawals: number
    platformRevenue: number
  }>('/admin/stats')
  const c = el('div', 'admin-cards')
  const cards: Array<[string, string]> = [
    ['Registered users', String(stats.users)],
    ['Live matches', String(stats.activeMatches)],
    ['Completed matches', String(stats.completedMatches)],
    ['Deposits', String(stats.deposits)],
    ['Pending reviews', String(stats.pendingDeposits)],
    ['Withdrawals', String(stats.withdrawals)],
    ['Pending payouts', String(stats.pendingWithdrawals)],
    ['Platform revenue (USDT)', String(stats.platformRevenue)]
  ]
  for (const [label, value] of cards) {
    const card = el('div', 'admin-card')
    card.appendChild(el('div', 'admin-card-value', value))
    card.appendChild(el('div', 'muted', label))
    c.appendChild(card)
  }
  return c
}

async function usersView(ctx: TabContext): Promise<HTMLElement> {
  const users = await api<AdminUser[]>('/admin/users')
  const wrap = el('div')
  const table = el('table', 'admin-table') as HTMLTableElement
  const thead = table.createTHead()
  const headRow = thead.insertRow()
  for (const label of ['User', 'Role', 'Status', 'Balance (USDT)', 'Wallet adjust']) {
    headRow.appendChild(el('th', undefined, label))
  }
  const tbody = table.createTBody()
  for (const user of users) {
    const tr = tbody.insertRow()
    const nameCell = tr.insertCell()
    nameCell.appendChild(el('div', undefined, user.username))
    nameCell.appendChild(el('div', 'muted', user.email))
    tr.insertCell().appendChild(makeRoleSelect(user, ctx))
    tr.insertCell().appendChild(makeStatusSelect(user, ctx))
    tr.insertCell().appendChild(el('div', undefined, String(Number(user.wallet?.available ?? 0))))
    tr.insertCell().appendChild(makeAdjustControls(user, ctx))
  }
  wrap.appendChild(table)
  return wrap
}

function makeRoleSelect(user: AdminUser, ctx: TabContext): HTMLSelectElement {
  const select = el('select') as HTMLSelectElement
  for (const role of ['PLAYER', 'ADMIN']) {
    const option = el('option') as HTMLOptionElement
    option.value = role
    option.textContent = role
    select.appendChild(option)
  }
  select.value = user.role
  select.onchange = () => {
    void api<{ id: string; status: string; role: string }>('/admin/users', {
      method: 'PATCH',
      body: { userId: user.id, role: select.value }
    })
      .then((data) => {
        ctx.toast(`${user.username} role -> ${data.role}`)
        void loadTab(ctx)
      })
      .catch((error) => ctx.toast(error.message, 'error'))
  }
  return select
}

function makeStatusSelect(user: AdminUser, ctx: TabContext): HTMLSelectElement {
  const select = el('select') as HTMLSelectElement
  for (const status of ['ACTIVE', 'SUSPENDED', 'BANNED']) {
    const option = el('option') as HTMLOptionElement
    option.value = status
    option.textContent = status
    select.appendChild(option)
  }
  select.value = user.status
  select.onchange = () => {
    void api<{ id: string; status: string; role: string }>('/admin/users', {
      method: 'PATCH',
      body: { userId: user.id, status: select.value }
    })
      .then((data) => {
        ctx.toast(`${user.username} status -> ${data.status}`)
        void loadTab(ctx)
      })
      .catch((error) => ctx.toast(error.message, 'error'))
  }
  return select
}

function makeAdjustControls(user: AdminUser, ctx: TabContext): HTMLElement {
  const row = el('div', 'admin-adjust')
  const amount = el('input') as HTMLInputElement
  amount.type = 'number'
  amount.placeholder = 'amount'
  const reason = el('input') as HTMLInputElement
  reason.type = 'text'
  reason.placeholder = 'reason'
  reason.maxLength = 200
  const apply = el('button', 'ghost', 'Apply')
  apply.onclick = () => {
    const value = Number(amount.value)
    if (!Number.isFinite(value) || value === 0) {
      ctx.toast('Enter a non-zero amount', 'error')
      return
    }
    if (!reason.value.trim()) {
      ctx.toast('Enter a reason (audited)', 'error')
      return
    }
    void api<boolean>('/admin/wallet/adjust', {
      method: 'POST',
      body: { userId: user.id, amount: value, reason: reason.value.trim() }
    })
      .then(() => {
        ctx.toast(`Adjusted ${user.username} by ${value} USDT`)
        void loadTab(ctx)
      })
      .catch((error) => ctx.toast(error.message, 'error'))
  }
  row.append(amount, reason, apply)
  return row
}

async function depositsView(ctx: TabContext): Promise<HTMLElement> {
  const data = await api<AdminDepositsPayload>(`/admin/deposits${depositFilter ? `?status=${depositFilter}` : ''}`)
  const wrap = el('div')

  const toolbar = el('div', 'admin-toolbar')
  toolbar.appendChild(
    el('div', 'muted', data.pending > 0 ? `${data.pending} deposit(s) awaiting review` : 'no pending deposits')
  )
  const filter = el('select') as HTMLSelectElement
  for (const value of ['', 'PENDING', 'APPROVED', 'REJECTED']) {
    const option = el('option') as HTMLOptionElement
    option.value = value
    option.textContent = value === '' ? 'All statuses' : value
    filter.appendChild(option)
  }
  filter.value = depositFilter
  filter.onchange = () => {
    depositFilter = filter.value
    void loadTab(ctx)
  }
  toolbar.appendChild(filter)
  wrap.appendChild(toolbar)

  const table = el('table', 'admin-table') as HTMLTableElement
  const thead = table.createTHead()
  const headRow = thead.insertRow()
  for (const label of ['User', 'Amount', 'Network', 'Tx id', 'Status', 'Created', 'Actions']) {
    headRow.appendChild(el('th', undefined, label))
  }
  const tbody = table.createTBody()
  for (const item of data.items) {
    const tr = tbody.insertRow()

    const nameCell = tr.insertCell()
    nameCell.appendChild(el('div', undefined, item.user.username))
    nameCell.appendChild(el('div', 'muted', item.user.email ?? ''))

    tr.insertCell().appendChild(el('div', undefined, `${Number(item.amount)} ${item.currency}`))
    tr.insertCell().appendChild(el('div', 'muted', item.network))

    const txCell = tr.insertCell()
    if (item.txHash) {
      const tx = el('div', undefined, item.txHash.length > 24 ? `${item.txHash.slice(0, 24)}…` : item.txHash)
      tx.title = item.txHash
      txCell.appendChild(tx)
      if (item.status === 'APPROVED' && item.creditedAmount !== null && item.creditedAmount !== undefined) {
        txCell.appendChild(el('div', 'muted', `${Number(item.creditedAmount)} USDT credited`))
      }
    } else {
      txCell.appendChild(el('div', 'muted', '-'))
    }

    const statusCell = tr.insertCell()
    statusCell.appendChild(el('div', undefined, item.status))
    if (item.status === 'REJECTED' && item.rejectReason) {
      statusCell.appendChild(el('div', 'muted', item.rejectReason))
    }

    tr.insertCell().appendChild(
      el('div', 'muted', new Date(item.createdAt).toISOString().slice(0, 19).replace('T', ' '))
    )

    // Action cell: toggle the proof screenshot when present, approve/reject when pending.
    const actionsCell = tr.insertCell()
    const actionRow = el('div', 'admin-adjust')
    let proofRow: HTMLTableRowElement | null = null
    if (item.screenshot) {
      proofRow = tbody.insertRow()
      proofRow.className = 'admin-proof-row'
      proofRow.style.display = 'none'
      const cell = proofRow.insertCell()
      cell.colSpan = 7
      const img = el('img') as HTMLImageElement
      img.src = item.screenshot
      img.alt = 'proof screenshot'
      img.referrerPolicy = 'no-referrer'
      img.className = 'admin-proof-img'
      cell.appendChild(img)
      const proof = el('button', 'ghost', 'proof')
      proof.onclick = () => {
        if (!proofRow) return
        proofRow.style.display = proofRow.style.display === 'none' ? '' : 'none'
      }
      actionRow.appendChild(proof)
    }
    if (item.status === 'PENDING') {
      const approve = el('button', '', 'Approve') as HTMLButtonElement
      approve.onclick = () => {
        if (!confirm(`Approve ${Number(item.amount)} ${item.currency} for ${item.user.username}?`)) return
        void api<{ credited: number }>(`/admin/deposits/${item.id}/approve`, { method: 'POST', body: {} })
          .then((result) => {
            ctx.toast(`${item.user.username} credited ${result.credited} USDT`)
            void loadTab(ctx)
          })
          .catch((error) => ctx.toast(error.message, 'error'))
      }
      const reject = el('button', '', 'Reject') as HTMLButtonElement
      reject.onclick = () => {
        const reason = prompt('Reject reason (optional)') ?? ''
        void api<{ id: string }>(`/admin/deposits/${item.id}/reject`, {
          method: 'POST',
          body: reason.trim() ? { reason: reason.trim().slice(0, 200) } : {}
        })
          .then(() => {
            ctx.toast(`Deposit ${item.id.slice(0, 8)} rejected`)
            void loadTab(ctx)
          })
          .catch((error) => ctx.toast(error.message, 'error'))
      }
      actionRow.append(approve, reject)
    }
    actionsCell.appendChild(actionRow)
  }
  wrap.appendChild(table)
  return wrap
}

async function withdrawalsView(ctx: TabContext): Promise<HTMLElement> {
  const data = await api<AdminWithdrawalsPayload>(
    `/admin/withdrawals${withdrawalFilter ? `?status=${withdrawalFilter}` : ''}`
  )
  const wrap = el('div')

  const toolbar = el('div', 'admin-toolbar')
  toolbar.appendChild(
    el('div', 'muted', data.pending > 0 ? `${data.pending} withdrawal(s) awaiting payout` : 'no pending withdrawals')
  )
  const filter = el('select') as HTMLSelectElement
  for (const value of ['', 'PENDING', 'APPROVED', 'REJECTED']) {
    const option = el('option') as HTMLOptionElement
    option.value = value
    option.textContent = value === '' ? 'All statuses' : value
    filter.appendChild(option)
  }
  filter.value = withdrawalFilter
  filter.onchange = () => {
    withdrawalFilter = filter.value
    void loadTab(ctx)
  }
  toolbar.appendChild(filter)
  wrap.appendChild(toolbar)

  const table = el('table', 'admin-table') as HTMLTableElement
  const thead = table.createTHead()
  const headRow = thead.insertRow()
  for (const label of ['User', 'Amount', 'Network', 'Address', 'Matches', 'Status', 'Created', 'Actions']) {
    headRow.appendChild(el('th', undefined, label))
  }
  const tbody = table.createTBody()
  for (const item of data.items) {
    const tr = tbody.insertRow()

    const nameCell = tr.insertCell()
    nameCell.appendChild(el('div', undefined, item.user.username))
    nameCell.appendChild(el('div', 'muted', item.user.email ?? ''))

    tr.insertCell().appendChild(el('div', undefined, `${Number(item.amount)} ${item.currency}`))
    tr.insertCell().appendChild(el('div', 'muted', item.network))

    const addrCell = tr.insertCell()
    const addr = el('div', undefined, item.address.length > 20 ? `${item.address.slice(0, 20)}…` : item.address)
    addr.title = item.address
    addrCell.appendChild(addr)

    // Last-5-matches snapshot: the admin's proof that the account really won
    // the games behind the balance. Toggled open like the deposit screenshot.
    const matchCell = tr.insertCell()
    const history = item.matchHistory ?? []
    let matchRow: HTMLTableRowElement | null = null
    if (history.length > 0) {
      const toggle = el('button', 'ghost', `${history.length} game(s)`) as HTMLButtonElement
      matchRow = tbody.insertRow()
      matchRow.className = 'admin-proof-row'
      matchRow.style.display = 'none'
      const cell = matchRow.insertCell()
      cell.colSpan = 8
      const list = el('div', 'admin-match-list')
      for (const m of history) {
        const row = el('div', 'admin-match-row')
        const resultPill = el('span', `admin-match-result admin-match-result--${m.result.toLowerCase()}`)
        resultPill.textContent = m.result
        row.appendChild(resultPill)
        row.appendChild(el('div', 'admin-match-vs', `vs ${m.opponent ?? 'unknown'}`))
        row.appendChild(el('div', 'muted', `${m.format} · ${m.stake} USDT`))
        row.appendChild(
          el('div', 'muted', m.finishedAt ? new Date(m.finishedAt).toISOString().slice(0, 16).replace('T', ' ') : '—')
        )
        list.appendChild(row)
      }
      cell.appendChild(list)
      toggle.onclick = () => {
        if (!matchRow) return
        matchRow.style.display = matchRow.style.display === 'none' ? '' : 'none'
      }
      matchCell.appendChild(toggle)
    } else {
      matchCell.appendChild(el('div', 'muted', 'no games'))
    }

    const statusCell = tr.insertCell()
    statusCell.appendChild(el('div', undefined, item.status))
    if (item.status === 'APPROVED' && item.deducted !== null && item.deducted !== undefined) {
      statusCell.appendChild(el('div', 'muted', `${Number(item.deducted)} USDT deducted`))
    }
    if (item.status === 'REJECTED' && item.rejectReason) {
      statusCell.appendChild(el('div', 'muted', item.rejectReason))
    }

    tr.insertCell().appendChild(
      el('div', 'muted', new Date(item.createdAt).toISOString().slice(0, 19).replace('T', ' '))
    )

    const actionsCell = tr.insertCell()
    const actionRow = el('div', 'admin-adjust')
    if (item.status === 'PENDING') {
      const approve = el('button', '', 'Approve') as HTMLButtonElement
      approve.onclick = () => {
        if (
          !confirm(
            `Approve the ${Number(item.amount)} ${item.currency} payout to ${item.user.username}?\n\n` +
              `This deducts the balance now. Only approve after sending the USDT.`
          )
        )
          return
        void api<{ deducted: number }>(`/admin/withdrawals/${item.id}/approve`, { method: 'POST', body: {} })
          .then((result) => {
            ctx.toast(`${item.user.username} paid out · ${result.deducted} USDT deducted`)
            void loadTab(ctx)
          })
          .catch((error) => ctx.toast(error.message, 'error'))
      }
      const reject = el('button', '', 'Reject') as HTMLButtonElement
      reject.onclick = () => {
        const reason = prompt('Reject reason (optional)') ?? ''
        void api<{ id: string }>(`/admin/withdrawals/${item.id}/reject`, {
          method: 'POST',
          body: reason.trim() ? { reason: reason.trim().slice(0, 200) } : {}
        })
          .then(() => {
            ctx.toast(`Withdrawal ${item.id.slice(0, 8)} rejected`)
            void loadTab(ctx)
          })
          .catch((error) => ctx.toast(error.message, 'error'))
      }
      actionRow.append(approve, reject)
    } else {
      actionRow.appendChild(el('div', 'muted', item.reviewedBy ? `by ${item.reviewedBy.username}` : '—'))
    }
    actionsCell.appendChild(actionRow)
  }
  wrap.appendChild(table)
  return wrap
}

async function matchesView(ctx: TabContext): Promise<HTMLElement> {
  const matches = await api<AdminMatch[]>('/admin/matches')
  const wrap = el('div')
  const table = el('table', 'admin-table') as HTMLTableElement
  const thead = table.createTHead()
  const headRow = thead.insertRow()
  for (const label of ['Players', 'Format', 'Stake', 'Status', 'Started', 'Winner']) {
    headRow.appendChild(el('th', undefined, label))
  }
  const tbody = table.createTBody()
  for (const match of matches) {
    const tr = tbody.insertRow()
    tr.classList.add('clickable')
    tr.onclick = () => void renderMatchDetail(match, ctx)
    tr.insertCell().appendChild(
      el(
        'div',
        undefined,
        match.players.map((p) => p.user.username).join(' vs ') || '(empty)'
      )
    )
    tr.insertCell().appendChild(el('div', undefined, `${match.format} · ${match.matchType}`))
    tr.insertCell().appendChild(el('div', undefined, String(Number(match.stakePerPlayer))))
    tr.insertCell().appendChild(el('div', undefined, match.status))
    tr.insertCell().appendChild(el('div', 'muted', match.startedAt ? new Date(match.startedAt).toISOString().slice(0, 19).replace('T', ' ') : '-'))
    const winner = match.players.find((p) => p.userId === match.winnerId)?.user.username ?? (match.resultJson ? match.winnerId?.slice(0, 8) : '-')
    tr.insertCell().appendChild(el('div', undefined, winner))
  }
  wrap.appendChild(table)
  return wrap
}

async function renderMatchDetail(match: AdminMatch, ctx: TabContext): Promise<void> {
  const loading = el('div', 'muted', 'Loading replay…')
  ctx.content.replaceChildren(loading)
  try {
    const events = await api<AdminGameEvent[]>('/admin/matches/' + match.id + '/events')
    const detail = el('div')
    const back = el('button', 'ghost', 'Back to matches')
    back.onclick = () => void loadTab(ctx)
    detail.appendChild(back)
    const meta = el('div', 'card admin-match-meta')
    meta.appendChild(el('h3', undefined, `Match ${match.id}`))
    const lines: Array<[string, string]> = [
      ['Players', match.players.map((p) => `${p.user.username} (seat ${p.seat})`).join(', ')],
      ['Status', match.status],
      ['Format', `${match.format} · ${match.matchType}`],
      ['Stake per player', String(Number(match.stakePerPlayer))],
      ['Created', match.createdAt ? new Date(match.createdAt).toISOString() : '-'],
      ['Started', match.startedAt ? new Date(match.startedAt).toISOString() : '-'],
      ['Finished', match.finishedAt ? new Date(match.finishedAt).toISOString() : '-'],
      ['Result', match.resultJson ? JSON.stringify(match.resultJson) : '-']
    ]
    for (const [label, value] of lines) {
      const row = el('div', 'admin-meta-row')
      row.appendChild(el('span', 'admin-meta-label', label))
      row.appendChild(el('span', undefined, value))
      meta.appendChild(row)
    }
    detail.appendChild(meta)
    const replayCard = el('div', 'card')
    replayCard.appendChild(el('h3', undefined, `Replay (${events.length} events)`))
    if (events.length === 0) {
      replayCard.appendChild(el('div', 'muted', 'No events recorded for this match.'))
    } else {
      replayCard.appendChild(renderReplayViewer(events as ReplayEvent[]))
    }
    detail.appendChild(replayCard)
    ctx.content.replaceChildren(detail)
  } catch (error) {
    loading.textContent = (error as Error).message
    ctx.content.replaceChildren(loading)
  }
}

async function settingsView(ctx: TabContext): Promise<HTMLElement> {
  const settings = await api<Record<string, unknown>>('/admin/settings')
  const wrap = el('div')
  const maintenance = settings.maintenanceMode === true
  const modeCard = el('div', 'admin-card admin-mode')
  const modeLabel = el('div', 'admin-mode-label', maintenance ? 'Maintenance mode: ON' : 'Maintenance mode: OFF')
  const modeHint = el('div', 'muted', maintenance ? 'Players cannot log in, join matches, or play.' : 'Players can use the platform normally.')
  const toggle = el('button', 'ghost', maintenance ? 'Turn maintenance OFF' : 'Turn maintenance ON')
  toggle.onclick = () => {
    void api<boolean>('/admin/settings', { method: 'PATCH', body: { key: 'maintenanceMode', value: !maintenance } })
      .then(() => {
        ctx.toast(maintenance ? 'Maintenance disabled' : 'Maintenance enabled')
        void loadTab(ctx)
      })
      .catch((error) => ctx.toast(error.message, 'error'))
  }
  modeCard.append(modeLabel, modeHint, toggle)
  wrap.appendChild(modeCard)
  const table = el('table', 'admin-table') as HTMLTableElement
  const thead = table.createTHead()
  const headRow = thead.insertRow()
  for (const label of ['Key', 'Value (JSON)', '']) {
    headRow.appendChild(el('th', undefined, label))
  }
  const tbody = table.createTBody()
  for (const [key, value] of Object.entries(settings).sort((a, b) => a[0].localeCompare(b[0]))) {
    const tr = tbody.insertRow()
    tr.insertCell().appendChild(el('div', 'admin-key', key))
    const valueInput = el('input') as HTMLInputElement
    valueInput.style.width = '90%'
    valueInput.value = JSON.stringify(value)
    tr.insertCell().appendChild(valueInput)
    const save = el('button', 'ghost', 'Save')
    save.onclick = () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(valueInput.value)
      } catch {
        ctx.toast('Value must be valid JSON', 'error')
        return
      }
      void api<boolean>('/admin/settings', { method: 'PATCH', body: { key, value: parsed } })
        .then(() => {
          ctx.toast(`Saved ${key}`)
          void loadTab(ctx)
        })
        .catch((error) => ctx.toast(error.message, 'error'))
    }
    tr.insertCell().appendChild(save)
  }
  wrap.appendChild(table)
  const addRow = el('div', 'admin-add-setting')
  const keyInput = el('input') as HTMLInputElement
  keyInput.placeholder = 'new key'
  const valueInput = el('input') as HTMLInputElement
  valueInput.style.width = '40%'
  valueInput.placeholder = 'JSON value e.g. {"enabled":true}'
  const add = el('button', undefined, 'Add setting')
  add.onclick = () => {
    if (!keyInput.value.trim()) {
      ctx.toast('Enter a key', 'error')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(valueInput.value || 'null')
    } catch {
      ctx.toast('Value must be valid JSON', 'error')
      return
    }
    void api<boolean>('/admin/settings', { method: 'PATCH', body: { key: keyInput.value.trim(), value: parsed } })
      .then(() => {
        ctx.toast(`Added ${keyInput.value.trim()}`)
        void loadTab(ctx)
      })
      .catch((error) => ctx.toast(error.message, 'error'))
  }
  addRow.append(keyInput, valueInput, add)
  wrap.appendChild(addRow)
  return wrap
}

async function fraudView(): Promise<HTMLElement> {
  const [flags, audit] = await Promise.all([
    api<FraudFlagRow[]>('/admin/fraud'),
    api<LedgerInvariance>('/admin/ledger/invariance')
  ])
  const wrap = el('div')
  const auditCard = el('div', 'admin-card ledger-audit')
  auditCard.appendChild(
    el('div', audit.ok ? 'ledger-ok' : 'ledger-bad', audit.ok ? `Ledger invariant OK (${audit.checked} wallets)` : `Ledger invariant BROKEN (${audit.checked} wallets)`)
  )
  if (!audit.ok) {
    const lines = el('div', 'admin-events')
    for (const violation of audit.violations) {
      const line = el('div', 'replay-event')
      line.appendChild(el('span', 'muted', violation.userId.slice(0, 8)))
      line.appendChild(el('span', 'ledger-bad', `delta ${violation.delta}`))
      line.appendChild(el('span', 'muted', `expected ${violation.expected} actual ${violation.actual}`))
      lines.appendChild(line)
    }
    auditCard.appendChild(lines)
  }
  wrap.appendChild(auditCard)
  const table = el('table', 'admin-table') as HTMLTableElement
  const thead = table.createTHead()
  const headRow = thead.insertRow()
  for (const label of ['Time', 'User', 'Kind', 'Confidence', 'Reason']) {
    headRow.appendChild(el('th', undefined, label))
  }
  const tbody = table.createTBody()
  for (const flag of flags) {
    const tr = tbody.insertRow()
    tr.insertCell().appendChild(el('div', 'muted', new Date(flag.createdAt).toISOString()))
    tr.insertCell().appendChild(el('div', undefined, flag.username ?? flag.userId.slice(0, 8)))
    tr.insertCell().appendChild(el('div', 'admin-key', flag.kind))
    tr.insertCell().appendChild(el('div', 'flag-confidence', `${flag.confidence}%`))
    tr.insertCell().appendChild(el('div', 'muted', flag.reason ?? '-'))
  }
  wrap.appendChild(table)
  return wrap
}

async function auditView(): Promise<HTMLElement> {
  const actions = await api<AdminActionRow[]>('/admin/actions')
  const wrap = el('div')
  const table = el('table', 'admin-table') as HTMLTableElement
  const thead = table.createTHead()
  const headRow = thead.insertRow()
  for (const label of ['Time', 'Admin', 'Action', 'Target', 'Meta']) {
    headRow.appendChild(el('th', undefined, label))
  }
  const tbody = table.createTBody()
  for (const action of actions) {
    const tr = tbody.insertRow()
    tr.insertCell().appendChild(el('div', 'muted', new Date(action.createdAt).toISOString()))
    tr.insertCell().appendChild(el('div', undefined, action.adminUsername ?? action.adminId?.slice(0, 8) ?? '-'))
    tr.insertCell().appendChild(el('div', 'admin-key', action.action))
    tr.insertCell().appendChild(el('div', undefined, `${action.targetType}${action.targetId ? ' · ' + action.targetId.slice(0, 8) : ''}`))
    const metaText = action.meta ? JSON.stringify(action.meta) : ''
    tr.insertCell().appendChild(el('div', 'muted', metaText.length > 160 ? metaText.slice(0, 160) + '…' : metaText))
    tbody.appendChild(tr)
  }
  wrap.appendChild(table)
  return wrap
}