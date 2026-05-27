import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'

type Request = { method: string; params?: unknown }
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

let proc: ChildProcessWithoutNullStreams | null = null
let nextId = 1
const pending = new Map<number, Pending>()
let stdoutBuffer = ''

function pythonRoot(): string {
  // In dev: project_root/python. In prod: resources/python (configured via
  // electron-builder extraResources).
  return is.dev
    ? join(app.getAppPath(), 'python')
    : join(process.resourcesPath, 'python')
}

function pythonExecutable(): string {
  return process.env.MIXCOACH_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
}

export function startPythonSidecar(): void {
  if (proc) return

  const cwd = pythonRoot()
  proc = spawn(pythonExecutable(), ['main.py'], {
    cwd,
    env: { ...process.env, PYTHONPATH: join(cwd, 'src'), PYTHONUNBUFFERED: '1' }
  })

  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    let idx: number
    while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, idx).trim()
      stdoutBuffer = stdoutBuffer.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: string }
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const p = pending.get(msg.id)!
          pending.delete(msg.id)
          msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result)
        }
      } catch {
        console.error('[python] non-JSON line:', line)
      }
    }
  })

  proc.stderr.on('data', (chunk) => {
    console.error('[python stderr]', chunk.toString())
  })

  proc.on('exit', (code) => {
    console.log(`[python] exited with code ${code}`)
    for (const p of pending.values()) p.reject(new Error('python exited'))
    pending.clear()
    proc = null
  })
}

export function stopPythonSidecar(): void {
  if (!proc) return
  proc.kill()
  proc = null
}

export function sendToPython(req: Request): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!proc) return reject(new Error('python sidecar not running'))
    const id = nextId++
    pending.set(id, { resolve, reject })
    proc.stdin.write(JSON.stringify({ id, ...req }) + '\n')
  })
}
