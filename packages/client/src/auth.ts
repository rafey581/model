import { api } from './game/network.js'
import { WalletError, connectWallet, signWithWallet } from './wallet.js'

/**
 * The public sign-in screen.
 *
 * Rendered from `/api/auth/providers` rather than a hard-coded list, so the screen
 * shows exactly the options the server will accept. A provider that is switched off
 * simply does not appear - there is no disabled button to explain, and no button
 * that can fail on click.
 *
 * There is deliberately no password field here. Public players authenticate with a
 * provider; email + password survives on the server for the seeded internal
 * accounts, and admins have their own screen at /admin that this file has no link to.
 */

export interface AuthProvider {
  id: string
  label: string
  enabled: boolean
  verifiedEmail: boolean
  unavailableReason?: string
}

export interface AuthUserShape {
  id: string
  username: string
  role: string
  status: string
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Inline marks per provider, so the buttons do not need image assets or a CDN. */
const PROVIDER_MARKS: Record<string, string> = {
  google:
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9z"/><path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3a7.2 7.2 0 0 1-10.7-3.8h-4v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.3 14.3a7.1 7.1 0 0 1 0-4.6v-3.1h-4a12 12 0 0 0 0 10.8l4-3.1z"/><path fill="#EA4335" d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.5-3.5A12 12 0 0 0 1.3 6.6l4 3.1A7.2 7.2 0 0 1 12 4.8z"/></svg>',
  binance:
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#F3BA2F" d="m12 3 3 3-1.5 1.5L12 6 10.5 7.5 9 6l3-3zM6.8 8.2 3 12l3 3 1.5-1.5L4.5 12l3-1.5-1.5-1.5.8-.8zm10.4 0-1.5 1.5 1.5 1.3-1.5 1.5 1.5 1.5 3-3-3-3zM12 9.8l2.2 2.2L12 14.2l-2.2-2.2L12 9.8zM6.8 15.8 9 18l3-3 3 3 2.2-2.2-3-3-2.2 2.2-2.2-2.2-3 3z"/></svg>',
  phantom:
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M18.9 2H5.1a2.6 2.6 0 0 0-2.6 2.7l.7 12.1a4 4 0 0 0 4 3.7h1.3l.2-1.8H8.4a1.3 1.3 0 0 1-1.3-1.2L6.6 4.4a.9.9 0 0 1 .9-1h9a.9.9 0 0 1 .9 1l-.5 11a1.3 1.3 0 0 1-1.3 1.2h-.3l.2 1.8h1.3a4 4 0 0 0 4-3.7l.7-12.1A2.6 2.6 0 0 0 18.9 2Zm-.4 5.6-2.6 5.2h-2.1l-1.5-3.4a.6.6 0 0 0-1.1 0l-1.6 3.4H8.4L7 9.4a.6.6 0 0 0-1.2-.1l-1 1.5a.6.6 0 0 0 0 .7l3.2 5.6h1.6l1.6-3.3 1.6 3.3h1.6L18.5 9.5a.6.6 0 0 0 0-.6l-.6-.6a.6.6 0 0 0-.8.3Z"/></svg>'
}

/**
 * What a provider hands over, in the player's words.
 *
 * Consent has to be informed to be meaningful, and a bare "Continue with Google"
 * tells the person nothing about what they are agreeing to. The server lists the
 * raw field names in `provides`; this is the same list phrased for a human, keyed
 * off the provider id so the two cannot silently disagree about which provider is
 * being described.
 */
const DISCLOSURE: Record<string, string> = {
  google: 'Google shares your email address, profile name and profile photo.',
  phantom: 'Phantom shares only your Solana wallet address. No email, no name, no photo.',
  binance: 'Binance shares your account email and display name.'
}

/**
 * One provider's button, with what it shares written underneath.
 *
 * Returns the wrapper rather than the bare button because the disclosure has to sit
 * with the button it describes - it is part of consenting to that button, not a
 * footnote to the screen.
 */
function providerButton(provider: AuthProvider, onClick: () => void): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `auth-provider auth-provider-${provider.id}`
  const mark = document.createElement('span')
  mark.className = 'auth-provider-mark'
  mark.innerHTML = PROVIDER_MARKS[provider.id] ?? PROVIDER_MARKS.google!
  const label = document.createElement('span')
  label.textContent = provider.label
  button.append(mark, label)
  button.addEventListener('click', onClick)

