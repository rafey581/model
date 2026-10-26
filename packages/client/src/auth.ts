import { APP_TITLE } from '@snooker/shared'
import { api } from './game/network.js'
import { armLocalGuestAutostart, clearLocalGuest, markLocalGuest } from './guest.js'

/**
 * The public sign-in screen.
 *
 * Create an account directly with email + username + password. No email
 * verification or one-time code is required.
 */

type AuthMode = 'login' | 'signup' | 'guest'

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

function brandCard(): HTMLElement {
  const brand = el('div', 'auth-brand')
  const logo = el('div', 'auth-logo')
  logo.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#0a0a0f"/><circle cx="12" cy="12" r="7" fill="#c9a84c"/><circle cx="9.5" cy="9.5" r="2.5" fill="#e8c872"/></svg>'
  brand.appendChild(logo)
  brand.appendChild(el('h1', 'auth-title', APP_TITLE))
  brand.appendChild(el('p', 'auth-subtitle', 'Premium Snooker Experience'))
  return brand
}

function errorSlot(): { node: HTMLElement; show: (m: string) => void; clear: () => void } {
  const node = el('div', 'auth-error')
  node.id = 'auth-error'
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

function inputGroup(labelText: string, input: HTMLElement, extra?: HTMLElement): HTMLElement {
  const group = el('div', 'auth-input-group')
  const label = document.createElement('label')
  label.textContent = labelText
  group.appendChild(label)
  group.appendChild(input)
  if (extra) group.appendChild(extra)
  return group
}

function textInput(type: string, placeholder?: string, autocomplete?: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = type
  if (placeholder) input.placeholder = placeholder
  if (autocomplete !== undefined) (input as any).autocomplete = autocomplete
  return input
}

function primaryButton(text: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'submit'
  btn.className = 'auth-submit'
  btn.textContent = text
  return btn
}

function linkButton(text: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'auth-link'
  btn.textContent = text
  btn.addEventListener('click', onClick)
  return btn
}

function completeSignIn(token: string): void {
  // The rest of the client reads this key on boot. A different name reloads
  // straight back to the sign-in card, because the session was never found.
  clearLocalGuest()
  localStorage.setItem('token', token)
  localStorage.removeItem('snooker_token')
  window.location.reload()
}

function attachUsernameCheck(input: HTMLInputElement, status: HTMLElement, errs: ReturnType<typeof errorSlot>): void {
  let timer: number | undefined
  input.addEventListener('input', () => {
    if (timer) window.clearTimeout(timer)
    errs.clear()
    const value = input.value.trim()
    if (value.length < 3) {
      status.textContent = ''
      status.classList.remove('bad', 'good')
      return
    }
    status.textContent = 'Checking…'
    status.classList.remove('bad', 'good')
    timer = window.setTimeout(() => {
      api<{ available: boolean; message?: string }>(`/auth/username/check?username=${encodeURIComponent(value)}`)
        .then((r) => {
          status.textContent = r.available ? `${value} is free` : (r.message ?? 'Unavailable')
          status.classList.toggle('bad', !r.available)
          status.classList.toggle('good', r.available)
        })
        .catch(() => {})
    }, 300)
  })
}

function renderSignupForm(
  container: HTMLElement,
  errs: ReturnType<typeof errorSlot>,
  onSwitchMode: (mode: AuthMode) => void
): void {
  const form = document.createElement('form')
  form.className = 'auth-form'
  form.noValidate = true

  const nameInput = textInput('text', 'e.g. Alex Morgan', 'name')
  nameInput.required = true
  form.appendChild(inputGroup('Full name', nameInput))

  const usernameInput = textInput('text', 'e.g. cue_king', 'off')
  usernameInput.maxLength = 24
  usernameInput.setAttribute('autocapitalize', 'off')
  usernameInput.setAttribute('spellcheck', 'false')
  usernameInput.required = true
  const usernameStatus = el('div', 'auth-field-status')
  usernameStatus.setAttribute('role', 'status')
  usernameStatus.setAttribute('aria-live', 'polite')
  form.appendChild(inputGroup('Username', usernameInput, usernameStatus))
  attachUsernameCheck(usernameInput, usernameStatus, errs)

  const emailInput = textInput('email', 'you@example.com', 'email')
  emailInput.required = true
  form.appendChild(inputGroup('Email (game login)', emailInput))

  const phoneInput = textInput('tel', '+1234567890', 'tel')
  phoneInput.required = true
  form.appendChild(inputGroup('Phone number (for password recovery)', phoneInput))

  const refFromLink = new URLSearchParams(window.location.search).get('ref')?.trim() ?? ''
  const refInput = textInput('text', 'optional — from a friend', 'off')
  refInput.maxLength = 32
  refInput.value = refFromLink
  refInput.setAttribute('autocapitalize', 'characters')
  refInput.setAttribute('spellcheck', 'false')
  form.appendChild(inputGroup('Invite code (optional)', refInput))

  const passwordInput = textInput('password', '••••••••', 'new-password')
  passwordInput.minLength = 6
  passwordInput.required = true
  form.appendChild(inputGroup('Password', passwordInput))

  const confirmInput = textInput('password', '••••••••', 'new-password')
  confirmInput.required = true
  form.appendChild(inputGroup('Confirm password', confirmInput))

  const submit = primaryButton('CREATE ACCOUNT')
  const switchToLogin = linkButton('Already have an account? Sign in', () => onSwitchMode('login'))
  form.append(submit, el('div', 'auth-footer', ''), switchToLogin)
  container.replaceChildren(form)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (submit.disabled) return
    const name = nameInput.value.trim()
    const username = usernameInput.value.trim()
    const email = emailInput.value.trim()
    const phone = phoneInput.value.trim()
    const password = passwordInput.value
    const confirm = confirmInput.value

    if (password !== confirm) {
      errs.show('Passwords do not match.')
      confirmInput.focus()
      return
    }
    if (name.length < 2) {
      errs.show('Please enter your name.')
      nameInput.focus()
      return
    }
    if (username.length < 3) {
      errs.show('Username must be at least 3 characters.')
      usernameInput.focus()
      return
    }
    if (!email) {
      errs.show('Please enter your email address.')
      emailInput.focus()
      return
    }
    if (!phone || phone.replace(/[^+0-9]/g, '').length < 7) {
      errs.show('Please enter a valid phone number for password recovery.')
      phoneInput.focus()
      return
    }
    if (password.length < 6) {
      errs.show('Password must be at least 6 characters.')
      passwordInput.focus()
      return
    }

    errs.clear()
    submit.disabled = true
    submit.textContent = 'CREATING ACCOUNT…'
    try {
      const res = await api<{ user: AuthUserShape; token: string }>('/auth/signup', {
        method: 'POST',
        body: {
          name,
          username,
          email,
          phone,
          password,
          ref: refInput.value.trim() || undefined
        }
      })
      completeSignIn(res.token)
    } catch (error: unknown) {
      submit.disabled = false
      submit.textContent = 'CREATE ACCOUNT'
      errs.show(error instanceof Error ? error.message : 'Could not create account.')
      usernameInput.focus()
    }
  })

  nameInput.focus()
}

