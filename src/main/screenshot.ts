import { desktopCapturer, screen } from 'electron'

export type Screenshot = {
  ok: boolean
  base64: string | null
  mimeType: 'image/png'
  error: string | null
}

// Uses Electron's desktopCapturer (DXGI Output Duplication under the hood) so
// AMD Adrenalin's screen-capture protection — which intercepts GDI BitBlt /
// CopyFromScreen — doesn't block us. Same path Zoom/Discord/Teams use.
export async function captureScreenshot(): Promise<Screenshot> {
  try {
    const display = screen.getPrimaryDisplay()
    // Use logical size; Electron upscales by scaleFactor automatically.
    const { width, height } = display.size
    const scaleFactor = display.scaleFactor || 1
    const thumbnailSize = {
      width: Math.max(1, Math.floor(width * scaleFactor)),
      height: Math.max(1, Math.floor(height * scaleFactor))
    }

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize,
      fetchWindowIcons: false
    })

    if (!sources.length) {
      throw new Error('desktopCapturer returned no screen sources')
    }

    const primary =
      sources.find((s) => s.display_id === String(display.id)) ?? sources[0]

    const png = primary.thumbnail.toPNG()
    if (!png || png.length === 0) {
      throw new Error('captured thumbnail was empty (likely blocked by GPU overlay)')
    }

    return {
      ok: true,
      base64: png.toString('base64'),
      mimeType: 'image/png',
      error: null
    }
  } catch (err) {
    return {
      ok: false,
      base64: null,
      mimeType: 'image/png',
      error: (err as Error).message
    }
  }
}
