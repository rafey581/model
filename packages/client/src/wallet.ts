/**
 * Talking to a Phantom wallet from the browser.
 *
 * There are two APIs and the right answer is to try both:
 *
 *  - **Wallet Standard** (`navigator.wallets`) is the modern, capability-based
 *    interface. A wallet advertises the features it supports and we ask for
 *    `solana:connect` and `solana:signMessage` by name, so the code does not care
 *    which wallet answered.
 *  - **`window.phantom.solana`** is Phantom's own long-standing injection, and it
 *    is what the extension has always exposed. It is kept as a fallback because it
 *    is the path most people's installed extension actually takes, and a sign-in
 *    screen that only works in the newest wallet build is a broken sign-in screen.
 *
 * Every function returns the base58 string, never a raw `Uint8Array`, because
 * base58 is what the server expects and converting here keeps the byte handling in
 * one place instead of at every call site.
 */

/**
 * Wallet ids to try, in the order we would prefer them.
 *
 * Wallet Standard deliberately has no "list what is installed" call - `get(id)` is
 * the whole API - so a dapp that wants to work with more than one wallet has to
 * ask for the ids it knows. That is why this list is explicit and why Phantom's own
 * id is tried by name: it is the wallet the product is named for, and it is the one
 * most likely to be installed by the person reading the button.
 */
const WALLET_IDS = [
  // Phantom's Wallet Standard id, then its legacy alias.
  'phantom',
  'app.phantom',
  // Other common Solana wallets, so a user who arrived with one is not told to
  // install a different extension to sign in.
  'solflare',
  'backpack',
  'wallet-standard'
]

export interface ConnectedWallet {
  address: string
  /** Present only on the Wallet Standard path. */
  standard?: boolean
}

export class WalletError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WalletError'
  }
}

/** Thrown when the user dismisses the wallet prompt. Not an error worth shouting about. */
export class WalletDeclinedError extends WalletError {
  constructor() {
    super('Sign-in was declined in the wallet.')
    this.name = 'WalletDeclinedError'
  }
}

interface WalletStandardAccount {
  address: string
  features?: Record<string, { signMessage: (input: { message: string | Uint8Array }) => Promise<{ signature: Uint8Array }> }>
}

interface WalletStandardWallet {
  accounts: WalletStandardAccount[]
  features?: Record<string, unknown>
}

function isPhantomCandidate(wallet: WalletStandardWallet): boolean {
  // Prefer Phantom by name, but accept any wallet that can actually sign - someone
  // on Solflare or Backpack should not be told they need a different extension.
  const known = wallet.features?.['standard:identify'] as { name?: string } | undefined
  return typeof known?.name === 'string' && /phantom/i.test(known.name)
}

function canSignIn(wallet: WalletStandardWallet): boolean {
  const features = wallet.features ?? {}
  return 'solana:connect' in features && 'solana:signMessage' in features
}

/** Base58 in the browser, without pulling in an encoding library for 40 characters. */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  let zeroes = 0
  while (zeroes < bytes.length - 1 && bytes[zeroes] === 0) zeroes += 1

  const digits: number[] = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j]! << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }

  let out = '1'.repeat(zeroes)
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58[digits[i]!]
  return out
}

interface LegacyPhantom {
  connect: () => Promise<{ publicKey: { toString: () => string } | Uint8Array }>
  signMessage: (message: Uint8Array) => Promise<{ signature: Uint8Array }>
  isPhantom?: boolean
}

function legacyProvider(): LegacyPhantom | undefined {
  const injected = (window as unknown as { phantom?: { solana?: LegacyPhantom } }).phantom?.solana
  if (injected && typeof injected.connect === 'function' && typeof injected.signMessage === 'function') {
    return injected
  }
  return undefined
}

/**
 * Finds a wallet that can sign.
 *
 * Prefers Wallet Standard, because it is the interface that keeps working when
 * Phantom renames something, and falls back to the legacy injection. Errors name
 * the fix rather than the failure, because the overwhelmingly common cause is "the
 * extension is not installed".
 */