function renderLoginForm(
  container: HTMLElement,
  errs: ReturnType<typeof errorSlot>,
  onSwitchMode: (mode: AuthMode) => void
): void {
  const form = document.createElement('form')
  form.className = 'auth-form'
  form.noValidate = true

  const usernameInput = textInput('text', 'your username', 'username')
  usernameInput.setAttribute('autocapitalize', 'off')
  usernameInput.setAttribute('spellcheck', 'false')
  usernameInput.required = true
  form.appendChild(inputGroup('Username', usernameInput))

  const passwordInput = textInput('password', '••••••••', 'current-password')
  passwordInput.required = true
  form.appendChild(inputGroup('Password', passwordInput))

  const submit = primaryButton('SIGN IN')
  const forgot = linkButton('Forgot your password?', () => renderForgotForm(container, errs))
  const switchToSignup = linkButton('Create an account', () => onSwitchMode('signup'))
  const customerSupport = linkButton('Customer Support', () => {
    alert('For customer support, please email support via the game or contact admin.')
  })
  form.append(submit, el('div', 'auth-footer', ''), forgot, switchToSignup, customerSupport)
  container.replaceChildren(form)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (submit.disabled) return
    errs.clear()
    submit.disabled = true
    submit.textContent = 'SIGNING IN…'
    try {
      const res = await api<{ user: AuthUserShape; token: string }>('/auth/login', {
        method: 'POST',
        body: { username: usernameInput.value.trim(), password: passwordInput.value }
      })
      completeSignIn(res.token)
    } catch (error: unknown) {
      submit.disabled = false
      submit.textContent = 'SIGN IN'
      errs.show(error instanceof Error ? error.message : 'Sign in failed')
      passwordInput.focus()
    }
  })

  usernameInput.focus()
}

