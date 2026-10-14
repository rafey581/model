import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import type { SettingsMap } from '@/lib/types'
import { Card, ErrorState, Loading, Screen, ScreenTitle, SectionTitle } from '@/components/ui'
import { useDialog } from '@/components/ActionDialog'
import { useToast } from '@/components/Toast'
import { colors, radius, spacing } from '@/theme'

type SettingKind = 'boolean' | 'number' | 'list'

interface SettingMeta {
  label: string
  description: string
  kind: SettingKind
}

/**
 * The knobs that change how the game behaves.
 *
 * Keys and their types mirror `SETTING_KEYS` on the server. Boolean settings save
 * the moment they are flipped (a maintenance switch that needs a second confirm is
 * the wrong shape during an incident); number and list settings keep a typed value
 * until Save, so a half-typed number never lands.
 */
const SETTING_META: Record<string, SettingMeta> = {
  commissionPct: { label: 'Commission %', description: 'House cut taken from the losing stake.', kind: 'number' },
  minStake: { label: 'Minimum stake (USDT)', description: 'Smallest amount a player can put on a match.', kind: 'number' },
  maxStake: { label: 'Maximum stake (USDT)', description: 'Largest amount a player can put on a match.', kind: 'number' },
  matchFormats: { label: 'Match formats', description: 'Comma-separated list, for example BO1, BO3, BO5.', kind: 'list' },
  turnTimeoutSec: { label: 'Turn timeout (seconds)', description: 'How long a player has to take a shot.', kind: 'number' },
  reconnectGraceSec: { label: 'Reconnect grace (seconds)', description: 'How long a disconnected player has before forfeiting.', kind: 'number' },
  maintenanceMode: { label: 'Maintenance mode', description: 'Blocks new play for everyone. Existing matches finish.', kind: 'boolean' },
  realMoneyEnabled: { label: 'Real money enabled', description: 'When off, matches are played without stakes.', kind: 'boolean' }
}

const KNOWN_ORDER = Object.keys(SETTING_META)

function toText(value: unknown, kind: SettingKind): string {
  if (value === null || value === undefined) return ''
  if (kind === 'list') return Array.isArray(value) ? value.join(', ') : String(value)
  return String(value)
}

export default function SettingsScreen() {
  const state = useAsync(() => api<SettingsMap>('/admin/settings'), [])
  const warningsState = useAsync(
    () => api<{ warnings: string[] }>('/admin/auth/warnings'),
    []
  )
  const toast = useToast()
  const dialog = useDialog()
  const [maintenance, setMaintenance] = useState(false)

  const settings = state.data ?? {}

  useEffect(() => {
    if (state.data && typeof state.data.maintenanceMode === 'boolean') {
      setMaintenance(state.data.maintenanceMode)
    }
  }, [state.data])

  const save = async (key: string, value: unknown): Promise<boolean> => {
    try {
      await api('/admin/settings', { method: 'PATCH', body: { key, value } })
      toast.show(`${SETTING_META[key]?.label ?? key} updated`, 'success')
      state.reload()
      return true
    } catch (caught) {
      toast.show((caught as Error).message, 'error')
      return false
    }
  }

  const toggleMaintenance = async (next: boolean): Promise<void> => {
    if (next) {
      const result = await dialog.confirm({
        title: 'Turn on maintenance mode?',
        message: 'No new matches can start until this is turned off. Matches already running are not interrupted.',
        confirmLabel: 'Enable',
        destructive: true
      })
      if (!result.confirmed) return
    }
    setMaintenance(next)
    const ok = await save('maintenanceMode', next)
    if (!ok) setMaintenance(!next)
  }

  if (state.loading && !state.data) return <Screen scroll={false}><Loading /></Screen>
  if (state.error && !state.data) return <Screen><ErrorState message={state.error} onRetry={state.reload} /></Screen>

  const warningList = warningsState.data?.warnings ?? []
  const extraKeys = Object.keys(settings).filter((key) => !KNOWN_ORDER.includes(key))

  return (
    <Screen refreshing={state.refreshing} onRefresh={state.reload}>
      <ScreenTitle title="Settings" subtitle="Applies to new matches immediately" />

      {warningList.length > 0 ? (
        <Card style={styles.warningCard}>
          <Text style={styles.warningTitle}>Security notices</Text>
          {warningList.map((warning) => (
            <Text key={warning} style={styles.warningText}>
              - {warning}
            </Text>
          ))}
        </Card>
      ) : null}

      <Card style={maintenance ? styles.maintenanceOn : undefined}>
        <View style={styles.toggleRow}>
          <View style={styles.flex}>
            <Text style={styles.label}>Maintenance mode</Text>
            <Text style={styles.description}>{SETTING_META.maintenanceMode.description}</Text>
          </View>
          <Switch
            value={maintenance}
            onValueChange={(next) => void toggleMaintenance(next)}
            trackColor={{ true: colors.accent, false: colors.border }}
            thumbColor={maintenance ? colors.accent : colors.muted}
          />
        </View>
      </Card>

      <SectionTitle>Gameplay and economy</SectionTitle>
      {KNOWN_ORDER.filter((key) => key !== 'maintenanceMode').map((key) => (
        <SettingRow key={key} settingKey={key} value={settings[key]} onSave={save} />
      ))}

      {extraKeys.length > 0 ? (
        <>
          <SectionTitle>Other stored values</SectionTitle>
          {extraKeys.map((key) => (
            <SettingRow key={key} settingKey={key} value={settings[key]} onSave={save} />
          ))}
        </>
      ) : null}
    </Screen>
  )
}