function findWallet(): { kind: 'standard'; wallet: WalletStandardWallet } | { kind: 'legacy'; legacy: LegacyPhantom } {
  const registry = (navigator as unknown as { wallets?: { get: (id: string) => WalletStandardWallet | null } })
    .wallets

  if (registry?.get) {
    let fallback: WalletStandardWallet | undefined
    for (const id of WALLET_IDS) {
      let wallet: WalletStandardWallet | null = null
      try {
        wallet = registry.get(id)
      } catch {
        // A wallet that throws on capability inspection is not usable. Move on to
        // the next candidate rather than failing the whole sign-in.
        continue
      }
      if (!wallet || !canSignIn(wallet)) continue
      if (isPhantomCandidate(wallet)) return { kind: 'standard', wallet }
      fallback ??= wallet
    }
    if (fallback) return { kind: 'standard', wallet: fallback }
  }

  const legacy = legacyProvider()
  if (legacy) return { kind: 'legacy', legacy }

  throw new WalletError(
    'No Solana wallet found. Install the Phantom extension, or any Wallet Standard wallet, and reload.'
  )
}

/**
 * Asks the wallet which account to use and returns its address.
 *
 * This is the prompt the user expects to see: the wallet decides, not us. We never
 * pick an account on their behalf, and the address that comes back is the only thing
 * the server will later accept, because the signature is checked against it.
 */
export async function connectWallet(): Promise<ConnectedWallet> {
  const found = findWallet()

  if (found.kind === 'legacy') {
    try {
      const { publicKey } = await found.legacy.connect()
      const address =
        typeof publicKey === 'string'
          ? publicKey
          : publicKey instanceof Uint8Array
            ? base58Encode(publicKey)
            : publicKey.toString()
      if (!address) throw new WalletDeclinedError()
      return { address }
    } catch (error) {
      throw normalise(error)
    }
  }

  const { wallet } = found
  const account = wallet.accounts[0]
  if (!account) throw new WalletError('The connected wallet has no accounts. Unlock it and try again.')

  const connect = wallet.features?.['solana:connect'] as
    | { connect: () => Promise<{ accounts?: WalletStandardAccount[] }> }
    | undefined

  let address = account.address
  if (connect) {
    try {
      const result = await connect.connect()
      address = result?.accounts?.[0]?.address ?? address
    } catch (error) {
      // Phantom throws 4001 when the user dismisses the approval prompt.
      throw normalise(error)
    }
  }

  if (!address) throw new WalletDeclinedError()
  return { address, standard: true }
}

/**
 * Asks the wallet to sign `message` and returns the signature as base58.
 *
 * The message is passed through untouched. The server minted it and will verify the
 * signature against those exact bytes, so any normalisation here - a trim, a
 * newline, an encode - would produce a signature that does not verify. That is why
 * this function does not "tidy" its input.
 */
export async function signWithWallet(message: string, address: string): Promise<string> {
  const found = findWallet()
  const bytes = new TextEncoder().encode(message)

  try {
    if (found.kind === 'legacy') {
      const { signature } = await found.legacy.signMessage(bytes)
      if (!(signature instanceof Uint8Array) || signature.length !== 64) {
        throw new WalletError('The wallet returned a signature we could not read.')
      }
      return base58Encode(signature)
    }

    const { wallet } = found
    const account = wallet.accounts.find((a) => a.address === address)
    if (!account?.features?.['solana:signMessage']) {
      throw new WalletError('That wallet account cannot sign messages. Reconnect and try again.')
    }
    const { signature } = await account.features['solana:signMessage'].signMessage({ message })
    if (!(signature instanceof Uint8Array) || signature.length !== 64) {
      throw new WalletError('The wallet returned a signature we could not read.')
    }
    return base58Encode(signature)
  } catch (error) {
    throw normalise(error)
  }
}

/**
 * Turns a wallet rejection into something worth showing.
 *
 * 4001 is the EIP-1193 code every Solana wallet uses for "user said no", and it is
 * a normal outcome, not a failure to report as an error.
 */
function normalise(error: unknown): WalletError {
  if (error instanceof WalletError) return error
  const code = (error as { code?: number } | null)?.code
  if (code === 4001) return new WalletDeclinedError()
  const message = error instanceof Error ? error.message : String(error)
  return new WalletError(message || 'The wallet did not respond.')
}

/** True when a wallet is present at all, so the screen can say so before a click. */
export function hasWallet(): boolean {
  try {
    findWallet()
    return true
  } catch {
    return false
  }
}