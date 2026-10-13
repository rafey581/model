import { config, isEmailDeliveryConfigured, isWhatsAppDeliveryConfigured } from '../config.js'

/**
 * Boot-time warnings for the auth configuration.
 *
 * The theme is the same as everywhere else in this file's history: a misconfigured
 * login should say so at boot, because the symptom - a screen that cannot sign anyone
 * in, or a code that never arrives - is otherwise indistinguishable from a bug.
 */
export function authConfigWarnings(): string[] {
  const warnings: string[] = []

  if (!isEmailDeliveryConfigured() && !isWhatsAppDeliveryConfigured()) {
    warnings.push(
      'Neither SMTP nor WhatsApp is configured: OTP codes will be written to the server log only. ' +
        'Set SMTP_HOST (email) and/or WHATSAPP_PROVIDER=twilio with Twilio credentials for real delivery.'
    )
  } else {
    if (!isEmailDeliveryConfigured()) {
      warnings.push('SMTP is not configured: email OTP codes will be written to the server log only.')
    }
    if (!isWhatsAppDeliveryConfigured()) {
      warnings.push(
        'WhatsApp is not configured: WhatsApp OTP codes will be written to the server log only.'
      )
    }
  }

  if (config.AUTH_ALLOW_DIRECT_REGISTER) {
    warnings.push(
      'AUTH_ALLOW_DIRECT_REGISTER=true: the internal no-OTP registration route is open. ' +
        'This is intended for tests/seed only - set it to false in production.'
    )
  }
  if (config.ADMIN_REQUIRE_TOTP === false) {
    warnings.push('ADMIN_REQUIRE_TOTP=false: admin accounts are protected by password alone.')
  }
  if (config.ADMIN_ALLOWED_IPS.trim() === '') {
    warnings.push('ADMIN_ALLOWED_IPS is empty: the admin login is reachable from any IP.')
  }
  return warnings
}
