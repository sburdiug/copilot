import type { Source } from '@shared/types'
import { api, km } from './api'

const RATE = 16000
const FRAME = 320 // 20 ms

// I inline the worklet and load it from a Blob to keep the build single-file and CSP-checked.
const WORKLET = `
class Pcm extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${FRAME}); this.n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n === ${FRAME}) { this.port.postMessage(this.buf.slice(0)); this.n = 0 }
    }
    return true
  }
}
registerProcessor('km-pcm', Pcm)
`
let workletUrl: string | null = null

export interface VadConfig {
  startFrames: number
  hangoverFrames: number
  prerollFrames: number
  maxFrames: number
  partialEveryFrames: number
  minSpeechFrames: number
}

const VAD: VadConfig = {
  startFrames: 3,
  hangoverFrames: 35,
  prerollFrames: 15,
  maxFrames: 1000,
  partialEveryFrames: 50,
  minSpeechFrames: 15
}

export interface Utterance {
  id: string
  startAt: number
  pcm: Int16Array
}

/** Energy VAD with an adaptive noise floor: cheap, deterministic, good enough to cut turns for whisper. */
export class Vad {
  private noise = 0.003
  private run = 0
  private silence = 0
  private speech = 0
  private frames: Float32Array[] = []
  private preroll: Float32Array[] = []
  private active = false
  private sinceStart = 0
  private startAt = 0
  private id = ''

  constructor(
    private onPartial: (u: Utterance) => void,
    private onFinal: (u: Utterance) => void,
    private cfg: VadConfig = VAD
  ) {}

  push(frame: Float32Array, now: number): number {
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    const rms = Math.sqrt(sum / frame.length)
    if (!this.active) this.noise = rms < this.noise ? this.noise * 0.9 + rms * 0.1 : this.noise * 0.998 + rms * 0.002
    const startThr = Math.max(0.008, this.noise * 3)
    const keepThr = Math.max(0.005, this.noise * 2)
    if (!this.active) {
      this.preroll.push(frame)
      if (this.preroll.length > this.cfg.prerollFrames) this.preroll.shift()
      this.run = rms > startThr ? this.run + 1 : 0
      if (this.run >= this.cfg.startFrames) {
        this.active = true
        this.frames = [...this.preroll]
        this.preroll = []
        this.speech = this.run
        this.silence = 0
        this.sinceStart = 0
        this.startAt = now - this.frames.length * 20
        this.id = crypto.randomUUID()
      }
      return rms
    }
    this.frames.push(frame)
    this.sinceStart++
    if (rms > keepThr) {
      this.speech++
      this.silence = 0
    } else this.silence++
    if (this.silence >= this.cfg.hangoverFrames || this.frames.length >= this.cfg.maxFrames) {
      this.finish(this.silence >= this.cfg.hangoverFrames)
    } else if (this.sinceStart % this.cfg.partialEveryFrames === 0 && this.speech >= this.cfg.minSpeechFrames) {
      this.onPartial({ id: this.id, startAt: this.startAt, pcm: toInt16(this.frames) })
    }
    return rms
  }

  /** I flush on pause/stop so the last words are not lost. */
  flush(): void {
    if (this.active) this.finish(false)
  }

  private finish(trimTail: boolean): void {
    const keep = trimTail ? this.frames.slice(0, this.frames.length - Math.floor(this.cfg.hangoverFrames * 0.6)) : this.frames
    const u = { id: this.id, startAt: this.startAt, pcm: toInt16(keep) }
    const enough = this.speech >= this.cfg.minSpeechFrames
    this.active = false
    this.frames = []
    this.run = 0
    this.speech = 0
    this.silence = 0
    if (enough) this.onFinal(u)
  }
}

function toInt16(frames: Float32Array[]): Int16Array {
  const out = new Int16Array(frames.length * FRAME)
  let o = 0
  for (const f of frames) for (let i = 0; i < f.length; i++) out[o++] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)))
  return out
}

interface AudioCapture {
  deviceId: string | null
  label: string
  stop: () => Promise<void>
}

interface Channel extends AudioCapture {
  vad: Vad
  levelTimer: number
}

