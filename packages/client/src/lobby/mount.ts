import './lobby.css'
import { HOME_COPY } from './content.js'
import { clear } from './dom.js'
import { renderHome } from './home.js'
import { renderInfo } from './info.js'
import { renderSettings } from './settingsView.js'
import { createShell, syncTabIndicator, tabToView, viewToTab } from './shell.js'
import { defaultSetupState, renderSetup } from './setup.js'
import { renderStatistics } from './stats.js'
import type {
  InfoSection,
  LobbyBridge,
  LobbyHistoryMatch,
  LobbyProfileStats,
  LobbyTab,
  LobbyView,
  PlayMode,
  SetupState,
  StatsMode
} from './types.js'

export interface LobbySession {
  destroy: () => void
}

interface SessionState {
  view: LobbyView
  setup: SetupState
  infoSection: InfoSection
  statsMode: StatsMode
  profile: LobbyProfileStats | null
  history: LobbyHistoryMatch[]
  statsStatus: string
  starting: boolean
}

/**
 * Mounts the gaming lobby into `host`. All navigation between lobby screens stays here;
 * match start and audio call through `bridge` into existing main.ts handlers.
 */
export function mountGamingLobby(host: HTMLElement, bridge: LobbyBridge): LobbySession {
  const state: SessionState = {
    view: 'home',
    setup: defaultSetupState(bridge, null),
    infoSection: 'controls',
    statsMode: 'online',
    profile: null,
    history: [],
    statsStatus: HOME_COPY.statsEmpty,
    starting: false
  }

  let root: HTMLElement | null = null
  let escHandler: ((e: KeyboardEvent) => void) | null = null
  let fullscreenHandler: (() => void) | null = null
  let resizeHandler: (() => void) | null = null

  /** The shell is rebuilt on every paint, so the tab indicator is placed after insert. */
  const scheduleIndicator = (): void => {
    const node = root
    if (!node) return
    requestAnimationFrame(() => {
      if (node.isConnected) syncTabIndicator(node)
    })
  }

  const paint = (): void => {
    clear(host)
    const shell = createShell(bridge, state.view, {
      onTab: (tab) => goTab(tab),
      onSoundToggle: () => {
        bridge.setSoundMuted(!bridge.getSoundMuted())
        paint()
      },
      onFullscreen: toggleFullscreen,
      onSettingsIcon: () => {
        state.view = 'settings'
        paint()
      },
      onProfile: () => {
        // Presentation only: there is no profile screen in this lobby, so the
        // chip acknowledges the account without navigating away.
        bridge.onProfileActivate()
      }
    })
    root = shell.root
    host.appendChild(root)
    shell.main.appendChild(buildScreen())
    scheduleIndicator()
  }

  const buildScreen = (): HTMLElement => {
    if (state.view === 'home') {
      return renderHome(bridge, {
        openSetup: (mode) => openSetup(mode),
        openStats: () => {
          state.view = 'statistics'
          void loadStats().then(paint)
          paint()
        },
        openInfo: (section) => {
          state.infoSection = section
          state.view = 'info'
          paint()
        },
        openTournaments: () => bridge.openTournaments(),
        statsStatusLine: state.statsStatus
      })
    }
    if (state.view === 'setup') {
      return renderSetup(bridge, state.setup, {
        onBack: () => {
          state.view = 'home'
          paint()
        },
        onChange: (next) => {
          state.setup = next
          paint()
        },
        onStart: () => void startMatch(),
        starting: state.starting
      })
    }
    if (state.view === 'statistics') {
      return renderStatistics(bridge, state.statsMode, state.profile, state.history, {
        onBack: () => {
          state.view = 'home'
          paint()
        },
        onMode: (mode) => {
          state.statsMode = mode
          paint()
        }
      })
    }
    if (state.view === 'info') {
      return renderInfo(state.infoSection, {
        onBack: () => {
          state.view = 'home'
          paint()
        },
        onSection: (section) => {
          state.infoSection = section
          paint()
        }
      })
    }
    return renderSettings(bridge, {
      onToggleSound: () => {
        bridge.setSoundMuted(!bridge.getSoundMuted())
        paint()
      }
    })
  }

  const goTab = (tab: LobbyTab): void => {
    if (tab === 'statistics') {
      state.view = 'statistics'
      void loadStats().then(paint)
    } else {
      state.view = tabToView(tab)
    }
    paint()
  }

  const openSetup = (mode: PlayMode | null): void => {
    state.setup = defaultSetupState(bridge, mode)
    if (mode === 'ai') state.setup.difficulty = bridge.practiceDifficulty
    state.view = 'setup'
    paint()
  }

  const startMatch = async (): Promise<void> => {
    const { mode, difficulty, format, stakeTierId } = state.setup
    if (!mode || state.starting) return
    state.starting = true
    paint()
    try {
      if (mode === 'ai') {
        bridge.setPracticeDifficulty(difficulty)
        await bridge.startPractice(difficulty)
      } else {
        const tier = stakeTierId ?? bridge.getDefaultStakeTierId()
        if (!tier) {
          bridge.toast('Stake tiers unavailable. Try again shortly.', 'error')
          return
        }
        await bridge.startOnlineMatch({ stakeTier: tier, format })
      }
    } catch (error) {
      bridge.toast((error as Error).message, 'error')
    } finally {
      state.starting = false
      // If we are still in the lobby (start failed), repaint; success leaves via enterMatch.
      if (host.contains(root)) paint()
    }
  }

  const loadStats = async (): Promise<void> => {
    try {
      const [profile, history] = await Promise.all([bridge.fetchProfileStats(), bridge.fetchMatchHistory()])
      state.profile = profile
      state.history = history
      state.statsStatus =
        profile && profile.matches > 0 ? `${profile.wins}W · ${profile.losses}L` : HOME_COPY.statsEmpty
    } catch {
      state.profile = null
      state.history = []
      state.statsStatus = HOME_COPY.statsEmpty
    }
  }

  escHandler = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    if (state.view === 'home') return
    if (state.view === 'setup' || state.view === 'info' || state.view === 'settings' || state.view === 'statistics') {
      e.preventDefault()
      state.view = 'home'
      paint()
    }
  }
  document.addEventListener('keydown', escHandler)

  // The fullscreen button swaps to its exit glyph, so repaint on the state change.
  fullscreenHandler = (): void => {
    if (host.contains(root)) paint()
  }
  document.addEventListener('fullscreenchange', fullscreenHandler)

  // The indicator is measured, not derived: re-measure when the bar changes size.
  resizeHandler = (): void => {
    if (root) syncTabIndicator(root)
  }
  window.addEventListener('resize', resizeHandler)

  void bridge.refreshWallet()
  void loadStats().then(() => {
    if (host.contains(root)) paint()
  })
  paint()

  return {
    destroy: () => {
      if (escHandler) document.removeEventListener('keydown', escHandler)
      if (fullscreenHandler) document.removeEventListener('fullscreenchange', fullscreenHandler)
      if (resizeHandler) window.removeEventListener('resize', resizeHandler)
      clear(host)
      root = null
    }
  }
}

function toggleFullscreen(): void {
  const doc = document
  if (doc.fullscreenElement) {
    void doc.exitFullscreen?.()
  } else {
    void doc.documentElement.requestFullscreen?.()
  }
}

export { viewToTab }
