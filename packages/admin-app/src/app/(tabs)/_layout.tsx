import { Tabs } from 'expo-router/js-tabs'
import { Ionicons } from '@expo/vector-icons'
import type { ColorValue } from 'react-native'
import { colors } from '@/theme'

/**
 * The five things an admin does most, one tap apart.
 *
 * Deposits and withdrawals are their own tabs because approving money is the job;
 * everything rarer (matches, settings, fraud, audit, sign out) lives behind More.
 */
type IconName = keyof typeof Ionicons.glyphMap

const icon = (name: IconName, focusedName: IconName) =>
  function TabIcon({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) {
    return <Ionicons name={focused ? focusedName : name} color={color} size={size} />
  }

export default function TabsLayout() {
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
        options={{ title: 'Dashboard', tabBarIcon: icon('grid-outline', 'grid') }}
      />
      <Tabs.Screen
        name="deposits"
        options={{ title: 'Deposits', tabBarIcon: icon('arrow-down-circle-outline', 'arrow-down-circle') }}
      />
      <Tabs.Screen
        name="withdrawals"
        options={{ title: 'Withdrawals', tabBarIcon: icon('arrow-up-circle-outline', 'arrow-up-circle') }}
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
