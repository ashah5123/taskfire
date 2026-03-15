import { useEffect, useRef, useState, useCallback } from 'react'
import type { LiveMetrics } from '../types/job'

type WSMessage =
  | { type: 'connected'; payload: { message: string } }
  | { type: 'metrics'; payload: LiveMetrics }
  | { type: 'pong' }

export function useWebSocket() {
  const ws = useRef<WebSocket | null>(null)
  const [metrics, setMetrics] = useState<LiveMetrics | null>(null)
  const [connected, setConnected] = useState(false)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connect = useCallback(() => {
    const url = (import.meta.env.VITE_WS_URL || 'ws://localhost:3001') + '/ws'
    const socket = new WebSocket(url)
    ws.current = socket

    socket.onopen = () => setConnected(true)

    socket.onmessage = (ev) => {
      try {
        const msg: WSMessage = JSON.parse(ev.data)
        if (msg.type === 'metrics') setMetrics(msg.payload)
      } catch {
        // ignore
      }
    }

    socket.onclose = () => {
      setConnected(false)
      reconnectTimer.current = setTimeout(connect, 3000)
    }

    socket.onerror = () => socket.close()
  }, [])

  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      ws.current?.close()
    }
  }, [connect])

  const ping = useCallback(() => {
    ws.current?.send(JSON.stringify({ type: 'ping' }))
  }, [])

  return { metrics, connected, ping }
}
