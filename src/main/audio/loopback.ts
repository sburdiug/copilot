import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import type { PlaybackDevice, SystemAudioMessage } from '@shared/types'

const exec = promisify(execFile)
const FRAME_BYTES = 320 * 4

export class NativeLoopback {
  private streams = new Map<string, ChildProcessWithoutNullStreams>()
  private version = 0

  constructor(private helper: string) {}

  async devices(): Promise<PlaybackDevice[]> {
    if (process.platform !== 'win32') return []
    const { stdout } = await exec(this.helper, ['--list'], { windowsHide: true, timeout: 5000, maxBuffer: 65536, encoding: 'utf8' })
    return JSON.parse(stdout) as PlaybackDevice[]
  }

  async start(token: string, deviceId: string, send: (message: SystemAudioMessage) => void): Promise<{ label: string }> {
    const version = this.version
    if (typeof token !== 'string' || !/^[\w-]{1,64}$/.test(token) || this.streams.has(token)) throw new Error('Недопустимый ID захвата')
    if (typeof deviceId !== 'string' || deviceId.length > 512) throw new Error('Недопустимое устройство вывода')
    const device = (await this.devices()).find((d) => d.id === deviceId)
    if (version !== this.version) throw new Error('Захват отменён')
    if (!device) throw new Error('Выбранное устройство воспроизведения недоступно')
    if (this.streams.has(token)) throw new Error('Захват уже запущен')
    const child = spawn(this.helper, ['--capture', deviceId], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.streams.set(token, child)
    child.stdin.on('error', () => {}) // A device can disappear while stop is closing its pipe; close reports the failure.
    let ready = false
    let stderr = ''
    let pending = Buffer.alloc(0)
    const flush = () => {
      while (ready && pending.length >= FRAME_BYTES) {
        const pcm = new Uint8Array(FRAME_BYTES)
        pcm.set(pending.subarray(0, FRAME_BYTES))
        pending = pending.subarray(FRAME_BYTES)
        send({ token, pcm: pcm.buffer })
      }
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error('Устройство вывода не отвечает'))
      }, 5000)
      child.stdout.on('data', (data: Buffer) => {
        pending = Buffer.concat([pending, data])
        flush()
      })
      child.stderr.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString('utf8')).slice(-4096)
        if (!ready && stderr.includes('READY\r\n')) {
          ready = true
          clearTimeout(timeout)
          resolve()
          flush()
        }
      })
      child.on('error', (e) => {
        clearTimeout(timeout)
        this.streams.delete(token)
        reject(e)
      })
      child.on('close', (code) => {
        clearTimeout(timeout)
        const active = this.streams.get(token) === child
        if (active) this.streams.delete(token)
        const error = stderr.replace('READY', '').trim() || `Захват устройства вывода завершился (${code})`
        if (!ready) reject(new Error(error))
        else if (active) send({ token, error })
      })
    })
    return { label: device.label }
  }

  async stop(token: string): Promise<void> {
    const child = this.streams.get(token)
    if (!child) return
    this.streams.delete(token)
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => child.kill(), 1000)
      child.once('close', () => {
        clearTimeout(timeout)
        resolve()
      })
      child.stdin.end('stop\n')
    })
  }

  stopAll(): void {
    this.version++
    for (const child of this.streams.values()) child.kill()
    this.streams.clear()
  }
}
