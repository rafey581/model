import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { ReactNode } from 'react'
import { colors, radius, spacing, statusTone } from '@/theme'

/**
 * The small set of primitives the screens are built from.
 *
 * Deliberately not a component library: six controls, styled once, so every
 * screen looks the same without repeating a StyleSheet.
 */

export function Screen({
  children,
  scroll = true,
  refreshing = false,
  onRefresh,
  contentStyle
}: {
  children: ReactNode
  scroll?: boolean
  refreshing?: boolean
  onRefresh?: () => void
  contentStyle?: ViewStyle
}): ReactNode {
  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[styles.scrollContent, contentStyle]}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, contentStyle]}>{children}</View>
  )
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      {body}
    </SafeAreaView>
  )
}

export function ScreenTitle({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }): ReactNode {
  return (
    <View style={styles.titleRow}>
      <View style={styles.flex}>
        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  )
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }): ReactNode {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{children}</Text>
      {right}
    </View>
  )
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }): ReactNode {
  return <View style={[styles.card, style]}>{children}</View>
}

export function Row({ label, value, valueStyle }: { label: string; value: ReactNode; valueStyle?: object }): ReactNode {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={[styles.kvValue, valueStyle]} selectable>
        {value}
      </Text>
    </View>
  )
}

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'subtle'

export function Button({
  label,
  onPress,
  variant = 'ghost',
  disabled = false,
  loading = false,
  style
}: {
  label: string
  onPress: () => void
  variant?: ButtonVariant
  disabled?: boolean
  loading?: boolean
  style?: ViewStyle
}): ReactNode {
  const palette = BUTTON_VARIANTS[variant]
  const inactive = disabled || loading
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive }}
      onPress={inactive ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: palette.bg, borderColor: palette.border },
        pressed && !inactive ? styles.buttonPressed : null,
        inactive ? styles.buttonDisabled : null,
        style
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={palette.text} />
      ) : (
        <Text style={[styles.buttonText, { color: palette.text }]}>{label}</Text>
      )}
    </Pressable>
  )
}

const BUTTON_VARIANTS: Record<ButtonVariant, { bg: string; border: string; text: string }> = {
  primary: { bg: colors.accent, border: colors.accent, text: '#10141c' },
  ghost: { bg: 'transparent', border: colors.border, text: colors.text },
  danger: { bg: colors.negativeSoft, border: colors.negative, text: colors.negative },
  subtle: { bg: colors.surfaceAlt, border: colors.surfaceAlt, text: colors.text }
}

export function Pill({ label, tone }: { label: string; tone?: string }): ReactNode {
  const palette = statusTone(tone ?? label)
  return (
    <View style={[styles.pill, { backgroundColor: palette.bg, borderColor: palette.fg }]}>
      <Text style={[styles.pillText, { color: palette.fg }]}>{label}</Text>
    </View>
  )
}

export function StatCard({ label, value, tone }: { label: string; value: string; tone?: string }): ReactNode {
  const palette = tone ? statusTone(tone) : null
  return (
    <View style={styles.statCard}>
      <Text style={[styles.statValue, palette ? { color: palette.fg } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}

export function Loading({ label = 'Loading...' }: { label?: string }): ReactNode {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.accent} />
      <Text style={styles.muted}>{label}</Text>
    </View>
  )
}

export function Empty({ label, hint }: { label: string; hint?: string }): ReactNode {
  return (
    <View style={styles.center}>
      <Text style={styles.muted}>{label}</Text>
      {hint ? <Text style={[styles.muted, styles.hint]}>{hint}</Text> : null}
    </View>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }): ReactNode {
  return (
    <Card style={styles.errorCard}>
      <Text style={styles.errorText}>{message}</Text>
      {onRetry ? <Button label="Retry" onPress={onRetry} /> : null}
    </Card>
  )
}

export function Divider(): ReactNode {
  return <View style={styles.divider} />
}

export function Field({
  label,
  hint,
  ...inputProps
}: { label: string; hint?: string } & TextInputProps): ReactNode {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        {...inputProps}
      />
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  )
}

export const uiStyles = StyleSheet.create({
  muted: { color: colors.muted }
})

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safe: { flex: 1, backgroundColor: colors.background },
  scrollContent: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: 13, marginTop: 2 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  sectionTitle: { color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.sm
  },
  kvRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 3 },
  kvLabel: { color: colors.muted, fontSize: 13 },
  kvValue: { color: colors.text, fontSize: 13, flexShrink: 1, textAlign: 'right' },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingVertical: 10,
    paddingHorizontal: spacing.lg,
    minHeight: 42
  },
  buttonPressed: { opacity: 0.7 },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { fontSize: 14, fontWeight: '600' },
  pill: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  pillText: { fontSize: 12, fontWeight: '600' },
  statCard: {
    flexGrow: 1,
    flexBasis: '47%',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: 2
  },
  statValue: { color: colors.text, fontSize: 26, fontWeight: '700' },
  statLabel: { color: colors.muted, fontSize: 12 },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xxl, gap: spacing.sm },
  muted: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  hint: { fontSize: 12 },
  errorCard: { borderColor: colors.negative },
  errorText: { color: colors.negative, fontSize: 14 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  field: { gap: 6 },
  fieldLabel: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 15
  },
  fieldHint: { color: colors.muted, fontSize: 12 }
})