export interface CaptureOptions {
  sessionId: string
  micDeviceId: string | null
  systemDeviceId: string | null
  captureMic: boolean
  captureSystem: boolean
}

export class CaptureController {
  private channels: Partial<Record<Source, Channel>> = {}
  private opts: CaptureOptions | null = null
  private restarts: Record<Source, number> = { user: 0, remote: 0 }
  private reopening = new Set<Source>()
  private captureVersion = 0
  private active = false
  private outputSig: string | null = null
  private onDeviceChange = () => void this.handleDeviceChange().catch(() => {})

  async start(opts: CaptureOptions): Promise<void> {
    await this.stop()
    this.opts = opts
    this.active = true
    this.restarts = { user: 0, remote: 0 }
    if (opts.captureMic) await this.open('user')
    else km.sendAudioStatus({ source: 'user', state: 'off', label: 'выключен в настройках' })
    if (opts.captureSystem) await this.open('remote')
    else km.sendAudioStatus({ source: 'remote', state: 'off', label: 'выключен в настройках' })
    if (this.opts === opts) navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange)
  }

  async pause(): Promise<void> {
    const o = this.opts
    await this.stop()
    this.opts = o
    km.sendAudioStatus({ source: 'user', state: 'off', label: 'пауза' })
    km.sendAudioStatus({ source: 'remote', state: 'off', label: 'пауза' })
  }

  async resume(): Promise<void> {
    if (this.opts) await this.start(this.opts)
  }

  async stop(): Promise<void> {
    this.active = false
    this.captureVersion++
    navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange)
    for (const src of Object.keys(this.channels) as Source[]) await this.close(src, true)
    this.opts = null
  }

  private async open(source: Source): Promise<void> {
    const o = this.opts
    if (!o || !this.active) return
    const version = this.captureVersion
    try {
      const send = (u: Utterance, final: boolean) =>
        km.sendAudio({ sessionId: o.sessionId, utteranceId: u.id, source, pcm: u.pcm.buffer, startAt: u.startAt, endAt: Date.now(), final })
      const vad = new Vad(
        (u) => send(u, false),
        (u) => send(u, true)
      )
      let level = 0
      const capture = await openAudio(
        source,
        source === 'user' ? o.micDeviceId : o.systemDeviceId,
        (frame) => {
          level = Math.max(level * 0.85, vad.push(frame, Date.now()))
        },
        (why) => void this.reopen(source, why)
      )
      if (version !== this.captureVersion) {
        await capture.stop()
        return
      }
      const levelTimer = window.setInterval(() => km.sendLevel({ source, rms: level }), 100)
      this.channels[source] = { ...capture, vad, levelTimer }
      this.restarts[source] = 0
      if (source === 'remote' && !o.systemDeviceId) this.outputSig = outputSignature(await navigator.mediaDevices.enumerateDevices())
      km.sendAudioStatus({ source, state: 'ok', label: capture.label })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      km.sendAudioStatus({
        source,
        state: 'error',
        label: source === 'user' ? `микрофон недоступен: ${msg}. Выберите другое устройство в настройках` : `звук собеседника недоступен: ${msg}`
      })
    }
  }

  private async close(source: Source, flush: boolean): Promise<void> {
    const ch = this.channels[source]
    if (!ch) return
    delete this.channels[source]
    if (source === 'remote') this.outputSig = null
    if (flush) ch.vad.flush()
    clearInterval(ch.levelTimer)
    await ch.stop()
    km.sendLevel({ source, rms: 0 })
  }

  private async reopen(source: Source, why: string): Promise<void> {
    if (!this.opts || !this.active || this.reopening.has(source) || this.restarts[source]++ > 5) return
    const version = this.captureVersion
    this.reopening.add(source)
    try {
      await this.close(source, true)
      km.sendAudioStatus({ source, state: 'warn', label: `${why} — переподключаюсь…` })
      await new Promise((r) => setTimeout(r, 500))
      if (version === this.captureVersion) await this.open(source)
    } finally {
      this.reopening.delete(source)
    }
  }

  private async handleDeviceChange(): Promise<void> {
    if (!this.opts || !this.active) return
    const version = this.captureVersion
    const devices = await navigator.mediaDevices.enumerateDevices()
    if (!this.opts || version !== this.captureVersion) return
    const mic = this.channels.user
    if (mic) {
      const gone = !devices.some((d) => d.kind === 'audioinput' && d.deviceId === mic.deviceId)
      if (gone || !this.opts.micDeviceId) await this.reopen('user', 'смена микрофона')
    }
    if (!this.opts || version !== this.captureVersion) return
    const systemDeviceId = this.opts.systemDeviceId
    if (this.opts.captureSystem && systemDeviceId) {
      const outputs = await api.systemAudio.devices()
      if (!this.opts || version !== this.captureVersion) return
      const present = outputs.some((d) => d.id === systemDeviceId)
      if (present !== !!this.channels.remote) await this.reopen('remote', present ? 'устройство подключено' : 'устройство отключено')
    } else if (this.channels.remote) {
      const sig = outputSignature(devices)
      if (this.outputSig !== null && sig !== this.outputSig) await this.reopen('remote', 'смена устройства вывода')
      this.outputSig = sig
    }
  }
}

