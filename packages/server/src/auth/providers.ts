import { config, isGoogleUsable, isPhantomUsable } from '../config.js'

/**
 * The sign-in options the platform offers.
 *
 * This is a registry rather than a set of route handlers per option so that the
 * login screen is driven by what the server will actually accept. A provider that
 * is `enabled: false` is never rendered, so there is no button that can 500, and
 * adding Binance later is a matter of filling in an entry here plus its handler -
 * not of touching the client.
 */
export type ProviderId = 'google' | 'phantom' | 'binance'

export interface ProviderDescriptor {
  id: ProviderId
  label: string
  /** Rendered as a sign-in button. False means the client must not show it at all. */
  enabled: boolean
  /**
   * Why it is unavailable. Surfaced to operators through the API, never to
   * players - the client simply omits disabled providers.
   */
  unavailableReason?: string
  /**
   * What this provider can prove about the person signing in.
   *
   * Recorded on the account so the admin audit feed can answer "how does this
   * user authenticate?" without guessing from a null password column.
   */
  provides: string[]
  /** True when the provider asserts the address is a real inbox. */
  verifiedEmail: boolean
}

const DESCRIPTORS: Record<ProviderId, Omit<ProviderDescriptor, 'enabled'> & { isEnabled: () => boolean }> = {
  google: {
    id: 'google',
    label: 'Continue with Google',
    // A Google `sub` is a stable, non-reassignable identifier, which is exactly
    // what makes it safe to key an account on. Email is mutable and is kept only
    // for display and recovery.
    provides: ['sub (stable id)', 'email', 'email_verified', 'name', 'given_name', 'family_name', 'picture'],
    verifiedEmail: true,
    isEnabled: () => isGoogleUsable()
  },
  phantom: {
    id: 'phantom',
    label: 'Continue with Phantom',
    // A wallet proves control of an address by signing a challenge we minted. The
    // address is the identity, so it is stable in the way a `sub` is: it cannot be
    // reassigned to a different person without moving the private key.
    provides: ['wallet address (public key)'],
    verifiedEmail: false,
    isEnabled: () => isPhantomUsable()
  },
  binance: {
    id: 'binance',
    label: 'Continue with Binance',
    // Deferred deliberately. Binance does not publish a general consumer
    // "Sign in with Binance" OAuth for third-party web apps, and every Binance
    // domain is behind bot protection, so the flow could not be verified before
    // being written. Shipping an unverified auth path is worse than shipping none.
    provides: [],
    verifiedEmail: false,
    unavailableReason: 'not configured',
    isEnabled: () => false
  }
}

export function listProviders(): ProviderDescriptor[] {
  return (Object.keys(DESCRIPTORS) as ProviderId[]).map((id) => {
    const d = DESCRIPTORS[id]
    const enabled = d.isEnabled()
    return {
      id: d.id,
      label: d.label,
      enabled,
      provides: d.provides,
      verifiedEmail: d.verifiedEmail,
      ...(enabled ? {} : { unavailableReason: d.unavailableReason })
    }
  })
}

/** The subset the login screen should render. */
export function enabledProviders(): ProviderDescriptor[] {
  return listProviders().filter((p) => p.enabled)
}

export function isProviderEnabled(id: ProviderId): boolean {
  return DESCRIPTORS[id]?.isEnabled() ?? false
}

/**
 * Warns at boot about credentials that are present but not being used, because
 * the most confusing failure mode is a login screen missing Google for reasons
 * that only exist in a .env file on one machine.
 */
export function providerConfigWarnings(): string[] {
  const warnings: string[] = []
  const hasEither = Boolean(config.GOOGLE_CLIENT_ID) !== Boolean(config.GOOGLE_CLIENT_SECRET)
  if (hasEither) {
    warnings.push('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET: only one of the pair is set, so Google stays disabled.')
  }
  if (!isGoogleUsable() && !hasEither && config.GOOGLE_ENABLED === true) {
    warnings.push('GOOGLE_ENABLED=true but no client credentials are set, so Google stays disabled.')
  }
  if (enabledProviders().length === 0) {
    // Worth saying out loud: a fresh checkout boots into a login screen with no way
    // in, and without this the only symptom is an empty card.
    warnings.push('No sign-in provider is enabled, so the public login screen has no options to offer.')
  }
  if (config.ADMIN_REQUIRE_TOTP === false) {
    warnings.push('ADMIN_REQUIRE_TOTP=false: admin accounts are protected by password alone.')
  }
  if (config.ADMIN_ALLOWED_IPS.trim() === '') {
    warnings.push('ADMIN_ALLOWED_IPS is empty: the admin login is reachable from any IP.')
  }
  if (!isPhantomUsable() && config.GOOGLE_ENABLED === true && !isGoogleUsable()) {
    // Both switches off: same empty login screen as the warning above, but it is
    // worth distinguishing "no credentials" from "both providers deliberately off".
    warnings.push('PHANTOM_ENABLED=false and Google is unconfigured: no sign-in provider will be offered.')
  }
  return warnings
}
