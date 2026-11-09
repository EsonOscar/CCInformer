import type { TelemetryReading, TelemetrySample, TelemetryState } from '../types'
import { ACTIONS } from './areas'
import { SHOWN_ERRORS, telemetrySpread, telemetryStatus } from './env/telemetry'
import { ago, duration } from './format'
import { ACCENT, Empty, Section } from './ui'
import type { Kit } from './ui'

export type TelemetryNav = { screenshot: () => void; offerFile: () => void }

const one = (n: number) => (Math.round(n * 10) / 10).toString()

// A Godot game's telemetry in Now › Env: its numbers while it runs, why there are none otherwise, its latest errors,
// and the two keys that offer a screenshot or the file to the prompt.
export const TelemetrySection = (k: Kit, t: TelemetryState, now: number, nav: TelemetryNav): JSX.Element => {
  const { Box, Text, Button } = k
  const r = t.reading
  const status = telemetryStatus(r, now)
  const last = r?.samples[r.samples.length - 1]
  const note = status === 'live' ? 'live' : status === 'stale' && last ? 'stopped' : ''
  return (
    <Box flexDirection="column">
      {Section(k, 'Game telemetry', note)}
      {status === 'absent' && Empty(k, 'Not installed. /ccinformer pack install-telemetry adds it to this game (it asks first).')}
      {status === 'waiting' && Empty(k, 'Waiting for the game: start it from the editor or with godot --path .')}
      {status === 'stale' && last && Empty(k, `No sample for ${duration(now - last.t)}: the game stopped, or it's paused in the debugger.`)}
      {status === 'broken' && r && (
        <Text color="error" wrap="wrap">
          {'  ' + r.note}
        </Text>
      )}
      {status === 'live' && r && last && Numbers(k, r, last)}
      {r && last && (
        <Box flexDirection="row" columnGap={2} marginLeft={1}>
          <Button key="telemetry-shot" plain hotkey={ACTIONS.now.screenshot} onPress={nav.screenshot}>
            <Text color={ACCENT}>Screenshot</Text>
          </Button>
          <Button key="telemetry-offer" plain hotkey={ACTIONS.now.telemetryToPrompt} onPress={nav.offerFile}>
            <Text color={ACCENT}>Add file to prompt</Text>
          </Button>
        </Box>
      )}
      {t.pendingShot && Empty(k, 'Taking a screenshot…')}
      {!t.pendingShot && r?.screenshot?.file && (
        <Text key="telemetry-last-shot" dimColor>
          {`  ${r.screenshot.file} · ${ago(now - r.screenshot.t)}`}
        </Text>
      )}
      {r && status !== 'broken' && status !== 'absent' && Errors(k, r.errorSource, r.errors, r.errorCount, now)}
    </Box>
  )
}

const Numbers = (k: Kit, r: TelemetryReading, last: TelemetrySample): JSX.Element => {
  const { Box, Text } = k
  const { fpsMin, slowestFrameMsMax } = telemetrySpread(r)
  const counts = [`${last.drawCalls.toLocaleString('en-US')} draw calls`, `${last.objects.toLocaleString('en-US')} objects`, ...(last.memMb ? [`${Math.round(last.memMb)} MB`] : [])]
  return (
    <Box flexDirection="column" marginLeft={1}>
      <Text key="telemetry-fps">{`${Math.round(last.fps)} fps · min ${Math.round(fpsMin)}`}</Text>
      {/* Godot's process time is the slowest frame of the last second, vsync wait included, not an average. */}
      <Text key="telemetry-frame">{`slowest frame ${one(last.slowestFrameMs)} ms · max ${one(slowestFrameMsMax)} · physics ${one(last.slowestPhysicsMs)} ms`}</Text>
      <Text key="telemetry-counts" dimColor>
        {counts.join(' · ')}
      </Text>
    </Box>
  )
}

const Errors = (k: Kit, source: 'logger' | 'none', errors: { t: number; msg: string }[], count: number, now: number): JSX.Element => {
  const { Box, Text } = k
  if (source === 'none') return Empty(k, 'Errors need Godot 4.5 or later.')
  if (!errors.length) return Empty(k, 'No errors since the game started.')
  return (
    <Box flexDirection="column">
      <Text dimColor>{`  Errors · ${count}`}</Text>
      {errors
        .slice(-SHOWN_ERRORS)
        .reverse()
        .map((e, i) => (
          <Text key={'telemetry-error-' + i} color="error" wrap="truncate-end">
            {`  ⚠ ${ago(now - e.t)}  ${e.msg.slice(0, 200)}`}
          </Text>
        ))}
    </Box>
  )
}