  const wrap = el('div', 'auth-provider-wrap')
  wrap.appendChild(button)

  // Shown without being clicked, because a disclosure behind a link is a disclosure
  // nobody reads. A wallet that shares only an address deserves saying plainly.
  const text = DISCLOSURE[provider.id]
  if (text) {
    wrap.appendChild(el('p', 'auth-provider-disclosure', text))
  }
  return wrap
}

function brandCard(): HTMLElement {
  const brand = el('div', 'auth-brand')
  const logo = el('div', 'auth-logo')
  logo.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#0a0a0f"/><circle cx="12" cy="12" r="7" fill="#c9a84c"/><circle cx="9.5" cy="9.5" r="2.5" fill="#e8c872"/></svg>'
  brand.appendChild(logo)
  brand.appendChild(el('h1', 'auth-title', 'Snooker Arena'))
  brand.appendChild(el('p', 'auth-subtitle', 'Premium Snooker Experience'))
  return brand
}

function errorSlot(): { node: HTMLElement; show: (m: string) => void; clear: () => void } {
  const node = el('div', 'auth-error')
  node.id = 'auth-error'
  // Assertive, because these are answers to a deliberate action rather than
  // background state changes - the player asked to sign in and needs to be told.
  node.setAttribute('role', 'alert')
  node.setAttribute('aria-live', 'assertive')
  return {
    node,
    show: (m: string) => {
      node.textContent = m
      node.classList.add('visible')
    },
    clear: () => {
      node.textContent = ''
      node.classList.remove('visible')
    }
  }
}

/**
 * The first-sign-in username step.
 *
 * Reached only after Google has already verified the person, so the screen can
 * state that the account exists and this is just naming it. The availability check
 * is advisory - the server re-validates on submit, and a 409 re-renders the picker
 * with the name it clashed on rather than dumping the player back at the start.
 */
