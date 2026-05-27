import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  py: {
    invoke: (method: string, params?: unknown) => ipcRenderer.invoke('py:invoke', method, params)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error context isolation off
  window.electron = electronAPI
  // @ts-expect-error context isolation off
  window.api = api
}

export type Api = typeof api
