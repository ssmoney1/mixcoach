import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

type Listener<T> = (payload: T) => void
type Unsubscribe = () => void

function on<T>(channel: string, cb: Listener<T>): Unsubscribe {
  const handler = (_: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

type ChatMessage = { role: 'user' | 'assistant'; text: string }
type Mode = 'vocal' | 'beat' | 'both'

const api = {
  trigger: (mode: Mode = 'both') => ipcRenderer.invoke('mc:trigger', mode),
  setMode: (mode: Mode): Promise<boolean> => ipcRenderer.invoke('mc:setMode', mode),
  cancel: (): Promise<boolean> => ipcRenderer.invoke('mc:cancel'),
  hide: () => ipcRenderer.invoke('mc:hide'),
  quit: () => ipcRenderer.invoke('mc:quit'),
  getLastWav: (): Promise<ArrayBuffer | null> => ipcRenderer.invoke('mc:lastWav'),
  chat: (messages: ChatMessage[]): Promise<string> =>
    ipcRenderer.invoke('mc:chat', messages),
  pickReference: (): Promise<{
    ok: boolean
    cancelled?: boolean
    error?: string
    reference?: unknown
  }> => ipcRenderer.invoke('mc:pickReference'),
  getReference: (): Promise<unknown> => ipcRenderer.invoke('mc:getReference'),
  clearReference: (): Promise<boolean> => ipcRenderer.invoke('mc:clearReference'),
  onStart: (cb: Listener<{ startedAt: string }>) => on('mc:start', cb),
  onStatus: (cb: Listener<unknown>) => on('mc:status', cb),
  onResult: (cb: Listener<unknown>) => on('mc:result', cb),
  onError: (cb: Listener<{ message: string }>) => on('mc:error', cb),
  onCancelled: (cb: Listener<{ at: string }>) => on('mc:cancelled', cb),
  onMeter: (cb: Listener<{ peak_db?: number | null; rms_db?: number | null; error?: string }>) =>
    on('mc:meter', cb)
}

try {
  contextBridge.exposeInMainWorld('mc', api)
} catch (error) {
  console.error(error)
}

export type McApi = typeof api
