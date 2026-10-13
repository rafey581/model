import nodemailer from 'nodemailer'
import { config, isEmailDeliveryConfigured, isWhatsAppDeliveryConfigured } from '../config.js'
import type { OtpChannel, OtpPurpose } from './otp.js'

/**
 * Delivering an OTP over email or WhatsApp.
 *
 * Both channels have a real path (SMTP for email, the Twilio REST API for WhatsApp)
 * and a dev path. When a channel is not configured the code is written to the server
 * log instead of sent, so a fresh checkout can register and sign in with no third-party
 * account - and never with a silent failure, because the log line says exactly that no
 * message went out.
 *
 * Delivery failures are surfaced, not swallowed: the caller must not tell the player
 * "code sent" when the send threw.
 */

export interface DeliveryLog {
  info: (fields: Record<string, unknown>, message: string) => void
  warn: (fields: Record<string, unknown>, message: string) => void
}

const consoleLog: DeliveryLog = {
  info: (fields, message) => console.info(message, fields),
  warn: (fields, message) => console.warn(message, fields)
}

function minutesLeft(): number {
  return Math.max(1, Math.round(config.OTP_TTL_SEC / 60))
}

function subjectFor(purpose: OtpPurpose): string {
  return purpose === 'SIGNUP' ? 'Your Snooker Arena verification code' : 'Your Snooker Arena password reset code'
}

function bodyFor(code: string, purpose: OtpPurpose): string {
  const lead =
    purpose === 'SIGNUP'
      ? 'Use this code to finish creating your Snooker Arena account'
      : 'Use this code to reset your Snooker Arena password'
  return `${lead}: ${code}\n\nIt expires in ${minutesLeft()} minute(s). If you did not request this, you can ignore this message.`
}

let transporter: ReturnType<typeof nodemailer.createTransport> | null | undefined

/**
 * Lazily builds the SMTP transport.
 *
 * `undefined` means "not yet decided", `null` means "no SMTP configured". Building it on
 * first use keeps a fresh checkout from opening a connection it will never use.
 */
function mailer(): ReturnType<typeof nodemailer.createTransport> | null {
  if (transporter === undefined) {
    transporter = isEmailDeliveryConfigured()
      ? nodemailer.createTransport({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          secure: config.SMTP_SECURE ?? false,
          auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined
        })
      : null
  }
  return transporter ?? null
}

async function sendEmail(to: string, code: string, purpose: OtpPurpose, log: DeliveryLog): Promise<void> {
  const transport = mailer()
  const text = bodyFor(code, purpose)
  if (!transport) {
    log.warn(
      { to, dev: true },
      `SMTP is not configured - OTP code for ${to} is ${code} (dev only, nothing was emailed)`
    )
    return
  }
  await transport.sendMail({
    from: config.SMTP_FROM,
    to,
    subject: subjectFor(purpose),
    text
  })
}

async function sendWhatsApp(to: string, code: string, purpose: OtpPurpose, log: DeliveryLog): Promise<void> {
  if (!isWhatsAppDeliveryConfigured()) {
    log.warn(
      { to, dev: true },
      `WhatsApp is not configured - OTP code for ${to} is ${code} (dev only, nothing was sent)`
    )
    return
  }
  const from = config.TWILIO_WHATSAPP_FROM.startsWith('whatsapp:')
    ? config.TWILIO_WHATSAPP_FROM
    : `whatsapp:${config.TWILIO_WHATSAPP_FROM}`
  const body = new URLSearchParams({
    From: from,
    To: `whatsapp:${to}`,
    Body: bodyFor(code, purpose)
  })
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    }
  )
  if (!response.ok) {
    throw new Error(`WhatsApp delivery failed (Twilio ${response.status})`)
  }
}

export async function sendOtpCode(opts: {
  channel: OtpChannel
  identifier: string
  code: string
  purpose: OtpPurpose
  log?: DeliveryLog
}): Promise<void> {
  const log = opts.log ?? consoleLog
  if (opts.channel === 'EMAIL') {
    await sendEmail(opts.identifier, opts.code, opts.purpose, log)
    return
  }
  await sendWhatsApp(opts.identifier, opts.code, opts.purpose, log)
}
