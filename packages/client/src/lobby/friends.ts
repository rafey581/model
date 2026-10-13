import { FRIENDS_COPY } from './content.js'
import { accentHeadline, el } from './dom.js'
import { ICONS } from './icons.js'
import { api } from '../game/network.js'

/**
 * The friends screen: search any player by their unique username, send a
 * friend request, and answer the requests others sent you. The screen owns its
 * own data loading so a search result survives refreshing the request panels.
 */

export interface FriendListRow {
  userId: string
  username: string
  since?: string
  createdAt?: string
}

export interface FriendListData {
  friends: Array<{ userId: string; username: string; since: string }>
  incoming: Array<{ requestId: string; userId: string; username: string; createdAt: string }>
  outgoing: Array<{ requestId: string; userId: string; username: string; createdAt: string }>
}

export interface FriendSearchRow {
  id: string
  username: string
  relation: 'none' | 'pending-out' | 'pending-in' | 'friends'
}

export interface FriendsActions {
  onBack: () => void
  toast: (message: string, kind?: 'error' | 'info') => void
  /** Opens the online setup screen with this friend already chosen as the opponent. */
  onChallenge?: (username: string) => void
}

interface Row {
  id: string
  username: string
  meta?: string
  actions?: HTMLElement[]
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

function emptyNote(text: string): HTMLElement {
  return el('div', 'gl-friends-empty', text)
}

function personRow(row: Row): HTMLElement {
  const item = el('div', 'gl-friends-person')
  const info = el('div', 'gl-friends-person-info')
  info.appendChild(el('div', 'gl-friends-person-name', row.username))
  if (row.meta) info.appendChild(el('div', 'gl-friends-person-meta', row.meta))
  item.appendChild(info)
  if (row.actions && row.actions.length > 0) {
    const actions = el('div', 'gl-friends-person-actions')
    for (const action of row.actions) actions.appendChild(action)
    item.appendChild(actions)
  }
  return item
}

function smallButton(label: string, variant: string, onClick: () => void): HTMLButtonElement {
  const btn = el('button', `gl-friends-btn gl-friends-btn--${variant}`) as HTMLButtonElement
  btn.type = 'button'
  btn.textContent = label
  btn.onclick = onClick
  return btn
}

export function renderFriends(actions: FriendsActions): HTMLElement {
  const { onChallenge } = actions
  const screen = el('div', 'gl-screen')
  screen.dataset.view = 'friends'

  const top = el('div', 'gl-home-head')
  top.append(backButton(FRIENDS_COPY.back, actions.onBack))
  const head = el('div', 'gl-deposit-head')
  head.append(el('div', 'gl-label', FRIENDS_COPY.eyebrow), accentHeadline(FRIENDS_COPY.headline, 2))
  top.appendChild(head)
  screen.appendChild(top)

  const view = el('div', 'gl-friends')

  // ── Left: search + results ────────────────────────────────────────────────
  const searchPanel = el('div', 'gl-panel gl-friends-panel')
  searchPanel.appendChild(el('div', 'gl-deposit-label', FRIENDS_COPY.searchLabel))
  searchPanel.appendChild(el('p', 'gl-deposit-intro', FRIENDS_COPY.searchHint))

  const searchRow = el('div', 'gl-friends-search')
  const input = el('input', 'gl-deposit-input') as HTMLInputElement
  input.type = 'text'
  input.placeholder = FRIENDS_COPY.searchPlaceholder
  input.maxLength = 24
  input.autocomplete = 'off'
  const searchBtn = el('button', 'gl-friends-submit') as HTMLButtonElement
  searchBtn.type = 'button'
  searchBtn.textContent = FRIENDS_COPY.search
  searchRow.append(input, searchBtn)
  searchPanel.appendChild(searchRow)

  const addTo = (username: string): void => {
    void api<{ ok: boolean }>('/friends/requests', { method: 'POST', body: { username } })
      .then(() => {
        actions.toast(FRIENDS_COPY.added)
        void runSearch()
        void refresh()
      })
      .catch((error: unknown) => actions.toast((error as Error).message, 'error'))
  }

  const results = el('div', 'gl-friends-results')
  const renderResults = (rows: FriendSearchRow[]): void => {
    results.textContent = ''
    if (rows.length === 0) {
      results.appendChild(emptyNote(FRIENDS_COPY.noResults))
      return
    }
    for (const row of rows) {
      if (row.relation === 'none') {
        results.appendChild(
          personRow({
            id: row.id,
            username: row.username,
            actions: [
              smallButton(FRIENDS_COPY.addFriend, 'primary', () => addTo(row.username))
            ]
          })
        )
      } else if (row.relation === 'pending-out') {
        results.appendChild(personRow({ id: row.id, username: row.username, meta: FRIENDS_COPY.requestSent }))
      } else if (row.relation === 'pending-in') {
        results.appendChild(personRow({ id: row.id, username: row.username, meta: FRIENDS_COPY.theyAskedYou }))
      } else {
        results.appendChild(personRow({ id: row.id, username: row.username, meta: FRIENDS_COPY.alreadyFriends }))
      }
    }
  }

  const runSearch = async (): Promise<void> => {
    const q = input.value.trim()
    if (!q) return
    searchBtn.disabled = true
    searchBtn.textContent = FRIENDS_COPY.searching
    try {
      const rows = await api<FriendSearchRow[]>(`/friends/search?q=${encodeURIComponent(q)}`)
      renderResults(rows)
    } catch (error) {
      actions.toast((error as Error).message, 'error')
      results.textContent = ''
    } finally {
      searchBtn.disabled = false
      searchBtn.textContent = FRIENDS_COPY.search
    }
  }
  searchBtn.onclick = () => void runSearch()
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void runSearch()
  })
  searchPanel.appendChild(results)
  view.appendChild(searchPanel)

  // ── Right: incoming/outgoing requests + friends ───────────────────────────
  const right = el('div', 'gl-friends-right')

  const requestsPanel = el('div', 'gl-panel gl-friends-panel')
  requestsPanel.appendChild(el('div', 'gl-deposit-label', FRIENDS_COPY.requestsTitle))

  const incomingBox = el('div', 'gl-friends-section')
  incomingBox.appendChild(el('div', 'gl-friends-section-title', FRIENDS_COPY.incomingTitle))
  const incomingList = el('div', 'gl-friends-list')
  incomingBox.appendChild(incomingList)

  const outgoingBox = el('div', 'gl-friends-section')
  outgoingBox.appendChild(el('div', 'gl-friends-section-title', FRIENDS_COPY.outgoingTitle))
  const outgoingList = el('div', 'gl-friends-list')
  outgoingBox.appendChild(outgoingList)

  requestsPanel.append(incomingBox, outgoingBox)

  const friendsPanel = el('div', 'gl-panel gl-friends-panel')
  friendsPanel.appendChild(el('div', 'gl-deposit-label', FRIENDS_COPY.friendsTitle))
  const friendsList = el('div', 'gl-friends-list')
  friendsPanel.appendChild(friendsList)

  right.append(requestsPanel, friendsPanel)
  view.appendChild(right)
  screen.appendChild(view)

  // ── Data ──────────────────────────────────────────────────────────────────
  const refresh = async (): Promise<void> => {
    try {
      const data = await api<FriendListData>('/friends')

      incomingList.textContent = ''
      if (data.incoming.length === 0) {
        incomingList.appendChild(emptyNote(FRIENDS_COPY.incomingEmpty))
      } else {
        for (const req of data.incoming) {
          incomingList.appendChild(
            personRow({
              id: req.requestId,
              username: req.username,
              actions: [
                smallButton(FRIENDS_COPY.accept, 'accept', () => answer(req.requestId, 'accept')),
                smallButton(FRIENDS_COPY.decline, 'decline', () => answer(req.requestId, 'reject'))
              ]
            })
          )
        }
      }

      outgoingList.textContent = ''
      if (data.outgoing.length === 0) {
        outgoingList.appendChild(emptyNote(FRIENDS_COPY.outgoingEmpty))
      } else {
        for (const req of data.outgoing) {
          outgoingList.appendChild(
            personRow({ id: req.requestId, username: req.username, meta: FRIENDS_COPY.waiting })
          )
        }
      }

      friendsList.textContent = ''
      if (data.friends.length === 0) {
        friendsList.appendChild(emptyNote(FRIENDS_COPY.friendsEmpty))
      } else {
        for (const friend of data.friends) {
          const rowActions: HTMLElement[] = []
          if (onChallenge) {
            const btn = smallButton(FRIENDS_COPY.challenge, 'primary', () => onChallenge(friend.username))
            btn.title = FRIENDS_COPY.challengeHint
            rowActions.push(btn)
          }
          friendsList.appendChild(
            personRow({
              id: friend.userId,
              username: friend.username,
              meta: FRIENDS_COPY.friendsSince(friend.since),
              actions: rowActions
            })
          )
        }
      }
    } catch (error) {
      actions.toast((error as Error).message, 'error')
    }
  }

  const answer = (requestId: string, action: 'accept' | 'reject'): void => {
    void api<{ ok: boolean }>(`/friends/requests/${requestId}/${action}`, { method: 'POST', body: {} })
      .then(() => {
        actions.toast(action === 'accept' ? FRIENDS_COPY.accepted : FRIENDS_COPY.declined)
        void refresh()
        void runSearch()
      })
      .catch((error: unknown) => actions.toast((error as Error).message, 'error'))
  }

  void refresh()

  return screen
}