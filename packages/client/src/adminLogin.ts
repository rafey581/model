import { api, makeToast } from './game/network.js'
import { renderAdminPanel } from './admin.js'

/**
 * The admin entry point, served at /admin.
 *
 * Kept apart from the player app on purpose. This screen is not linked from anywhere
 * in the public UI, it does not read or write the player's token, and it never
 * renders the game header - so "where is the admin panel" is not answerable by
 * looking at the site. The security that matters is on the server; this is the part
 * that keeps the surface undiscoverable.
 *
 * The flow is three steps, and the middle one only exists once per account:
 *   1. email + password
 *   2. TOTP enrollment (first time only - a secret is issued, then activated)
 *   3. email + password + code
 */

const toast = makeToast(document.body)

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function errorSlot(): { node: HTMLElement; show: (m: string) => void; clear: () => void } {
  const node = el('div', 'auth-error')
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

function shell(): { screen: HTMLElement; card: HTMLElement } {
  const screen = el('div', 'auth-screen')
  const card = el('div', 'auth-card')
  const brand = el('div', 'auth-brand')
  const logo = el('div', 'auth-logo')
  logo.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#0a0a0f"/><circle cx="12" cy="12" r="7" fill="#c9a84c"/><circle cx="9.5" cy="9.5" r="2.5" fill="#e8c872"/></svg>'
  brand.appendChild(logo)
  brand.appendChild(el('h1', 'auth-title', 'Snooker Arena'))
  brand.appendChild(el('p', 'auth-subtitle', 'Staff access'))
  card.appendChild(brand)
  screen.appendChild(card)
  return { screen, card }
}

function textField(
  form: HTMLFormElement,
  id: string,
  labelText: string,
  type: string,
  autocomplete: string,
  inputmode?: 'text' | 'numeric'
): HTMLInputElement {
  const group = el('div', 'auth-input-group')
  const label = document.createElement('label')
  label.htmlFor = id
  label.textContent = labelText
  const input = document.createElement('input')
  input.id = id
  input.name = id
  input.type = type
  input.autocomplete = autocomplete as HTMLInputElement['autocomplete']
  if (inputmode) input.inputMode = inputmode
  group.append(label, input)
  form.appendChild(group)
  return input
}

/** Step 1 and step 3 share a shape; `withTotp` decides whether the code box shows. */
function renderCredentials(
  mount: HTMLElement,
  opts: { withTotp: boolean; message?: string }
): void {
  const { screen, card } = shell()
  const errs = errorSlot()
  card.appendChild(errs.node)
  if (opts.message) {
    const note = el('div', 'auth-notice')
    note.textContent = opts.message
    card.appendChild(note)
  }

  const form = document.createElement('form')
  form.className = 'auth-form'
  form.noValidate = true

  const email = textField(form, 'admin-email', 'Email', 'email', 'username')
  const password = textField(form, 'admin-password', 'Password', 'password', 'current-password')
  const code = opts.withTotp
    ? textField(form, 'admin-totp', 'Authenticator code', 'text', 'one-time-code', 'numeric')
    : null
  if (code) {
    code.maxLength = 6
    code.placeholder = '000000'
    code.setAttribute('inputmode', 'numeric')
  }

  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'auth-submit'
  submit.textContent = opts.withTotp ? 'SIGN IN' : 'CONTINUE'
  form.appendChild(submit)
  card.appendChild(form)

  const back = document.createElement('a')
  back.className = 'auth-link'
  back.href = '/'
  back.textContent = 'Back to the arena'
  card.appendChild(back)

  mount.replaceChildren(screen)

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (submit.disabled) return
    errs.clear()
    if (code && !/^\d{6}$/.test(code.value.trim())) {
      errs.show('Enter the 6-digit code from your authenticator.')
      code.focus()
      return
    }
    submit.disabled = true
    submit.textContent = 'ONE MOMENT…'
    void api<{ user: unknown; requiresTotp?: boolean; enrollToken?: string; secret?: string; otpauth?: string }>(
      '/admin/auth/login',
      {
        method: 'POST',
        body: {
          email: email.value.trim(),
          password: password.value,
          ...(code ? { totp: code.value.trim() } : {})
        }
      }
    )
      .then((data) => {
        if (data.requiresTotp && data.enrollToken && data.secret) {
          renderEnrollment(mount, { token: data.enrollToken, secret: data.secret, otpauth: data.otpauth })
          return
        }
        renderPanel(mount)
      })
      .catch((error: Error) => {
        submit.disabled = false
        submit.textContent = opts.withTotp ? 'SIGN IN' : 'CONTINUE'
        errs.show(error.message)
      })
  })

  email.focus()
}

/**
 * Step 2: enrol the authenticator.
 *
 * The secret is shown as text as well as a scannable URI, because a phone with no
 * camera to spare the URL still has to be able to type it in. Nothing is stored
 * until a live code comes back, so abandoning this screen leaves no half-enabled
 * second factor behind.
 */
function renderEnrollment(
  mount: HTMLElement,
  data: { token: string; secret: string; otpauth?: string }
): void {
  const { screen, card } = shell()
  const errs = errorSlot()
  card.appendChild(errs.node)

  const intro = el('div', 'auth-notice')
  intro.textContent =
    'This account needs a second factor. Add the key below to an authenticator app, then enter the code it shows.'
  card.appendChild(intro)

  const secretBox = el('div', 'auth-secret')
  secretBox.appendChild(el('span', 'auth-secret-label', 'Setup key'))
  const value = el('code', 'auth-secret-value', data.secret)
  secretBox.appendChild(value)
  card.appendChild(secretBox)

  const uri = el('p', 'auth-hint', 'Prefer to scan? Open this otpauth link in your authenticator app:')
  card.appendChild(uri)
  const link = document.createElement('a')
  link.className = 'auth-link'
  link.href = data.otpauth ?? `otpauth://totp/Snooker%20Arena:${data.secret}`
  link.textContent = 'Open in authenticator'
  card.appendChild(link)

  const form = document.createElement('form')
  form.className = 'auth-form'
  form.noValidate = true
  const code = textField(form, 'enroll-totp', 'Code from your app', 'text', 'one-time-code', 'numeric')
  code.maxLength = 6
  code.placeholder = '000000'
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'auth-submit'
  submit.textContent = 'ACTIVATE'
  form.appendChild(submit)
  card.appendChild(form)

  mount.replaceChildren(screen)

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (submit.disabled) return
    errs.clear()
    if (!/^\d{6}$/.test(code.value.trim())) {
      errs.show('Enter the 6-digit code from your app.')
      return
    }
    submit.disabled = true
    submit.textContent = 'ONE MOMENT…'
    void api('/admin/auth/totp/activate', {
      method: 'POST',
      body: { enrollToken: data.token, totp: code.value.trim() }
    })
      .then(() => renderPanel(mount))
      .catch((error: Error) => {
        submit.disabled = false
        submit.textContent = 'ACTIVATE'
        errs.show(error.message)
      })
  })

  code.focus()
}

function renderPanel(mount: HTMLElement): void {
  const screen = el('div', 'auth-screen auth-screen-wide')
  mount.replaceChildren(screen)
  const host = el('div', 'app-root')
  screen.appendChild(host)
  renderAdminPanel(host, toast)
}

export function startAdminApp(mount: HTMLElement): void {
  document.body.classList.add('admin-mode')
  // An existing session skips the form; a 401 falls back to it.
  void api<{ user: unknown }>('/admin/auth/session')
    .then(() => renderPanel(mount))
    .catch(() => renderCredentials(mount, { withTotp: false }))
}