function renderForgotForm(container: HTMLElement, errs: ReturnType<typeof errorSlot>): void {
  const form = document.createElement('form')
  form.className = 'auth-form'
  form.noValidate = true

  form.appendChild(el('p', 'auth-help', 'Verify your account details to reset password.'))

  const emailInput = textInput('email', 'you@example.com', 'email')
  emailInput.required = true
  form.appendChild(inputGroup('Email', emailInput))

  const phoneInput = textInput('tel', '+1234567890', 'tel')
  phoneInput.required = true
  form.appendChild(inputGroup('Phone number', phoneInput))

  const usernameInput = textInput('text', 'your username', 'username')
  usernameInput.setAttribute('autocapitalize', 'off')
  usernameInput.setAttribute('spellcheck', 'false')
  usernameInput.required = true
  form.appendChild(inputGroup('Username', usernameInput))

  const verifyBtn = primaryButton('VERIFY DETAILS')
  const back = linkButton('Back to sign in', () => renderLoginForm(container, errs, () => {}))
  
  form.append(verifyBtn, el('div', 'auth-footer', ''), back)
  container.replaceChildren(form)

  verifyBtn.addEventListener('click', async () => {
    if (verifyBtn.disabled) return
    errs.clear()
    const email = emailInput.value.trim()
    const phone = phoneInput.value.trim()
    const username = usernameInput.value.trim()
    if (!email || !phone || !username) {
      errs.show('Please fill all fields.')
      return
    }
    verifyBtn.disabled = true
    verifyBtn.textContent = 'VERIFYING…'
    try {
      const res = await api<{ userId: string; username: string }>('/auth/password/forgot', {
        method: 'POST',
        body: { email, phone, username }
      })
      form.replaceChildren(el('p', 'auth-help', `Reset password for ${res.username}`))
      const newPass = textInput('password', 'New password', 'new-password')
      newPass.required = true
      form.appendChild(inputGroup('New Password', newPass))
      const resetBtn = primaryButton('RESET PASSWORD')
      const back2 = linkButton('Back to sign in', () => renderLoginForm(container, errs, () => {}))
      form.append(resetBtn, el('div', 'auth-footer', ''), back2)
      resetBtn.addEventListener('click', async () => {
        if (resetBtn.disabled) return
        errs.clear()
        if ((newPass.value || '').length < 6) {
          errs.show('Password must be at least 6 characters.')
          return
        }
        resetBtn.disabled = true
        resetBtn.textContent = 'RESETTING…'
        try {
          await api('/auth/password/reset', {
            method: 'POST',
            body: { userId: res.userId, password: newPass.value }
          })
          errs.show('Password reset successful. Please sign in.')
          setTimeout(() => renderLoginForm(container, errs, () => {}), 1500)
        } catch (error: unknown) {
          resetBtn.disabled = false
          resetBtn.textContent = 'RESET PASSWORD'
          errs.show(error instanceof Error ? error.message : 'Reset failed')
        }
      })
    } catch (error: unknown) {
      verifyBtn.disabled = false
      verifyBtn.textContent = 'VERIFY DETAILS'
      errs.show(error instanceof Error ? error.message : 'Verification failed')
    }
  })
}

