import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NativeLoopback } from '../src/main/audio/loopback'

const helper = resolve('resources/bin/loopback.exe')
describe.skipIf(process.platform !== 'win32' || !existsSync(helper))('Windows playback loopback', () => {
  it('enumerates render endpoints, rejects a microphone ID and streams 16 kHz mono float frames', async ({ skip }) => {
    const audio = new NativeLoopback(helper)
    const devices = await audio.devices()
    if (!devices.length) skip()
    expect(devices.every((d) => d.id.startsWith('{0.0.0.00000000}.'))).toBe(true)
    await expect(audio.start('invalid', '{0.0.1.00000000}.{microphone}', () => {})).rejects.toThrow('недоступно')
    await expect(audio.start('../invalid-token', devices[0].id, () => {})).rejects.toThrow('Недопустимый ID')
    const samples: Float32Array[] = []
    let failure: string | undefined
    try {
      const started = await audio.start('native-test', devices[0].id, (message) => {
        if (message.pcm) samples.push(new Float32Array(message.pcm))
        failure = message.error
      })
      expect(started.label).toBe(devices[0].label)
      await expect.poll(() => samples.length, { timeout: 3000 }).toBeGreaterThan(0)
      expect(samples.every((frame) => frame.length === 320 && frame.every(Number.isFinite))).toBe(true)
      expect(failure).toBeUndefined()
    } finally {
      await audio.stop('native-test')
      audio.stopAll()
    }
  })
})

it('cancels a pending device lookup when the capture owner closes', async () => {
  const audio = new NativeLoopback(helper)
  let resolveDevices!: (devices: { id: string; label: string }[]) => void
  vi.spyOn(audio, 'devices').mockReturnValueOnce(
    new Promise((resolve) => {
      resolveDevices = resolve
    })
  )
  const start = audio.start('cancelled', 'output', () => {})
  audio.stopAll()
  resolveDevices([{ id: 'output', label: 'Headphones' }])
  await expect(start).rejects.toThrow('Захват отменён')
})
