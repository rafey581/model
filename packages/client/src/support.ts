import { api } from './game/network.js'
import { makeToast } from './game/network.js'

interface SupportMessage {
  id: string
  senderId: string
  senderRole: string
  body: string
  read: boolean
  createdAt: string
  sender: { id: string; username: string; role: string }
}

interface SupportThread {
  id: string
  userId: string
  status: string
  messages: SupportMessage[]
}

let supportLayer: HTMLElement | null = null
let thread: SupportThread | null = null
let toastInstance: any = null

export function openSupportChat(): void {
  if (document.getElementById('support-layer')) {
    document.getElementById('support-layer')!.classList.add('open')
    loadThread()
    return
  }
  
  if (!toastInstance) {
    toastInstance = makeToast(document.body)
  }
  
  const layer = document.createElement('div')
  layer.id = 'support-layer'
  layer.className = 'support-layer'
  
  const overlay = document.createElement('div')
  overlay.className = 'support-overlay'
  overlay.onclick = () => closeSupportChat()
  
  const panel = document.createElement('div')
  panel.className = 'support-panel'
  
  const header = document.createElement('div')
  header.className = 'support-header'
  header.innerHTML = '<span>Customer Support</span><button class="support-close">×</button>'
  header.querySelector('.support-close')!.addEventListener('click', closeSupportChat)
  
  const body = document.createElement('div')
  body.className = 'support-body'
  body.id = 'support-body'
  
  const messages = document.createElement('div')
  messages.className = 'support-messages'
  messages.id = 'support-messages'
  
  const inputWrap = document.createElement('div')
  inputWrap.className = 'support-input-wrap'
  const input = document.createElement('input')
  input.className = 'support-input'
  input.placeholder = 'Type your message...'
  const sendBtn = document.createElement('button')
  sendBtn.className = 'support-send'
  sendBtn.textContent = 'Send'
  
  inputWrap.appendChild(input)
  inputWrap.appendChild(sendBtn)
  
  body.appendChild(messages)
  body.appendChild(inputWrap)
  
  panel.appendChild(header)
  panel.appendChild(body)
  layer.appendChild(overlay)
  layer.appendChild(panel)
  document.body.appendChild(layer)
  
  supportLayer = layer
  
  sendBtn.addEventListener('click', sendMessage)
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage()
  })
  
  setTimeout(() => layer.classList.add('open'), 10)
  loadThread()
}

function closeSupportChat(): void {
  supportLayer?.classList.remove('open')
}

async function loadThread(): Promise<void> {
  try {
    const res = await api<SupportThread>('/support/thread')
    thread = res
    renderMessages()
  } catch (e: any) {
    toastInstance?.(e.message || 'Failed to load support', 'error')
  }
}

function renderMessages(): void {
  const container = document.getElementById('support-messages')
  if (!container) return
  container.innerHTML = ''
  if (!thread?.messages?.length) {
    container.innerHTML = '<div class="support-empty">Start a conversation with support.</div>'
    return
  }
  for (const msg of thread.messages) {
    const div = document.createElement('div')
    div.className = `support-msg ${msg.senderRole === 'ADMIN' ? 'admin' : 'user'}`
    div.innerHTML = `
      <div class="support-msg-bubble">${escapeHtml(msg.body)}</div>
      <div class="support-msg-meta">${msg.senderRole === 'ADMIN' ? 'Support' : 'You'} • ${new Date(msg.createdAt).toLocaleTimeString()}</div>
    `
    container.appendChild(div)
  }
  container.scrollTop = container.scrollHeight
}

async function sendMessage(): Promise<void> {
  const input = document.querySelector('.support-input') as HTMLInputElement
  const body = input.value.trim()
  if (!body) return
  input.disabled = true
  try {
    const msg = await api<SupportMessage>('/support/message', { method: 'POST', body: { body } })
    if (!thread) {
      thread = { id: '', userId: '', status: 'OPEN', messages: [] }
    }
    thread.messages.push(msg)
    renderMessages()
    input.value = ''
  } catch (e: any) {
    toastInstance?.(e.message || 'Failed to send message', 'error')
  } finally {
    input.disabled = false
    input.focus()
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
