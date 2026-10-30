import { APP_TITLE } from '@snooker/shared'
import { getDeviceId } from './deviceId.js'
import { api, storeToken } from './game/network.js'
import './auth.css'

/**
 * The public sign-in screen.
 *
 * Create an account directly with email + username + password. No email
 * verification or one-time code is required.
 */

type AuthMode = 'login' | 'signup' | 'forgot'

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

const CROWN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 10H5z" fill="currentColor" fill-opacity="0.25"/></svg>'

/** The lobby's wordmark: crown over the name, the last word in red. */
function wordmark(big = false): HTMLElement {
  const mark = el('div', big ? 'ax-wordmark ax-wordmark--big' : 'ax-wordmark')
  const crown = el('span', 'ax-wordmark__crown')
  crown.innerHTML = CROWN_SVG
  const word = el('span', 'ax-wordmark__word')
  const space = APP_TITLE.lastIndexOf(' ')
  if (space > 0) {
    word.append(document.createTextNode(APP_TITLE.slice(0, space + 1)), el('span', 'ax-wordmark__x', APP_TITLE.slice(space + 1)))
  } else {
    word.textContent = APP_TITLE
  }
  mark.append(crown, word)
  mark.setAttribute('role', 'heading')
  mark.setAttribute('aria-level', '1')
  mark.setAttribute('aria-label', APP_TITLE)
  return mark
}

/** The picture side of the screen: the lobby's hero shot with the name over it. */
function heroPanel(): HTMLElement {
  const hero = el('div', 'ax-hero')
  const img = document.createElement('img')
  img.className = 'ax-hero__img'
  img.src = '/lobby/hero.webp'
  img.alt = ''
  img.decoding = 'async'
  hero.append(img, el('div', 'ax-hero__shade'))
  const body = el('div', 'ax-hero__body')
  body.appendChild(wordmark(true))
  body.appendChild(el('p', 'ax-hero__tagline', 'Real players. Real stakes.'))
  const perks = el('ul', 'ax-hero__perks')
  for (const text of ['Live 1v1 matches', 'Tournaments', 'Practice vs the bot']) {
    perks.appendChild(el('li', '', text))
  }
  body.appendChild(perks)
  hero.appendChild(body)
  return hero
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

let fieldSeq = 0

const EYE_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
const EYE_SHUT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>'

function inputGroup(labelText: string, input: HTMLInputElement, extra?: HTMLElement): HTMLElement {
  const group = el('div', 'auth-input-group')
  const label = document.createElement('label')
  label.textContent = labelText
  input.id ||= `auth-field-${++fieldSeq}`
  label.htmlFor = input.id
  group.appendChild(label)
  if (input.type === 'password') {
    const wrap = el('div', 'ax-secret-wrap')
    const eye = document.createElement('button')
    eye.type = 'button'
    eye.className = 'ax-eye'
    eye.setAttribute('aria-label', 'Show password')
    eye.innerHTML = EYE_OPEN
    eye.addEventListener('click', () => {
      const show = input.type === 'password'
      input.type = show ? 'text' : 'password'
      eye.innerHTML = show ? EYE_SHUT : EYE_OPEN
      eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password')
    })
    wrap.append(input, eye)
    group.appendChild(wrap)
  } else {
    group.appendChild(input)
  }
  if (extra) group.appendChild(extra)
  return group
}

/** A date picker for the date of birth ("YYYY-MM-DD"), limited to plausible dates. */
function dateOfBirthInput(): HTMLInputElement {
  const input = textInput('date', undefined, 'bday')
  input.required = true
  input.min = '1900-01-01'
  input.max = new Date().toISOString().slice(0, 10)
  return input
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

/** Puts the cursor in the first field, except on a touch screen, where it would throw the keyboard over the page. */
function focusOnDesktop(input: HTMLInputElement): void {
  if (window.matchMedia('(pointer: fine)').matches) input.focus()
}

function completeSignIn(token: string): void {
  storeToken(token)
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

  const dobInput = dateOfBirthInput()
  form.appendChild(inputGroup('Date of birth (for password recovery)', dobInput))

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
  passwordInput.minLength = 8
  passwordInput.required = true
  form.appendChild(inputGroup('Password', passwordInput))

  const confirmInput = textInput('password', '••••••••', 'new-password')
  confirmInput.required = true
  form.appendChild(inputGroup('Confirm password', confirmInput))

  const submit = primaryButton('CREATE ACCOUNT')
  const switchToLogin = linkButton('Already have an account? Sign in', () => onSwitchMode('login'))
  switchToLogin.classList.add('ax-switch')
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
    if (!dobInput.value) {
      errs.show('Please enter your date of birth.')
      dobInput.focus()
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
    if (password.length < 8) {
      errs.show('Password must be at least 8 characters.')
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
          ref: refInput.value.trim() || undefined,
          dateOfBirth: dobInput.value,
          deviceId: await getDeviceId()
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

  focusOnDesktop(nameInput)
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
  const forgot = linkButton('Forgot your password?', () => onSwitchMode('forgot'))
  const switchToSignup = linkButton('Create an account', () => onSwitchMode('signup'))
  const customerSupport = linkButton('Customer Support', () => {
    alert('Sign in and open Support from the menu to chat with our team. If you cannot sign in, use "Forgot your password?" to reset it first.')
  })
  forgot.classList.add('ax-forgot')
  switchToSignup.classList.add('ax-switch')
  customerSupport.classList.add('ax-support')
  form.append(forgot, submit, el('div', 'auth-footer', ''), switchToSignup, customerSupport)
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
        body: { username: usernameInput.value.trim(), password: passwordInput.value, deviceId: await getDeviceId() }
      })
      completeSignIn(res.token)
    } catch (error: unknown) {
      submit.disabled = false
      submit.textContent = 'SIGN IN'
      const message = error instanceof Error ? error.message : 'Sign in failed'
      errs.show(message === 'invalid credentials' ? 'Wrong username or password.' : message)
      passwordInput.focus()
    }
  })

  focusOnDesktop(usernameInput)
}