function SettingRow({
  settingKey,
  value,
  onSave
}: {
  settingKey: string
  value: unknown
  onSave: (key: string, value: unknown) => Promise<boolean>
}) {
  const meta = SETTING_META[settingKey] ?? { label: settingKey, description: 'Stored JSON value.', kind: inferKind(value) }
  const [text, setText] = useState(() => toText(value, meta.kind))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setText(toText(value, meta.kind))
  }, [value, meta.kind])

  const original = toText(value, meta.kind)
  const dirty = text.trim() !== original.trim()

  const commit = async (): Promise<void> => {
    setBusy(true)
    const parsed = parseValue(text, meta.kind)
    await onSave(settingKey, parsed)
    setBusy(false)
  }

  if (meta.kind === 'boolean') {
    const on = value === true
    return (
      <Card>
        <View style={styles.toggleRow}>
          <View style={styles.flex}>
            <Text style={styles.label}>{meta.label}</Text>
            <Text style={styles.description}>{meta.description}</Text>
          </View>
          <Switch
            value={on}
            onValueChange={() => void onSave(settingKey, !on)}
            trackColor={{ true: colors.accent, false: colors.border }}
            thumbColor={on ? colors.accent : colors.muted}
          />
        </View>
      </Card>
    )
  }

  return (
    <Card>
      <Text style={styles.label}>{meta.label}</Text>
      <Text style={styles.description}>{meta.description}</Text>
      <View style={styles.editRow}>
        <TextInput
          value={text}
          onChangeText={setText}
          keyboardType={meta.kind === 'number' ? 'numeric' : 'default'}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={meta.kind === 'list' ? 'BO1, BO3, BO5' : '0'}
          placeholderTextColor={colors.muted}
          style={styles.input}
        />
        <Pressable
          onPress={dirty && !busy ? () => void commit() : undefined}
          style={[styles.saveButton, dirty ? styles.saveActive : styles.saveIdle]}
        >
          <Text style={[styles.saveText, dirty ? styles.saveTextActive : null]}>{busy ? '...' : 'Save'}</Text>
        </Pressable>
      </View>
    </Card>
  )
}

function inferKind(value: unknown): SettingKind {
  if (typeof value === 'boolean') return 'boolean'
  if (Array.isArray(value)) return 'list'
  return 'number'
}

function parseValue(text: string, kind: SettingKind): unknown {
  if (kind === 'list') {
    return text
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  }
  if (kind === 'number') {
    const n = Number(text.trim())
    return Number.isFinite(n) ? n : text.trim()
  }
  return text
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  label: { color: colors.text, fontSize: 15, fontWeight: '600' },
  description: { color: colors.muted, fontSize: 12, marginTop: 2 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  editRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', marginTop: spacing.sm },
  input: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 15
  },
  saveButton: { borderWidth: 1, borderRadius: radius.sm, paddingVertical: 11, paddingHorizontal: spacing.lg },
  saveActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  saveIdle: { borderColor: colors.border },
  saveText: { color: colors.muted, fontWeight: '600' },
  saveTextActive: { color: '#10141c' },
  warningCard: { borderColor: colors.warning, backgroundColor: colors.warningSoft },
  warningTitle: { color: colors.warning, fontSize: 14, fontWeight: '700' },
  warningText: { color: colors.text, fontSize: 12, lineHeight: 18 },
  maintenanceOn: { borderColor: colors.warning, backgroundColor: colors.warningSoft }
})
