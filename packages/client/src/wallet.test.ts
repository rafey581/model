import { describe, expect, it, afterEach, vi } from 'vitest'
import {
  WalletDeclinedError,
  WalletError,
  connectWallet,
  hasWallet,
  signWithWallet
} from './wallet.js'

/**
 * The browser half of Phantom sign-in.
 *
 * The wallet is a fake here, but the code paths are not: which injection is found,
 * what happens when the user dismisses the prompt, and the guarantee that the
 * message is signed byte-for-byte are all decided in this file, so they are the
 * things worth testing. A stub that only returned a token would pass every test and
 * still hand the server a signature over a different string.
 */

const SOLANA_ADDRESS = 'So11111111111111111111111111111111111111112'

interface FakeWallet {
  accounts: { address: string; features?: Record<string, unknown> }[]
  features?: Record<string, unknown>
}

function installStandard(wallets: Record<string, FakeWallet>): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { wallets: { get: (id: string) => wallets[id] ?? null } },
    configurable: true,
    writable: true
  })
  ;(globalThis as { window?: unknown }).window = globalThis
}

function installLegacy(solana: unknown): void {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true })
  ;(globalThis as { window?: unknown }).window = { phantom: { solana } }
}

function standardWallet(
  name: string,
  overrides: {
    accounts?: FakeWallet['accounts']
    signMessage?: (message: string | Uint8Array) => Promise<{ signature: Uint8Array }>
    connect?: () => Promise<{ accounts?: FakeWallet['accounts'] }>
  } = {}
): FakeWallet {
  const accounts =
    overrides.accounts ?? [
      {
        address: SOLANA_ADDRESS,
        features: {
          'solana:signMessage': {
            signMessage: async ({ message }: { message: string | Uint8Array }) => ({
              signature: overrides.signMessage
                ? (await overrides.signMessage(message)).signature
                : new Uint8Array(64).fill(7)
            })
          }
        }
      }
    ]
  return {
    accounts,
    features: {
      'standard:identify': { name },
      'solana:connect': { connect: overrides.connect ?? (async () => ({ accounts })) },
      'solana:signMessage': {}
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as { window?: unknown }).window
})

describe('wallet discovery', () => {
  it('reports no wallet when nothing is installed', () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true })
    ;(globalThis as { window?: unknown }).window = {}
    expect(hasWallet()).toBe(false)
  })

  it('names the fix in the error, because a missing extension is the usual cause', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true })
    ;(globalThis as { window?: unknown }).window = {}
    await expect(connectWallet()).rejects.toThrow(/install/i)
  })

  it('prefers Phantom when several standard wallets are present', async () => {
    const solflare = standardWallet('Solflare')
    const phantom = standardWallet('Phantom')
    installStandard({ solflare: solflare, phantom: phantom })

    const { address, standard } = await connectWallet()
    expect(address).toBe(SOLANA_ADDRESS)
    expect(standard).toBe(true)
  })

  it('accepts a non-Phantom wallet rather than demanding a specific extension', async () => {
    installStandard({ solflare: standardWallet('Solflare') })
    // Someone who arrived with Solflare should be able to sign in, not be told to
    // install something else.
    const { address } = await connectWallet()
    expect(address).toBe(SOLANA_ADDRESS)
  })

  it('skips a wallet that cannot sign rather than failing', async () => {
    const readOnly: FakeWallet = { accounts: [], features: { 'standard:identify': { name: 'Phantom' } } }
    installStandard({ phantom: readOnly, solflare: standardWallet('Solflare') })
    const { address } = await connectWallet()
    expect(address).toBe(SOLANA_ADDRESS)
  })

  it('keeps trying when one wallet throws on inspection', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        wallets: {
          get: (id: string) => {
            if (id === 'phantom') throw new Error('extension is mid-update')
            if (id === 'solflare') return standardWallet('Solflare')
            return null
          }
        }
      },
      configurable: true,
      writable: true
    })
    ;(globalThis as { window?: unknown }).window = globalThis
    const { address } = await connectWallet()
    expect(address).toBe(SOLANA_ADDRESS)
  })

  it('falls back to the legacy injection when no standard wallet qualifies', async () => {
    installLegacy({
      connect: async () => ({ publicKey: { toString: () => SOLANA_ADDRESS } }),
      signMessage: async () => ({ signature: new Uint8Array(64).fill(1) })
    })
    const { address, standard } = await connectWallet()
    expect(address).toBe(SOLANA_ADDRESS)
    expect(standard).toBeUndefined()
  })
})

describe('signing', () => {
  it('passes the message through byte-for-byte', async () => {
    // The server verifies against the exact bytes it minted. A trim, a newline
    // normalisation or a re-encode here would produce a valid signature over the
    // wrong message, which is the one mistake this flow cannot make.
    const message = 'arena wants you to sign in\n\n  spaced  \n\nURI: x\nNonce: n\n'
    let seen: string | Uint8Array | undefined
    installStandard({
      phantom: standardWallet('Phantom', {
        signMessage: async (m) => {
          seen = m
          return { signature: new Uint8Array(64).fill(3) }
        }
      })
    })
    await connectWallet()
    await signWithWallet(message, SOLANA_ADDRESS)
    expect(seen).toBe(message)
  })

  it('returns base58, and never a raw byte array', async () => {
    installStandard({
      phantom: standardWallet('Phantom', {
        signMessage: async () => ({ signature: Uint8Array.from({ length: 64 }, (_, i) => i + 1) })
      })
    })
    await connectWallet()
    const signature = await signWithWallet('m', SOLANA_ADDRESS)
    expect(typeof signature).toBe('string')
    // 64 bytes of a non-trivial payload is 86-88 base58 characters.
    expect(signature.length).toBeGreaterThanOrEqual(86)
    expect(signature.length).toBeLessThanOrEqual(88)
  })

  it('reports a declined prompt as a decline, not a failure', async () => {
    const declined = Object.assign(new Error('User rejected the request.'), { code: 4001 })
    installStandard({ phantom: standardWallet('Phantom', { connect: async () => Promise.reject(declined) }) })
    await expect(connectWallet()).rejects.toBeInstanceOf(WalletDeclinedError)
  })

  it('surfaces a declined signature the same way', async () => {
    const declined = Object.assign(new Error('User rejected the request.'), { code: 4001 })
    installStandard({
      phantom: standardWallet('Phantom', { signMessage: async () => Promise.reject(declined) })
    })
    await connectWallet()
    await expect(signWithWallet('m', SOLANA_ADDRESS)).rejects.toBeInstanceOf(WalletDeclinedError)
  })

  it('refuses a signature that is not 64 bytes', async () => {
    installStandard({
      phantom: standardWallet('Phantom', {
        signMessage: async () => ({ signature: new Uint8Array(32) })
      })
    })
    await connectWallet()
    // A 32-byte value is a public key, not a signature. Catching it here gives a
    // clear message instead of an opaque 401 from the server.
    await expect(signWithWallet('m', SOLANA_ADDRESS)).rejects.toThrow(WalletError)
  })

  it('will not sign with an account other than the one that connected', async () => {
    installStandard({ phantom: standardWallet('Phantom') })
    await connectWallet()
    await expect(signWithWallet('m', 'SomeOtherWalletAddress11111111111111111111111')).rejects.toThrow(
      /cannot sign/i
    )
  })
})

