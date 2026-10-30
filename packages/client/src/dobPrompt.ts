import { api } from './game/network.js'

/**
 * For players whose account was made before sign-up asked for a date of birth: a
 * one-time card after they log in. Without it, "forgot password" cannot help them,
 * because the date of birth is one of the details it checks. Set once; "Later" puts
 * the question off until the next time the app opens.
 */

let shown = false

export async function askForDateOfBirthIfMissing(inMatch: () => boolean, toast: (message: string, kind?: 'error') => void): Promise<void> {
  if (shown || inMatch()) return
  let needs = false
  try {
    const me = await api<{ user: { needsDateOfBirth?: boolean } }>('/me')
    needs = me.user.needsDateOfBirth === true
  } catch {
    return
  }
  if (!needs || shown || inMatch()) return
  shown = true

  const backdrop = document.createElement('div')
  backdrop.className = 'announce-backdrop'
  const card = document.createElement('div')
  card.className = 'announce-card'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-labelledby', 'dob-title')
  const tag = document.createElement('div')
  tag.className = 'announce-tag'
  tag.textContent = 'ACCOUNT SECURITY'
  const title = document.createElement('h2')
  title.id = 'dob-title'
  title.className = 'announce-title'
  title.textContent = 'Add your date of birth'
  const body = document.createElement('p')
  body.className = 'announce-body'
  body.textContent =
    'It is one of the details we ask for if you ever forget your password. It can be set once, so please enter it carefully.'
  const input = document.createElement('input')
  input.type = 'date'
  input.className = 'dob-input'
  input.min = '1900-01-01'
  input.max = new Date().toISOString().slice(0, 10)
  input.setAttribute('aria-label', 'Date of birth')
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'announce-ok'
  save.textContent = 'SAVE'
  const later = document.createElement('button')
  later.type = 'button'
  later.className = 'dob-later'
  later.textContent = 'Later'
  const close = (): void => backdrop.remove()
  later.addEventListener('click', close)
  save.addEventListener('click', async () => {
    if (!input.value) {
      toast('Please choose your date of birth.', 'error')
      return
    }
    save.disabled = true
    try {
      await api('/me/date-of-birth', { method: 'POST', body: { dateOfBirth: input.value } })
      toast('Date of birth saved.')
      close()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not save it. Please try again.', 'error')
      save.disabled = false
    }
  })
  card.append(tag, title, body, input, save, later)
  backdrop.appendChild(card)
  document.body.appendChild(backdrop)
  input.focus()
}