function renderUsernamePicker(
  container: HTMLElement,
  pendingToken: string,
  suggested: string,
  onBack: () => void
): void {
  const screen = el('div', 'auth-screen')
  const card = el('div', 'auth-card')
  card.appendChild(brandCard())

  const errs = errorSlot()
  card.appendChild(errs.node)

  const form = document.createElement('form')
  form.className = 'auth-form'
  form.noValidate = true

  const group = el('div', 'auth-input-group')
  const label = document.createElement('label')
  label.htmlFor = 'auth-username'
  label.textContent = 'Choose your username'
  const input = document.createElement('input')
  input.id = 'auth-username'
  input.name = 'auth-username'
  input.type = 'text'
  input.placeholder = 'e.g. cue_king'
  input.value = suggested
  input.maxLength = 24
  input.autocomplete = 'off'
  input.setAttribute('autocapitalize', 'off')
  input.setAttribute('spellcheck', 'false')
  // Announced politely as the check resolves; the assertive slot is for the
  // failures, which are the part the player has to act on.
  const status = el('div', 'auth-field-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  group.append(label, input, status)
  form.appendChild(group)

  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'auth-submit'
  submit.textContent = 'CLAIM USERNAME'

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'auth-link'
  cancel.textContent = 'Use a different account'
  cancel.addEventListener('click', onBack)

  form.append(submit, cancel)
  card.appendChild(form)
  card.appendChild(el('p', 'auth-hint', '3–24 characters · letters, numbers and underscores · case does not matter'))
  screen.appendChild(card)
  // Built offscreen and attached in one go, so the first paint is the finished card
  // rather than a frame with a gap where it is going to be.
  container.replaceChildren(screen)

  // Debounced availability check. A request per keystroke would be both wasteful
  // and a way to enumerate other players' usernames.
  let checkTimer: number | undefined
  input.addEventListener('input', () => {
    errs.clear()
    window.clearTimeout(checkTimer)
    status.textContent = ''
    const value = input.value.trim()
    if (value.length < 3) {
      status.textContent = 'At least 3 characters.'
      return
    }
    checkTimer = window.setTimeout(() => {
      void api<{ available: boolean; message?: string }>(`/auth/username/check?username=${encodeURIComponent(value)}`)
        .then((r) => {
          if (input.value.trim() !== value) return
          status.textContent = r.available ? `${value} is free` : (r.message ?? 'Unavailable')
          status.classList.toggle('bad', !r.available)
          status.classList.toggle('good', r.available)
        })
        .catch(() => {
          // A failed check is not a failure; the submit will find out.
        })
    }, 300)
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (submit.disabled) return
    const chosen = input.value.trim()
    if (chosen.length < 3) {
      errs.show('Pick a username of at least 3 characters.')
      return
    }
    errs.clear()
    submit.disabled = true
    submit.textContent = 'ONE MOMENT…'
    void api<{ user: AuthUserShape; token: string }>('/auth/complete', {
      method: 'POST',
      body: { pendingToken, username: chosen }
    })
      .then((data) => {
        localStorage.setItem('token', data.token)
        // replace, not assign, so Back does not return to a spent pending token.
        window.location.replace('/')
      })
      .catch((error: Error) => {
        submit.disabled = false
        submit.textContent = 'CLAIM USERNAME'
        errs.show(error.message)
        input.focus()
      })
  })

  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}

/**
 * The whole Phantom sign-in, driven from one click.
 *
 * Three steps, in this order, and the order matters:
 *
 *  1. Ask the wallet which account to use. It prompts; we do not choose.
 *  2. Ask the server for a message *naming that address*, and sign exactly what it
 *     hands back. We never build the message here - a client that assembled its own
 *     would be verifying a different string from the one it signed.
 *  3. Send the signature back. A known wallet signs straight in; a new one comes
 *     back with a pending token and drops into the same username picker Google uses.
 *
 * Nothing is stored in `localStorage` from step 1 - the address is re-derived from
 * the wallet each time, so a stale cached address cannot be used as an identity.
 */
async function startPhantomSignIn(
  container: HTMLElement,
  errs: ReturnType<typeof errorSlot>
): Promise<void> {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
  // Progress goes in its own live region rather than by rewriting the button text.
  // Replacing a button's contents would throw away the provider icon mid-flow and
  // leave it broken when the flow is cancelled.
  const status = el('div', 'auth-field-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  container.appendChild(status)
  const step = (label: string) => {
    status.textContent = label
  }
  buttons.forEach((b) => {
    b.disabled = true
  })

  try {
    step('Waiting for your wallet…')
    const { address } = await connectWallet()

    step('Preparing a sign-in request…')
    const challenge = await api<{ address: string; message: string; challenge: string }>(
      '/auth/phantom/challenge',
      { method: 'POST', body: { address } }
    )
    // The server echoes the address it bound the challenge to. If it does not match
    // what the wallet told us, something rewrote the request in flight and we stop.
    if (challenge.address !== address) {
      throw new WalletError('The wallet address did not match the server response. Please try again.')
    }

    step('Confirm the signature in your wallet…')
    const signature = await signWithWallet(challenge.message, address)

    const result = await api<{
      user?: { username: string }
      token?: string
      created?: boolean
      pendingToken?: string
      suggestedUsername?: string
    }>('/auth/phantom/verify', { method: 'POST', body: { challenge: challenge.challenge, signature } })

    if (result.token && result.user) {
      status.remove()
      localStorage.setItem('token', result.token)
      window.location.replace('/')
      return
    }

    if (result.pendingToken) {
      status.remove()
      container.replaceChildren()
      renderUsernamePicker(container, result.pendingToken, result.suggestedUsername ?? '', () =>
        renderProvidersInto(container, errs)
      )
      return
    }

    throw new WalletError('Sign-in did not complete. Please try again.')
  } catch (error) {
    // A declined prompt is a choice, not a fault. Both are reported the same way,
    // and the buttons are re-enabled either way so the screen is never left dead.
    errs.show(error instanceof Error ? error.message : String(error))
    status.remove()
  } finally {
    buttons.forEach((b) => {
      b.disabled = false
    })
  }
}

/** Re-renders the provider list, used when backing out of the username step. */
function renderProvidersInto(container: HTMLElement, errs: ReturnType<typeof errorSlot>): void {
  void api<{ providers: AuthProvider[] }>('/auth/providers')
    .then(({ providers }) => {
      const next = el('div', 'auth-providers')
      for (const provider of providers) {
        next.appendChild(
          providerButton(provider, () => {
            if (provider.id === 'phantom') {
              void startPhantomSignIn(next, errs)
              return
            }
            window.location.href = `/api/auth/${provider.id}`
          })
        )
      }
      container.replaceChildren(next)
      errs.clear()
    })
    .catch((error: Error) => errs.show(error.message))
}

export function renderAuthScreen(
  root: HTMLElement,
  app: HTMLElement,
  notify: (message: string, kind?: 'info' | 'error') => void
): void {
  const params = new URLSearchParams(window.location.search)

  // The OAuth callback redirects back here with the outcome in the query string.
  // Handle it before anything else so a signed-in player is not shown a login card
  // for a frame while the session is restored.
  const outcome = params.get('auth')

  if (outcome === 'pending') {
    const pendingToken = params.get('t') ?? ''
    const suggested = params.get('u') ?? ''
    if (pendingToken) {
      const screen = el('div', 'auth-screen')
      root.appendChild(screen)
      renderUsernamePicker(screen, pendingToken, suggested, () => {
        window.location.replace('/')
      })
      return
    }
  }

  if (outcome) {
    // Strip the query so a refresh does not replay the outcome, and so a token
    // never lingers in the address bar or in history.
    window.history.replaceState({}, '', '/')
    const messages: Record<string, string> = {
      ok: 'Signed in with Google.',
      cancelled: 'Google sign-in was cancelled.',
      invalid: 'That sign-in link could not be verified. Please try again.',
      failed: 'Google sign-in failed. Please try again.',
      suspended: 'That account is suspended.'
    }
    // Only Google redirects back to this page, so only Google has outcomes here.
    const text = messages[outcome]
    if (text) notify(text, outcome === 'ok' ? 'info' : 'error')
  }

  const screen = el('div', 'auth-screen')
  const card = el('div', 'auth-card')
  card.appendChild(brandCard())

  const errs = errorSlot()
  card.appendChild(errs.node)

  const body = el('div', 'auth-providers')
  screen.appendChild(card)
  root.appendChild(screen)

  void api<{ providers: AuthProvider[] }>('/auth/providers')
    .then(({ providers }) => {
      if (providers.length === 0) {
        // The honest state: nothing is configured, so say that rather than
        // rendering a card with no way in and no explanation.
        const note = el('div', 'auth-empty')
        note.appendChild(el('strong', undefined, 'Sign-in is not available right now'))
        note.appendChild(
          el('p', undefined, 'No identity provider is configured on this server. An operator needs to enable one.')
        )
        body.replaceChildren(note)
        return
      }
      for (const provider of providers) {
        body.appendChild(
          providerButton(provider, () => {
            if (provider.id === 'phantom') {
              // Phantom is not a redirect: the wallet prompt is a JS dialog we have
              // to drive, and the session comes back over fetch rather than a
              // navigation.
              void startPhantomSignIn(body, errs)
              return
            }
            // A full navigation, not fetch: the provider redirects, and the
            // response has to be able to set the session cookie.
            window.location.href = `/api/auth/${provider.id}`
          })
        )
      }
      if (providers.length > 1) {
        body.appendChild(el('p', 'auth-hint', 'Choose a provider to continue.'))
      }
    })
    .catch((error: Error) => {
      errs.show(error.message)
    })
}
