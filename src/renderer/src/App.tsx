import { useState } from 'react'

export default function App(): JSX.Element {
  const [pong, setPong] = useState<string>('')

  async function ping(): Promise<void> {
    try {
      const result = await window.api.py.invoke('ping')
      setPong(JSON.stringify(result))
    } catch (e) {
      setPong(`error: ${(e as Error).message}`)
    }
  }

  return (
    <div className="app">
      <h1>MixCoach</h1>
      <p>Electron + React + Python sidecar scaffold.</p>
      <button onClick={ping}>Ping Python</button>
      {pong && <pre>{pong}</pre>}
    </div>
  )
}
