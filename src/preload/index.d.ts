import type { McApi } from './index'

declare global {
  interface Window {
    mc: McApi
  }
}

export {}
