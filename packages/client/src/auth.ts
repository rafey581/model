import { APP_TITLE } from '@snooker/shared'
import { api } from './game/network.js'

/**
 * The public sign-in screen.
 *
 * One way in: a local account. Players sign up with a name, a username, an email
 * address, a WhatsApp number, a date of birth and a password, then prove the address
 * they chose - email or WhatsApp - with a one-time code before the account exists.
 * From then on they sign in with their username and password, and a forgotten
 * password is recovered with another code.
 *
 * There is no provider list and no wallet button: nothing about this screen depends on
 * a third party being configured, so there is no button here that can fail on click.
 */

type AuthMode = 'login' | 'signup' | 'guest'

export interface AuthUserShape {
  id: string
  username: string
  role: string
  status: string
}

interface OtpHandoff {
  challengeId: string
  channel: 'EMAIL' | 'WHATSAPP'
  destination: string
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

/** A labelled input, optionally with a live status line underneath it. */
function inputGroup(
  id: string,
  labelText: string,
  input: HTMLInputElement,
  status?: HTMLElement
): HTMLElement {
  const group = el('div', 'auth-input-group')
  const label = document.createElement('label')
  label.htmlFor = id
  label.textContent = labelText
  input.id = id
  group.append(label, input)
  if (status) group.appendChild(status)
  return group
}

function textInput(type: string, placeholder?: string, autocomplete?: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = type
  if (placeholder) input.placeholder = placeholder
  if (autocomplete) input.setAttribute('autocomplete', autocomplete)
  return input
}

function primaryButton(text: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'submit'
  button.className = 'auth-submit'
  button.textContent = text
  return button
}

function linkButton(text: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'auth-link'
  button.textContent = text
  button.addEventListener('click', onClick)
  return button
}

function completeSignIn(token: string): void {
  localStorage.setItem('token', token)
  // replace, not assign, so Back does not return to a form whose code is already spent.
  window.location.replace('/')
}

/**
 * Debounced username availability check, shared by the signup form and the picker.
 *
 * A request per keystroke would be both wasteful and a way to enumerate other
 * players' usernames. The result is advisory - the server re-validates on submit.
 */
function attachUsernameCheck(input: HTMLInputElement, status: HTMLElement, errs: ReturnType<typeof errorSlot>): void {
  let timer: number | undefined
  input.addEventListener('input', () => {
    errs.clear()
    window.clearTimeout(timer)
    status.textContent = ''
    status.classList.remove('good', 'bad')
    const value = input.value.trim()
    if (value.length < 3) {
      status.textContent = 'At least 3 characters.'
      return
    }
    timer = window.setTimeout(() => {
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
  form.appendChild(inputGroup('auth-signup-name', 'Full name', nameInput))

  const usernameInput = textInput('text', 'e.g. cue_king', 'off')
  usernameInput.maxLength = 24
  usernameInput.setAttribute('autocapitalize', 'off')
  usernameInput.setAttribute('spellcheck', 'false')
  usernameInput.required = true
  // Announced politely as the check resolves; the assertive slot is for the
  // failures, which are the part the player has to act on.
  const usernameStatus = el('div', 'auth-field-status')
  usernameStatus.setAttribute('role', 'status')
  usernameStatus.setAttribute('aria-live', 'polite')
  form.appendChild(inputGroup('auth-signup-username', 'Username', usernameInput, usernameStatus))
  attachUsernameCheck(usernameInput, usernameStatus, errs)

  const emailInput = textInput('email', 'you@example.com', 'email')
  emailInput.required = true
  form.appendChild(inputGroup('auth-signup-email', 'Email', emailInput))

  const phoneInput = textInput('tel', '+44 7700 900000', 'tel')
  phoneInput.required = true
  form.appendChild(inputGroup('auth-signup-phone', 'WhatsApp number', phoneInput))

  const dobInput = textInput('date', undefined, 'bday')
  dobInput.required = true
  form.appendChild(inputGroup('auth-signup-dob', 'Date of birth', dobInput))

  // Which of the two the code goes to. Both addresses are stored either way; this
  // only decides which one is proven now.
  const choiceWrap = el('div', 'auth-input-group')
  const choiceLabel = el('label', undefined, 'Send my verification code to')
  const choiceRow = el('div', 'auth-choice')
  const makeChoice = (value: 'email' | 'whatsapp', text: string, checked: boolean) => {
    const wrap = el('label', 'auth-choice-option')
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'verifyVia'
    radio.value = value
    radio.checked = checked
    wrap.append(radio, el('span', undefined, text))
    return wrap
  }
  choiceRow.append(makeChoice('email', 'Email', true), makeChoice('whatsapp', 'WhatsApp', false))
  choiceWrap.append(choiceLabel, choiceRow)
  form.appendChild(choiceWrap)

  // Invite code: pre-filled when the player arrived through an invite link, and
  // editable so a code passed on by hand can be typed in.
  const refFromLink = new URLSearchParams(window.location.search).get('ref')?.trim() ?? ''
  const refInput = textInput('text', 'optional — from a friend', 'off')
  refInput.maxLength = 32
  refInput.value = refFromLink
  refInput.setAttribute('autocapitalize', 'characters')
  refInput.setAttribute('spellcheck', 'false')
  form.appendChild(inputGroup('auth-signup-ref', 'Invite code (optional)', refInput))

  const passwordInput = textInput('password', '••••••••', 'new-password')
  passwordInput.minLength = 6
  passwordInput.required = true
  form.appendChild(inputGroup('auth-signup-password', 'Password', passwordInput))

  const confirmInput = textInput('password', '••••••••', 'new-password')
  confirmInput.required = true
  form.appendChild(inputGroup('auth-signup-confirm', 'Confirm password', confirmInput))

  const submit = primaryButton('CREATE ACCOUNT')
  const switchToLogin = linkButton('Already have an account? Sign in', () => onSwitchMode('login'))
  const switchToGuest = linkButton('Continue as Guest', () => onSwitchMode('guest'))
  form.append(submit, el('div', 'auth-footer', ''), switchToLogin, switchToGuest)
  container.replaceChildren(form)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (submit.disabled) return
    const name = nameInput.value.trim()
    const username = usernameInput.value.trim()
    const email = emailInput.value.trim()
    const phone = phoneInput.value.trim()
    const dateOfBirth = dobInput.value
    const password = passwordInput.value
    const confirm = confirmInput.value
    const verifyVia = (form.querySelector('input[name="verifyVia"]:checked') as HTMLInputElement | null)?.value ?? 'email'

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
    if (!phone) {
      errs.show('Please enter your WhatsApp number.')
      phoneInput.focus()
      return
    }
    if (!dateOfBirth) {
      errs.show('Please enter your date of birth.')
      dobInput.focus()
      return
    }
    if (password.length < 6) {
      errs.show('Password must be at least 6 characters.')
      passwordInput.focus()
      return
    }

    errs.clear()
    submit.disabled = true
    submit.textContent = 'SENDING CODE…'
    try {
      const handoff = await api<OtpHandoff>('/auth/signup/start', {
        method: 'POST',
        body: {
          name,
          username,
          email,
          phone,
          dateOfBirth,
          password,
          verifyVia,
          ref: refInput.value.trim() || undefined
        }
      })
      renderOtpStep(container, errs, handoff, 'signup', () => onSwitchMode('signup'))
    } catch (error: unknown) {
      submit.disabled = false
      submit.textContent = 'CREATE ACCOUNT'
      errs.show(error instanceof Error ? error.message : 'Could not start signup.')
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
  form.appendChild(inputGroup('auth-login-username', 'Username', usernameInput))

  const passwordInput = textInput('password', '••••••••', 'current-password')
  passwordInput.required = true
  form.appendChild(inputGroup('auth-login-password', 'Password', passwordInput))

  const submit = primaryButton('SIGN IN')
  const forgot = linkButton('Forgot your password?', () => renderForgotForm(container, errs))
  const switchToSignup = linkButton('Create an account', () => onSwitchMode('signup'))
  const switchToGuest = linkButton('Continue as Guest', () => onSwitchMode('guest'))
  form.append(submit, el('div', 'auth-footer', ''), forgot, switchToSignup, switchToGuest)
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

  form.appendChild(
    el('div', 'auth-notice', 'Enter the email address or WhatsApp number on your account and we will send a reset code.')
  )

  const identifierInput = textInput('text', 'you@example.com or +44 7700 900000', 'username')
  identifierInput.required = true
  form.appendChild(inputGroup('auth-forgot-identifier', 'Email or WhatsApp number', identifierInput))

  const submit = primaryButton('SEND RESET CODE')
  const back = linkButton('Back to sign in', () => renderLoginForm(container, errs, () => {}))
  form.append(submit, el('div', 'auth-footer', ''), back)
  container.replaceChildren(form)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (submit.disabled) return
    const identifier = identifierInput.value.trim()
    if (!identifier) {
      errs.show('Please enter your email or WhatsApp number.')
      identifierInput.focus()
      return
    }
    errs.clear()
    submit.disabled = true
    submit.textContent = 'SENDING…'
    try {
      const handoff = await api<OtpHandoff>('/auth/password/forgot', {
        method: 'POST',
        body: { identifier }
      })
      renderOtpStep(container, errs, handoff, 'reset', () => renderLoginForm(container, errs, () => {}))
    } catch (error: unknown) {
      submit.disabled = false
      submit.textContent = 'SEND RESET CODE'
      errs.show(error instanceof Error ? error.message : 'Could not send a reset code.')
      identifierInput.focus()
    }
  })

  identifierInput.focus()
}

const CHANNEL_LABEL: Record<OtpHandoff['channel'], string> = {
  EMAIL: 'email',
  WHATSAPP: 'WhatsApp'
}

/**
 * The code step, shared by signup and password reset.
 *
 * `purpose` decides what the code unlocks: signup just verifies and signs the player in,
 * while reset asks for the new password alongside it. The resend button swaps in the new
 * challenge id the server hands back, because a resend spends the old challenge.
 */
function renderOtpStep(
  container: HTMLElement,
  errs: ReturnType<typeof errorSlot>,
  handoff: OtpHandoff,
  purpose: 'signup' | 'reset',
  onBack: () => void
): void {
  let challengeId = handoff.challengeId

  const form = document.createElement('form')
  form.className = 'auth-form'
  form.noValidate = true

  const notice = el(
    'div',
    'auth-notice',
    `We sent a 6-digit code to ${handoff.destination} on ${CHANNEL_LABEL[handoff.channel]}. It expires in a few minutes.`
  )
  form.appendChild(notice)

  const codeInput = textInput('text', '123456', 'one-time-code')
  codeInput.inputMode = 'numeric'
  codeInput.maxLength = 6
  codeInput.setAttribute('autocomplete', 'one-time-code')
  codeInput.required = true
  form.appendChild(inputGroup('auth-otp-code', 'Verification code', codeInput))

  let passwordInput: HTMLInputElement | undefined
  let confirmInput: HTMLInputElement | undefined
  if (purpose === 'reset') {
    passwordInput = textInput('password', '••••••••', 'new-password')
    passwordInput.minLength = 6
    passwordInput.required = true
    form.appendChild(inputGroup('auth-reset-password', 'New password', passwordInput))

    confirmInput = textInput('password', '••••••••', 'new-password')
    confirmInput.required = true
    form.appendChild(inputGroup('auth-reset-confirm', 'Confirm new password', confirmInput))
  }

  const submit = primaryButton(purpose === 'signup' ? 'VERIFY & CREATE ACCOUNT' : 'RESET PASSWORD')
  const resend = linkButton('Resend code', () => {
    if (resend.disabled) return
    errs.clear()
    resend.disabled = true
    resend.textContent = 'Sending…'
    void api<OtpHandoff>('/auth/otp/resend', { method: 'POST', body: { challengeId } })
      .then((next) => {
        challengeId = next.challengeId
        notice.textContent = `A new code is on its way to ${next.destination} on ${CHANNEL_LABEL[next.channel]}.`
        codeInput.value = ''
        codeInput.focus()
      })
      .catch((error: Error) => errs.show(error.message))
      .finally(() => {
        resend.disabled = false
        resend.textContent = 'Resend code'
      })
  })
  const back = linkButton('Back', onBack)
  form.append(submit, el('div', 'auth-footer', ''), resend, back)
  container.replaceChildren(form)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (submit.disabled) return
    const code = codeInput.value.trim()
    if (code.length < 4) {
      errs.show('Enter the code we sent you.')
      codeInput.focus()
      return
    }
    if (purpose === 'reset') {
      if (passwordInput!.value !== confirmInput!.value) {
        errs.show('Passwords do not match.')
        confirmInput!.focus()
        return
      }
      if (passwordInput!.value.length < 6) {
        errs.show('Password must be at least 6 characters.')
        passwordInput!.focus()
        return
      }
    }
    errs.clear()
    submit.disabled = true
    submit.textContent = purpose === 'signup' ? 'VERIFYING…' : 'RESETTING…'
    try {
      if (purpose === 'signup') {
        const res = await api<{ user: AuthUserShape; token: string }>('/auth/signup/verify', {
          method: 'POST',
          body: { challengeId, code }
        })
        completeSignIn(res.token)
        return
      }
      await api<{ reset: boolean }>('/auth/password/reset', {
        method: 'POST',
        body: { challengeId, code, password: passwordInput!.value }
      })
      errs.clear()
      notifyResetDone(container, errs)
    } catch (error: unknown) {
      submit.disabled = false
      submit.textContent = purpose === 'signup' ? 'VERIFY & CREATE ACCOUNT' : 'RESET PASSWORD'
      errs.show(error instanceof Error ? error.message : 'That code could not be verified.')
      codeInput.focus()
    }
  })

  codeInput.focus()
}

/** The small success state after a reset, with a way straight back to sign-in. */
function notifyResetDone(container: HTMLElement, errs: ReturnType<typeof errorSlot>): void {
  const panel = el('div', 'auth-form')
  panel.appendChild(el('div', 'auth-notice', 'Your password has been changed. You can sign in with it now.'))
  panel.appendChild(
    linkButton('Back to sign in', () => renderLoginForm(container, errs, () => {}))
  )
  container.replaceChildren(panel)
}

function renderGuestMode(
  container: HTMLElement,
  errs: ReturnType<typeof errorSlot>,
  onSwitchMode: (mode: AuthMode) => void
): void {
  const note = el('div', 'auth-notice')
  note.textContent = 'Play as a guest without creating an account. Your progress will not be saved.'
  container.replaceChildren(note)

  const submit = el('button', 'auth-submit', 'PLAY AS GUEST') as HTMLButtonElement
  submit.type = 'button'
  submit.addEventListener('click', async () => {
    submit.disabled = true
    submit.textContent = 'ENTERING…'
    errs.clear()
    try {
      // TEMPORARY: the server makes a throwaway account (POST /api/auth/guest) and signs
      // it in, with no email, phone or code, while the OTP signup is not yet working on
      // the phone. The session is then taken exactly as a normal sign-in's is.
      const res = await api<{ user: AuthUserShape; token: string }>('/auth/guest', { method: 'POST', body: {} })
      completeSignIn(res.token)
    } catch (error: unknown) {
      submit.disabled = false
      submit.textContent = 'PLAY AS GUEST'
      errs.show(error instanceof Error ? error.message : 'Failed to start guest session')
    }
  })

  const switchToLogin = linkButton('Sign in or create an account', () => onSwitchMode('login'))
  container.append(submit, el('div', 'auth-footer', ''), switchToLogin)
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

export function renderAuthScreen(
  root: HTMLElement,
  _app: HTMLElement,
  _notify: (message: string, kind?: 'info' | 'error') => void
): void {
  const errs = errorSlot()
  renderAuthCard(root, errs, 'login')
}
