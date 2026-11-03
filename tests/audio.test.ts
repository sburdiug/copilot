import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsStore } from '../src/main/storage/settings'
import { CaptureController, probeLevel, type CaptureOptions } from '../src/renderer/lib/audio'
import { api, km } from '../src/renderer/lib/api'
import type { SystemAudioMessage } from '../src/shared/types'

vi.mock('../src/renderer/lib/api', () => ({
  km: { sendAudio: vi.fn(), sendAudioStatus: vi.fn(), sendLevel: vi.fn(), onSystemAudio: vi.fn() },
  api: { systemAudio: { devices: vi.fn(), start: vi.fn(), stop: vi.fn() } }
}))

function stream(deviceId: string, video = false) {
  const audioTrack = { label: deviceId, getSettings: () => ({ deviceId }), addEventListener: vi.fn(), stop: vi.fn() }
  const videoTrack = { stop: vi.fn() }
  return {
    getAudioTracks: () => [audioTrack],
    getVideoTracks: () => (video ? [videoTrack] : []),
    getTracks: () => [audioTrack],
    removeTrack: vi.fn()
  }
}

const opts: CaptureOptions = { sessionId: 'session', micDeviceId: null, systemDeviceId: null, captureMic: false, captureSystem: true }

describe('remote playback device', () => {
  let input: ReturnType<typeof stream>
  let loopback: ReturnType<typeof stream>
  let media: {
    getUserMedia: ReturnType<typeof vi.fn>
    getDisplayMedia: ReturnType<typeof vi.fn>
    enumerateDevices: ReturnType<typeof vi.fn>
    addEventListener: ReturnType<typeof vi.fn>
    removeEventListener: ReturnType<typeof vi.fn>
  }
  let devicechange: () => void
  let onNative: (message: SystemAudioMessage) => void
  let unsubscribe: () => void
  let close: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    input = stream('my-mic')
    loopback = stream('System audio', true)
    media = {
      getUserMedia: vi.fn().mockResolvedValue(input),
      getDisplayMedia: vi.fn().mockResolvedValue(loopback),
      enumerateDevices: vi.fn().mockResolvedValue([]),
      addEventListener: vi.fn((_event, callback) => {
        devicechange = callback
      }),
      removeEventListener: vi.fn()
    }
    vi.mocked(api.systemAudio.devices).mockResolvedValue([{ id: 'sonar-chat', label: 'Sonar Chat (playback)' }])
    vi.mocked(api.systemAudio.start).mockResolvedValue({ label: 'Sonar Chat (playback)' })
    vi.mocked(api.systemAudio.stop).mockResolvedValue(undefined)
    unsubscribe = vi.fn()
    vi.mocked(km.onSystemAudio).mockImplementation((callback) => {
      onNative = callback
      return unsubscribe
    })
    close = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { mediaDevices: media })
    vi.stubGlobal('window', { setInterval: vi.fn(() => 0) })
    vi.stubGlobal(
      'AudioContext',
      class {
        audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }
        close = close
        createMediaStreamSource() {
          return { connect: vi.fn() }
        }
      }
    )
    vi.stubGlobal(
      'AudioWorkletNode',
      class {
        port = { onmessage: null }
      }
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('keeps automatic loopback and stops its video track', async () => {
    const capture = new CaptureController()
    await capture.start(opts)
    expect(media.getDisplayMedia).toHaveBeenCalledWith({ audio: true, video: true })
    expect(media.getUserMedia).not.toHaveBeenCalled()
    expect(api.systemAudio.start).not.toHaveBeenCalled()
    expect(loopback.getVideoTracks()[0].stop).toHaveBeenCalledOnce()
    await capture.stop()
    expect(loopback.getAudioTracks()[0].stop).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('captures a selected playback device through WASAPI, never as a microphone', async () => {
    const capture = new CaptureController()
    await capture.start({ ...opts, systemDeviceId: 'sonar-chat' })
    const token = vi.mocked(api.systemAudio.start).mock.calls[0][0]
    expect(api.systemAudio.start).toHaveBeenCalledWith(token, 'sonar-chat')
    expect(media.getUserMedia).not.toHaveBeenCalled()
    expect(media.getDisplayMedia).not.toHaveBeenCalled()
    expect(km.sendAudioStatus).toHaveBeenCalledWith({ source: 'remote', state: 'ok', label: 'Sonar Chat (playback)' })
    onNative({ token: 'another-probe', pcm: new Float32Array(320).fill(0.1).buffer })
    for (let i = 0; i < 20; i++) onNative({ token, pcm: new Float32Array(320).fill(0.1).buffer })
    await capture.stop()
    expect(km.sendAudio).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session', source: 'remote', final: true }))
    expect(api.systemAudio.stop).toHaveBeenCalledWith(token)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it.each([null, 'sonar-chat'])('probes the same backend (%s) and releases it', async (deviceId) => {
    await probeLevel('remote', deviceId, 0)
    expect(media.getUserMedia).not.toHaveBeenCalled()
    expect(media.getDisplayMedia).toHaveBeenCalledTimes(deviceId ? 0 : 1)
    expect(api.systemAudio.start).toHaveBeenCalledTimes(deviceId ? 1 : 0)
    if (deviceId) expect(api.systemAudio.stop).toHaveBeenCalledOnce()
    else expect(loopback.getAudioTracks()[0].stop).toHaveBeenCalledOnce()
  })

  it('keeps the user microphone separate with its existing speech processing', async () => {
    const capture = new CaptureController()
    await capture.start({ ...opts, captureMic: true, captureSystem: false, micDeviceId: 'my-mic' })
    expect(media.getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: 'my-mic' }, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    expect(api.systemAudio.start).not.toHaveBeenCalled()
    await capture.stop()
    expect(input.getAudioTracks()[0].stop).toHaveBeenCalledOnce()
  })

  it('reports an unavailable output without falling back to a microphone or default output', async () => {
    vi.mocked(api.systemAudio.start).mockRejectedValue(new Error('Playback device unavailable'))
    const capture = new CaptureController()
    await capture.start({ ...opts, systemDeviceId: 'missing-output' })
    expect(km.sendAudioStatus).toHaveBeenCalledWith(expect.objectContaining({ source: 'remote', state: 'error' }))
    await expect(probeLevel('remote', 'missing-output', 0)).rejects.toThrow('Playback device unavailable')
    expect(media.getUserMedia).not.toHaveBeenCalled()
    expect(media.getDisplayMedia).not.toHaveBeenCalled()
    await capture.stop()
  })

  it('reconnects the selected output once when it returns', async () => {
    vi.useFakeTimers()
    const capture = new CaptureController()
    await capture.start({ ...opts, systemDeviceId: 'sonar-chat' })
    devicechange()
    await vi.advanceTimersByTimeAsync(500)
    expect(api.systemAudio.start).toHaveBeenCalledTimes(1)
    vi.mocked(api.systemAudio.devices).mockResolvedValue([])
    vi.mocked(api.systemAudio.start).mockRejectedValueOnce(new Error('Playback device unavailable'))
    devicechange()
    await vi.advanceTimersByTimeAsync(500)
    expect(api.systemAudio.stop).toHaveBeenCalledOnce()
    vi.mocked(api.systemAudio.devices).mockResolvedValue([{ id: 'sonar-chat', label: 'Sonar Chat (playback)' }])
    devicechange()
    devicechange()
    await vi.advanceTimersByTimeAsync(500)
    expect(api.systemAudio.start).toHaveBeenCalledTimes(3)
    await capture.stop()
  })

  it('cancels a pending reconnect on pause', async () => {
    vi.useFakeTimers()
    const capture = new CaptureController()
    await capture.start({ ...opts, systemDeviceId: 'sonar-chat' })
    vi.mocked(api.systemAudio.devices).mockResolvedValue([])
    devicechange()
    await vi.advanceTimersByTimeAsync(0)
    await capture.pause()
    await vi.advanceTimersByTimeAsync(500)
    expect(api.systemAudio.start).toHaveBeenCalledTimes(1)
    await capture.stop()
  })

  it('ignores a device list that finishes loading after pause', async () => {
    vi.useFakeTimers()
    const capture = new CaptureController()
    await capture.start({ ...opts, systemDeviceId: 'sonar-chat' })
    let resolveDevices!: (devices: { id: string; label: string }[]) => void
    vi.mocked(api.systemAudio.devices).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDevices = resolve
      })
    )
    devicechange()
    await vi.advanceTimersByTimeAsync(0)
    await capture.pause()
    resolveDevices([{ id: 'sonar-chat', label: 'Sonar Chat (playback)' }])
    await vi.advanceTimersByTimeAsync(500)
    expect(api.systemAudio.start).toHaveBeenCalledTimes(1)
    await capture.stop()
  })

  it('releases a playback capture that opens after the session has stopped', async () => {
    let resolveStart!: (value: { label: string }) => void
    vi.mocked(api.systemAudio.start).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve
      })
    )
    const capture = new CaptureController()
    const starting = capture.start({ ...opts, systemDeviceId: 'sonar-chat' })
    await vi.waitFor(() => expect(api.systemAudio.start).toHaveBeenCalledOnce())
    await capture.stop()
    resolveStart({ label: 'Sonar Chat (playback)' })
    await starting
    expect(api.systemAudio.stop).toHaveBeenCalledOnce()
    expect(media.addEventListener).not.toHaveBeenCalled()
    expect(km.sendAudioStatus).not.toHaveBeenCalledWith(expect.objectContaining({ source: 'remote', state: 'ok' }))
  })
})

it('preserves existing settings and saves the selected playback endpoint across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-audio-'))
  const path = join(dir, 'settings.json')
  const providers = join(dir, 'providers.json')
  try {
    writeFileSync(path, JSON.stringify({ audio: { micDeviceId: 'my-mic', captureMic: false, captureSystem: true } }))
    const store = new SettingsStore(path, providers)
    expect(store.get().audio).toEqual({ micDeviceId: 'my-mic', systemDeviceId: null, captureMic: false, captureSystem: true })
    store.patch({ audio: { systemDeviceId: 'sonar-chat' } })
    expect(new SettingsStore(path, providers).get().audio.systemDeviceId).toBe('sonar-chat')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