function outputSignature(devices: MediaDeviceInfo[]): string {
  const outs = devices.filter((d) => d.kind === 'audiooutput')
  const def = outs.find((d) => d.deviceId === 'default')
  return `${def?.groupId ?? ''}|${outs
    .map((d) => d.deviceId)
    .sort()
    .join(',')}`
}

async function openAudio(
  source: Source,
  deviceId: string | null,
  onFrame: (frame: Float32Array) => void,
  onEnded: (why: string) => void
): Promise<AudioCapture> {
  if (source === 'remote' && deviceId) {
    const token = crypto.randomUUID()
    const unsubscribe = km.onSystemAudio((message) => {
      if (message.token !== token) return
      if (message.error) onEnded(message.error)
      else if (message.pcm) onFrame(new Float32Array(message.pcm))
    })
    try {
      const { label } = await api.systemAudio.start(token, deviceId)
      return {
        deviceId,
        label,
        stop: async () => {
          unsubscribe()
          await api.systemAudio.stop(token)
        }
      }
    } catch (e) {
      unsubscribe()
      throw e
    }
  }
  const stream =
    source === 'user'
      ? await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        })
      : await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  let ctx: AudioContext | undefined
  try {
    for (const video of stream.getVideoTracks()) {
      video.stop()
      stream.removeTrack(video)
    }
    if (!stream.getAudioTracks().length) throw new Error('система не отдала аудиодорожку')
    ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' })
    if (!workletUrl) workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
    await ctx.audioWorklet.addModule(workletUrl)
    const node = new AudioWorkletNode(ctx, 'km-pcm')
    ctx.createMediaStreamSource(stream).connect(node)
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data)
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => onEnded('устройство отключено'))
    return {
      deviceId: stream.getAudioTracks()[0]?.getSettings().deviceId ?? null,
      label: source === 'remote' ? 'звук вывода по умолчанию (loopback)' : stream.getAudioTracks()[0]?.label || 'микрофон',
      stop: async () => {
        node.port.onmessage = null
        for (const track of stream.getTracks()) track.stop()
        await ctx!.close().catch(() => {})
      }
    }
  } catch (e) {
    for (const track of stream.getTracks()) track.stop()
    await ctx?.close().catch(() => {})
    throw e
  }
}

/** The probe opens exactly the same capture backend as a live session. */
export async function probeLevel(source: Source, deviceId: string | null, ms = 4000, onLevel?: (v: number) => void): Promise<number> {
  let max = 0
  let failure: string | null = null
  const capture = await openAudio(
    source,
    deviceId,
    (frame) => {
      let sum = 0
      for (const sample of frame) sum += sample * sample
      const rms = Math.sqrt(sum / frame.length)
      max = Math.max(max, rms)
      onLevel?.(rms)
    },
    (why) => {
      failure = why
    }
  )
  try {
    await new Promise((resolve) => setTimeout(resolve, ms))
    if (failure) throw new Error(failure)
    return max
  } finally {
    await capture.stop()
  }
}
