import { useState, type ReactNode } from 'react'
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native'
import { TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import type { FrameState } from '@snooker/shared'
import { colors, radius, spacing } from '@/theme'
import { ballColor } from '@/lib/replay'

/**
 * Draws a table state with plain Views.
 *
 * The web panel used a canvas; there is no canvas on React Native, and pulling in
 * Skia or SVG for forty circles is not worth the native dependency. Positions are
 * in table millimetres and are scaled to the measured width, so the same frame
 * renders identically at any size.
 */

const RAIL = 8
// Real ball radius is ~26mm against a 3569mm table. The ratio keeps the balls in
// proportion instead of a fixed pixel size that only looks right on one screen.
const BALL_RADIUS_RATIO = 27 / TABLE_LENGTH

export function ReplayTable({ frame }: { frame: FrameState }): ReactNode {
  const [width, setWidth] = useState(0)

  const onLayout = (event: LayoutChangeEvent): void => {
    setWidth(event.nativeEvent.layout.width)
  }

  const clothWidth = Math.max(0, width - RAIL * 2)
  const clothHeight = clothWidth * (TABLE_WIDTH / TABLE_LENGTH)
  const scale = clothWidth > 0 ? clothWidth / TABLE_LENGTH : 0
  const ballRadius = Math.max(3, clothWidth * BALL_RADIUS_RATIO)

  return (
    <View style={styles.rail} onLayout={onLayout}>
      <View style={[styles.cloth, { width: clothWidth, height: clothHeight }]}>
        {scale > 0
          ? frame.balls.map((ball) => {
              if (ball.potted) return null
              const size = ballRadius * 2
              const left = ball.pos.x * scale - ballRadius
              const top = ball.pos.y * scale - ballRadius
              if (left + size < 0 || top + size < 0 || left > clothWidth || top > clothHeight) return null
              return (
                <View
                  key={ball.id}
                  style={[
                    styles.ball,
                    {
                      left,
                      top,
                      width: size,
                      height: size,
                      borderRadius: ballRadius,
                      backgroundColor: ballColor(ball.id),
                      borderColor: ball.isCue ? '#ffffff' : 'rgba(0,0,0,0.35)'
                    }
                  ]}
                >
                  {!ball.isCue ? <View style={[styles.highlight, { width: size * 0.3, height: size * 0.3, borderRadius: size * 0.15 }]} /> : null}
                </View>
              )
            })
          : null}
      </View>
    </View>
  )
}

/** A compact legend pairing each visible colour with its score value is overkill;
 * this is just the empty-state used while a frame has not loaded yet. */
export function ReplayTablePlaceholder({ label }: { label: string }): ReactNode {
  return (
    <View style={styles.placeholder}>
      <Text style={styles.placeholderText}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  rail: {
    backgroundColor: colors.clothRail,
    borderRadius: radius.md,
    padding: RAIL,
    alignItems: 'center',
    justifyContent: 'center'
  },
  cloth: { backgroundColor: colors.cloth, borderRadius: radius.sm, overflow: 'hidden' },
  ball: { position: 'absolute', borderWidth: 1 },
  highlight: { position: 'absolute', top: '22%', left: '22%', backgroundColor: 'rgba(255,255,255,0.55)' },
  placeholder: {
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md
  },
  placeholderText: { color: colors.muted, fontSize: 13, paddingHorizontal: spacing.lg, textAlign: 'center' }
})
