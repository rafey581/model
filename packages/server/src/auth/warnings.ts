import { config, isEmailDeliveryConfigured } from '../config.js'

/**
 * Boot-time warnings for the auth configuration.
 *
 * The theme is the same as everywhere else in this file's history: a misconfigured
 * login should say so at boot, because the symptom - a screen that cannot sign anyone
 * in, or a code that never arrives - is otherwise indistinguishable from a bug.
 */
export function authConfigWarnings(): string[] {
  const warnings: string[] = []

  if (!isEmailDeliveryConfigured()) {
    warnings.push(
      'SMTP is not configured: OTP codes will be written to the server log only. ' +
        'Set SMTP_HOST (and SMTP_USER/SMTP_PASS) for real email delivery.'
    )
  }

  if (config.ADMIN_ALLOWED_IPS.trim() === '') {
    warnings.push('ADMIN_ALLOWED_IPS is empty: the admin login is reachable from any IP.')
  }
  return warnings
}
