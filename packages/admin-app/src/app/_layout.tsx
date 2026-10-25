import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { View, StyleSheet } from 'react-native'
import { AuthProvider, useAuth } from '@/auth/AuthContext'
import { ToastProvider } from '@/components/Toast'
import { DialogProvider } from '@/components/ActionDialog'
import { PendingCountsProvider } from '@/hooks/usePendingCounts'
import { Loading } from '@/components/ui'
import { colors } from '@/theme'

/**
 * The navigation shell.
 *
 * The session decides which half of the tree exists at all: while signed out the
 * only registered route is `login`, and once signed in the tabs and detail
 * screens replace it. `Stack.Protected` is what Expo Router provides for exactly
 * this, so there is no redirect flash and no way to deep-link into a staff screen
 * without a session.
 */
function RootNavigator() {
  const { ready, token } = useAuth()

  if (!ready) {
    return (
      <View style={styles.splash}>
        <Loading label="Checking session..." />
      </View>
    )
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        headerTitleStyle: { color: colors.text }
      }}
    >
      <Stack.Protected guard={token !== null}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="matches" options={{ headerShown: true, title: 'Matches' }} />
        <Stack.Screen name="match/[id]" options={{ headerShown: true, title: 'Match' }} />
        <Stack.Screen name="settings" options={{ headerShown: true, title: 'Settings' }} />
        <Stack.Screen name="fraud" options={{ headerShown: true, title: 'Fraud and ledger' }} />
        <Stack.Screen name="audit" options={{ headerShown: true, title: 'Admin audit log' }} />
        <Stack.Screen name="support/[id]" options={{ headerShown: true, title: 'Conversation' }} />
      </Stack.Protected>
      <Stack.Protected guard={token === null}>
        <Stack.Screen name="login" />
      </Stack.Protected>
    </Stack>
  )
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <PendingCountsProvider>
        <ToastProvider>
          <DialogProvider>
            <StatusBar style="light" />
            <RootNavigator />
          </DialogProvider>
        </ToastProvider>
      </PendingCountsProvider>
    </AuthProvider>
  )
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: colors.background, justifyContent: 'center' }
})
