import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsStore } from '../src/main/storage/settings'
import { CaptureController, probeLevel, type CaptureOptions } from '../src/renderer/lib/audio'
import { km } from '../src/renderer/lib/api'

vi.mock('../src/renderer/lib/api', () => ({
  km: { sendAudio: vi.fn(), sendAudioStatus: vi.fn(), sendLevel: vi.fn() }
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

const opts: CaptureOptions = {
  sessionId: 'session',
  micDeviceId: null,
  systemDeviceId: null,
  captureMic: false,
  captureSystem: true
}

describe('remote audio source', () => {
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
  let onPcm: { onmessage: ((event: { data: Float32Array }) => void) | null }
  let close: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    input = stream('sonar-stream')
    loopback = stream('System audio', true)
    media = {
      getUserMedia: vi.fn().mockResolvedValue(input),
      getDisplayMedia: vi.fn().mockResolvedValue(loopback),
      enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'audioinput', deviceId: 'sonar-stream' }]),
      addEventListener: vi.fn((_event, callback) => {
        devicechange = callback
      }),
      removeEventListener: vi.fn()
    }
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
        createAnalyser() {
          return { fftSize: 1024 }
        }
      }
    )
    vi.stubGlobal(
      'AudioWorkletNode',
      class {
        port = { onmessage: null }
        constructor() {
          onPcm = this.port
        }
      }
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('keeps loopback as the default and stops its video track', async () => {
    const capture = new CaptureController()
    await capture.start(opts)
    expect(media.getDisplayMedia).toHaveBeenCalledWith({ audio: true, video: true })
    expect(media.getUserMedia).not.toHaveBeenCalled()
    expect(loopback.getVideoTracks()[0].stop).toHaveBeenCalledOnce()
    expect(loopback.removeTrack).toHaveBeenCalledWith(loopback.getVideoTracks()[0])
    await capture.stop()
    expect(loopback.getAudioTracks()[0].stop).toHaveBeenCalledOnce()
  })

  it('captures the exact mixer input without microphone DSP and labels its PCM as remote', async () => {
    const capture = new CaptureController()
    await capture.start({ ...opts, systemDeviceId: 'sonar-stream' })
    expect(media.getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: 'sonar-stream' }, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    })
    expect(media.getDisplayMedia).not.toHaveBeenCalled()
    expect(km.sendAudioStatus).toHaveBeenCalledWith({ source: 'remote', state: 'ok', label: 'sonar-stream' })
    for (let i = 0; i < 20; i++) onPcm.onmessage!({ data: new Float32Array(320).fill(0.1) })
    await capture.stop()
    expect(km.sendAudio).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session', source: 'remote', final: true }))
    expect(input.getAudioTracks()[0].stop).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([null, 'sonar-stream'])('probes the same remote source (%s) and releases it', async (deviceId) => {
    await probeLevel('remote', deviceId, 0)
    expect(media.getUserMedia).toHaveBeenCalledTimes(deviceId ? 1 : 0)
    expect(media.getDisplayMedia).toHaveBeenCalledTimes(deviceId ? 0 : 1)
    if (deviceId)
      expect(media.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.objectContaining({ deviceId: { exact: deviceId } }) }))
    expect((deviceId ? input : loopback).getAudioTracks()[0].stop).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('reports a missing selected input without falling back to a different source', async () => {
    media.getUserMedia.mockRejectedValue(new DOMException('Device not found', 'NotFoundError'))
    const capture = new CaptureController()
    await capture.start({ ...opts, systemDeviceId: 'sonar-stream' })
    expect(km.sendAudioStatus).toHaveBeenCalledWith(expect.objectContaining({ source: 'remote', state: 'error' }))
    await expect(probeLevel('remote', 'sonar-stream', 0)).rejects.toThrow('Device not found')
    expect(media.getDisplayMedia).not.toHaveBeenCalled()
    await capture.stop()
  })

  it('keeps a selected input across output changes and reconnects that input when it returns', async () => {
    vi.useFakeTimers()
    const capture = new CaptureController()
    await capture.start({ ...opts, systemDeviceId: 'sonar-stream' })
    media.enumerateDevices.mockResolvedValue([
      { kind: 'audioinput', deviceId: 'sonar-stream' },
      { kind: 'audiooutput', deviceId: 'new-headphones' }
    ])
    devicechange()
    await vi.advanceTimersByTimeAsync(500)
    expect(media.getUserMedia).toHaveBeenCalledTimes(1)

    media.enumerateDevices.mockResolvedValue([])
    media.getUserMedia.mockRejectedValueOnce(new DOMException('Device not found', 'NotFoundError'))
    devicechange()
    await vi.advanceTimersByTimeAsync(500)
    expect(input.getAudioTracks()[0].stop).toHaveBeenCalledOnce()
    expect(km.sendAudioStatus).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'remote', state: 'error' }))

    input = stream('sonar-stream')
    media.getUserMedia.mockResolvedValue(input)
    media.enumerateDevices.mockResolvedValue([{ kind: 'audioinput', deviceId: 'sonar-stream' }])
    devicechange()
    devicechange()
    await vi.advanceTimersByTimeAsync(500)
    expect(media.getUserMedia).toHaveBeenCalledTimes(3)
    expect(km.sendAudioStatus).toHaveBeenLastCalledWith({ source: 'remote', state: 'ok', label: 'sonar-stream' })
    expect(media.getDisplayMedia).not.toHaveBeenCalled()
    await capture.stop()
  })

  it('does not restart a selected input after pausing during a reconnect', async () => {
    vi.useFakeTimers()
    const capture = new CaptureController()
    await capture.start({ ...opts, systemDeviceId: 'sonar-stream' })
    media.enumerateDevices.mockResolvedValue([])
    devicechange()
    await vi.advanceTimersByTimeAsync(0)
    await capture.pause()
    await vi.advanceTimersByTimeAsync(500)
    expect(media.getUserMedia).toHaveBeenCalledTimes(1)
    expect(media.removeEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function))
    await capture.stop()
  })

  it('releases an input opened after the session has already stopped', async () => {
    let resolveInput!: (value: ReturnType<typeof stream>) => void
    media.getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        resolveInput = resolve
      })
    )
    const capture = new CaptureController()
    const starting = capture.start({ ...opts, systemDeviceId: 'sonar-stream' })
    await vi.waitFor(() => expect(media.getUserMedia).toHaveBeenCalledOnce())
    await capture.stop()
    resolveInput(input)
    await starting
    expect(input.getAudioTracks()[0].stop).toHaveBeenCalledOnce()
    expect(media.addEventListener).not.toHaveBeenCalled()
    expect(km.sendAudioStatus).not.toHaveBeenCalledWith(expect.objectContaining({ source: 'remote', state: 'ok' }))
  })
})

it('preserves existing audio settings and saves the selected remote input across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-audio-'))
  const path = join(dir, 'settings.json')
  const providers = join(dir, 'providers.json')
  try {
    writeFileSync(path, JSON.stringify({ audio: { micDeviceId: 'my-mic', captureMic: false, captureSystem: true } }))
    const store = new SettingsStore(path, providers)
    expect(store.get().audio).toEqual({ micDeviceId: 'my-mic', systemDeviceId: null, captureMic: false, captureSystem: true })
    store.patch({ audio: { systemDeviceId: 'sonar-stream' } })
    expect(new SettingsStore(path, providers).get().audio).toEqual({
      micDeviceId: 'my-mic',
      systemDeviceId: 'sonar-stream',
      captureMic: false,
      captureSystem: true
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