function renderForgotForm(
  container: HTMLElement,
  errs: ReturnType<typeof errorSlot>,
  onSwitchMode: (mode: AuthMode) => void
): void {
  const form = document.createElement('form')
  form.className = 'auth-form'
  form.noValidate = true

  const nameInput = textInput('text', 'your full name', 'name')
  nameInput.required = true
  form.appendChild(inputGroup('Full name', nameInput))

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

  const dobInput = dateOfBirthInput()
  form.appendChild(inputGroup('Date of birth', dobInput))

  const verifyBtn = primaryButton('VERIFY DETAILS')
  const back = linkButton('Back to sign in', () => onSwitchMode('login'))
  form.append(verifyBtn, el('div', 'auth-footer', ''), back)
  container.replaceChildren(form)

  verifyBtn.addEventListener('click', async () => {
    if (verifyBtn.disabled) return
    errs.clear()
    const email = emailInput.value.trim()
    const phone = phoneInput.value.trim()
    const username = usernameInput.value.trim()
    const name = nameInput.value.trim()
    const dateOfBirth = dobInput.value
    if (!email || !phone || !username || !name || !dateOfBirth) {
      errs.show('Please fill in every detail.')
      return
    }
    verifyBtn.disabled = true
    verifyBtn.textContent = 'VERIFYING…'
    try {
      const res = await api<{ resetToken: string; username: string }>('/auth/password/forgot', {
        method: 'POST',
        body: { email, phone, username, name, dateOfBirth }
      })
      form.replaceChildren(el('p', 'auth-help', `Reset password for ${res.username}`))
      const newPass = textInput('password', 'New password', 'new-password')
      newPass.required = true
      form.appendChild(inputGroup('New Password', newPass))
      const resetBtn = primaryButton('RESET PASSWORD')
      const back2 = linkButton('Back to sign in', () => onSwitchMode('login'))
      form.append(resetBtn, el('div', 'auth-footer', ''), back2)
      resetBtn.addEventListener('click', async () => {
        if (resetBtn.disabled) return
        errs.clear()
        if ((newPass.value || '').length < 8) {
          errs.show('Password must be at least 8 characters.')
          return
        }
        resetBtn.disabled = true
        resetBtn.textContent = 'RESETTING…'
        try {
          await api('/auth/password/reset', {
            method: 'POST',
            body: { resetToken: res.resetToken, password: newPass.value }
          })
          errs.show('Password reset successful. Please sign in.')
          setTimeout(() => onSwitchMode('login'), 1500)
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

const HEADINGS: Record<AuthMode, { title: string; sub: string }> = {
  login: { title: 'Welcome back', sub: 'Sign in to get back to the table.' },
  signup: { title: 'Create your account', sub: 'One account per player. It takes a minute.' },
  forgot: { title: 'Reset your password', sub: 'Enter every detail exactly as on your account.' }
}

function renderAuthTabs(onSwitchMode: (mode: AuthMode) => void): HTMLElement {
  const tabs = el('div', 'auth-tabs')
  tabs.setAttribute('role', 'tablist')
  const modes: { key: AuthMode; label: string }[] = [
    { key: 'login', label: 'Login' },
    { key: 'signup', label: 'Sign Up' }
  ]
  for (const { key, label } of modes) {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'auth-tab'
    tab.dataset.mode = key
    tab.setAttribute('role', 'tab')
    tab.textContent = label
    tab.addEventListener('click', () => onSwitchMode(key))
    tabs.appendChild(tab)
  }
  return tabs
}

function renderAuthCard(root: HTMLElement, errs: ReturnType<typeof errorSlot>, initialMode: AuthMode): void {
  const screen = el('div', 'auth-screen ax-screen')
  screen.appendChild(el('div', 'ax-backdrop'))
  const layout = el('div', 'ax-layout')
  layout.appendChild(heroPanel())

  const card = el('div', 'auth-card ax-card')
  card.appendChild(wordmark())
  const title = el('h2', 'ax-card__title')
  const sub = el('p', 'ax-card__sub')
  card.append(title, sub)
  if (showOfflineNotice) card.appendChild(el('p', 'auth-offline', SERVER_OFFLINE_NOTICE))

  const body = el('div', 'ax-card__body')
  const switchMode = (mode: AuthMode) => {
    screen.dataset.mode = mode
    title.textContent = HEADINGS[mode].title
    sub.textContent = HEADINGS[mode].sub
    for (const tab of card.querySelectorAll<HTMLElement>('.auth-tab')) {
      const on = tab.dataset.mode === mode
      tab.classList.toggle('active', on)
      tab.setAttribute('aria-selected', String(on))
    }
    errs.clear()
    if (mode === 'login') renderLoginForm(body, errs, switchMode)
    else if (mode === 'signup') renderSignupForm(body, errs, switchMode)
    else renderForgotForm(body, errs, switchMode)
  }

  card.appendChild(renderAuthTabs(switchMode))
  card.appendChild(errs.node)
  card.appendChild(body)
  layout.appendChild(card)
  screen.appendChild(layout)
  root.appendChild(screen)

  switchMode(initialMode)
}

const SERVER_OFFLINE_NOTICE = 'Server offline. Check your connection and try again in a moment.'
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