function renderGuestMode(
  container: HTMLElement,
  errs: ReturnType<typeof errorSlot>,
  onSwitchMode: (mode: AuthMode) => void
): void {
  const note = el('p', 'auth-subtitle', 'Play a free frame against the robot. No account and no stake.')
  const button = primaryButton('CONTINUE AS GUEST')
  button.type = 'button'
  button.addEventListener('click', () => {
    errs.clear()
    button.disabled = true
    button.textContent = 'STARTING…'
    // No /auth/guest call. On a phone the native HTTP stack ignores AbortSignal, so
    // that POST never settles and this label stays up. Local practice needs nothing
    // from the server.
    markLocalGuest()
    try {
      localStorage.removeItem('token')
      localStorage.removeItem('snooker_token')
    } catch {
      // Storage can be blocked. The in-memory flag still covers this page.
    }
    armLocalGuestAutostart()
    window.location.reload()
  })
  const switchToLogin = linkButton('Sign in or create an account', () => onSwitchMode('login'))
  container.replaceChildren(note, button, el('div', 'auth-footer'), switchToLogin)
}

function renderAuthTabs(
  container: HTMLElement,
  activeMode: AuthMode,
  onSwitchMode: (mode: AuthMode) => void
): HTMLElement {
  const tabs = el('div', 'auth-tabs')
  const modes: { key: AuthMode; label: string }[] = [
    { key: 'login', label: 'Login' },
    { key: 'signup', label: 'Sign Up' },
    { key: 'guest', label: 'Guest' }
  ]
  for (const { key, label } of modes) {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = `auth-tab${key === activeMode ? ' active' : ''}`
    tab.textContent = label
    tab.addEventListener('click', () => onSwitchMode(key))
    tabs.appendChild(tab)
  }
  return tabs
}

function renderAuthCard(root: HTMLElement, errs: ReturnType<typeof errorSlot>, initialMode: AuthMode): void {
  const screen = el('div', 'auth-screen')
  const card = el('div', 'auth-card')
  card.appendChild(brandCard())
  if (showOfflineNotice) card.appendChild(el('p', 'auth-offline', SERVER_OFFLINE_NOTICE))
  card.appendChild(errs.node)

  const body = el('div')
  let currentMode: AuthMode = initialMode

  const switchMode = (mode: AuthMode) => {
    currentMode = mode
    const tabs = card.querySelector('.auth-tabs')
    if (tabs) {
      for (const tab of tabs.querySelectorAll('.auth-tab')) {
        tab.classList.toggle('active', tab.textContent?.toLowerCase().replace(' ', '') === mode)
      }
    }
    errs.clear()
    if (mode === 'login') {
      renderLoginForm(body, errs, switchMode)
    } else if (mode === 'signup') {
      renderSignupForm(body, errs, switchMode)
    } else if (mode === 'guest') {
      renderGuestMode(body, errs, switchMode)
    }
  }

  card.appendChild(renderAuthTabs(card, currentMode, switchMode))
  card.appendChild(body)
  screen.appendChild(card)
  root.appendChild(screen)

  switchMode(currentMode)
}

const SERVER_OFFLINE_NOTICE = 'Server offline – Guest practice available'
let showOfflineNotice = false

export function setAuthOfflineNotice(on: boolean): void {
  showOfflineNotice = on
}

export function renderAuthScreen(
  root: HTMLElement,
  _app: HTMLElement,
  _notify: (message: string, kind?: 'info' | 'error') => void
): void {
  const errs = errorSlot()
  renderAuthCard(root, errs, 'login')
}
