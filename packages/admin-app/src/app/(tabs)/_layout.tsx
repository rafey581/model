import { Tabs } from 'expo-router/js-tabs'
import { Ionicons } from '@expo/vector-icons'
import type { ColorValue } from 'react-native'
import { colors } from '@/theme'
import { badge, usePendingCounts } from '@/hooks/usePendingCounts'

/**
 * The things an admin does most, one tap apart.
 *
 * Deposits, withdrawals and support are their own tabs because money and people
 * waiting are the job, and each carries a badge with what is waiting; everything
 * rarer (matches, settings, fraud, audit, sign out) lives behind More.
 */
type IconName = keyof typeof Ionicons.glyphMap

const icon = (name: IconName, focusedName: IconName) =>
  function TabIcon({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) {
    return <Ionicons name={focused ? focusedName : name} color={color} size={size} />
  }

export default function TabsLayout() {
  const { counts } = usePendingCounts()
  const badgeStyle = { backgroundColor: colors.accent, color: '#10141c', fontSize: 10, fontWeight: '700' as const }
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border
        },
        tabBarLabelStyle: { fontSize: 11 }
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Home', tabBarIcon: icon('grid-outline', 'grid') }}
      />
      <Tabs.Screen
        name="deposits"
        options={{
          title: 'Deposits',
          tabBarIcon: icon('arrow-down-circle-outline', 'arrow-down-circle'),
          tabBarBadge: badge(counts.deposits),
          tabBarBadgeStyle: badgeStyle
        }}
      />
      <Tabs.Screen
        name="withdrawals"
        options={{
          title: 'Payouts',
          tabBarIcon: icon('arrow-up-circle-outline', 'arrow-up-circle'),
          tabBarBadge: badge(counts.withdrawals),
          tabBarBadgeStyle: badgeStyle
        }}
      />
      <Tabs.Screen
        name="support"
        options={{
          title: 'Support',
          tabBarIcon: icon('chatbubbles-outline', 'chatbubbles'),
          tabBarBadge: badge(counts.support),
          tabBarBadgeStyle: badgeStyle
        }}
      />
      <Tabs.Screen
        name="users"
        options={{ title: 'Users', tabBarIcon: icon('people-outline', 'people') }}
      />
      <Tabs.Screen
        name="more"
        options={{ title: 'More', tabBarIcon: icon('ellipsis-horizontal-circle-outline', 'ellipsis-horizontal-circle') }}
      />
    </Tabs>
  )
}
