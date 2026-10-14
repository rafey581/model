import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radius, spacing } from '@/theme'

/**
 * A row of single-select chips, used for the deposit/withdrawal status filters.
 * Cheaper to reach with a thumb than a dropdown, and its state is obvious at a
 * glance.
 */
export function FilterChips<T extends string>({
  options,
  value,
  onChange
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <View style={styles.row}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            style={[styles.chip, active ? styles.chipActive : null]}
          >
            <Text style={[styles.label, active ? styles.labelActive : null]}>{option.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface
  },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  label: { color: colors.muted, fontSize: 13 },
  labelActive: { color: colors.accent, fontWeight: '700' }
})
