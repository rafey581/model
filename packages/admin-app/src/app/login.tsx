import { useState, type ReactNode } from 'react'
import { KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { activateTotp, login } from '@/lib/adminAuth'
import { apiBaseUrl } from '@/lib/config'
import { useAuth } from '@/auth/AuthContext'
import { Button, Field } from '@/components/ui'
import { colors, radius, spacing } from '@/theme'

/**
 * The staff sign-in.
 *
 * The flow is three steps, and the middle one only happens the first time an
 * account is used: email + password, then authenticator enrollment, then the
 * session. The code field is shown from the start rather than after a probe,
 * because the server returns the same "invalid credentials" whether the password
 * was wrong or the code was simply missing - the client cannot tell them apart,
 * so it must not pretend to.
 */
export default function LoginScreen(): ReactNode {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enrollment, setEnrollment] = useState<{ token: string; secret: string; otpauth?: string } | null>(null)

  const submitCredentials = async (): Promise<void> => {
    setError(null)
    if (!email.trim() || !password) {
      setError('Enter your email and password.')
      return
    }
    if (totp.length > 0 && !/^\d{6}$/.test(totp.trim())) {
      setError('The authenticator code is six digits.')
      return
    }
    setBusy(true)
    try {
      const result = await login(email.trim(), password, totp.trim() || undefined)
      if (result.requiresTotp && result.enrollToken && result.secret) {
        setEnrollment({ token: result.enrollToken, secret: result.secret, otpauth: result.otpauth })
        return
      }
      if (!result.token || !result.user) {
        setError('Sign-in did not return a session. Try again.')
        return
      }
      await signIn(result.token, result.user)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const submitEnrollment = async (): Promise<void> => {
    if (!enrollment) return
    setError(null)
    if (!/^\d{6}$/.test(totp.trim())) {
      setError('Enter the six-digit code from your authenticator.')
      return
    }
    setBusy(true)
    try {
      const result = await activateTotp(enrollment.token, totp.trim())
      if (!result.token || !result.user) {
        setError('Activation did not return a session. Try again.')
        return
      }
      await signIn(result.token, result.user)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <View style={styles.logo} />
            <Text style={styles.title}>Snooker Arena</Text>
            <Text style={styles.subtitle}>Staff access</Text>
          </View>

          <View style={styles.card}>
            {error ? <Text style={styles.error}>{error}</Text> : null}

            {enrollment ? (
              <>
                <Text style={styles.notice}>
                  This account needs a second factor. Add the key below to an authenticator app, then enter the code it shows.
                </Text>
                <View style={styles.secretBox}>
                  <Text style={styles.secretLabel}>Setup key</Text>
                  <Text style={styles.secretValue} selectable>
                    {enrollment.secret}
                  </Text>
                </View>
                {enrollment.otpauth ? (
                  <Button
                    label="Open in authenticator"
                    variant="subtle"
                    onPress={() => void Linking.openURL(enrollment.otpauth as string)}
                  />
                ) : null}
                <Field
                  label="Code from your app"
                  value={totp}
                  onChangeText={setTotp}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="000000"
                />
                <Button label="Activate" variant="primary" onPress={submitEnrollment} loading={busy} />
              </>
            ) : (
              <>
                <Field
                  label="Email"
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  textContentType="username"
                  placeholder="admin@example.com"
                />
                <Field
                  label="Password"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  textContentType="password"
                  placeholder="Your password"
                />
                <Field
                  label="Authenticator code"
                  value={totp}
                  onChangeText={setTotp}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="000000"
                  hint="Leave blank only if you have not enrolled an authenticator yet."
                />
                <Button label="Sign in" variant="primary" onPress={submitCredentials} loading={busy} />
              </>
            )}
          </View>

          <Text style={styles.endpoint}>API: {apiBaseUrl()}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: { padding: spacing.xl, gap: spacing.xl, justifyContent: 'center', flexGrow: 1 },
  brand: { alignItems: 'center', gap: spacing.sm },
  logo: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.accent, borderWidth: 6, borderColor: colors.background },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: colors.muted, fontSize: 13 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md
  },
  error: { color: colors.negative, fontSize: 13 },
  notice: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  secretBox: { backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, padding: spacing.md, gap: spacing.xs },
  secretLabel: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  secretValue: { color: colors.accent, fontSize: 16, fontWeight: '700', letterSpacing: 2 },
  endpoint: { color: colors.muted, fontSize: 11, textAlign: 'center' }
})
