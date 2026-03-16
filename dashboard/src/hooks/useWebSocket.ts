import { useCallback, useEffect, useRef, useState } from 'react'
import type { JobEvent, LiveMetrics, WsMessage } from '../types/job'

// ── Constants ─────────────────────────────────────────────────────────────────

const WS_URL = (): string => {
  const base = (import.meta.env.VITE_WS_URL as string | undefined) ?? ''
  // In dev Vite proxies /ws to the API server; in production the env var
  // should point at the actual WebSocket origin (e.g. ws://api.example.com).
  if (base) return `${base}/ws`
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws`
}

const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS     = 30_000
const EVENT_HISTORY_CAP  = 100

// ── Types ─────────────────────────────────────────────────────────────────────

export type WsStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

export interface UseWebSocketReturn {
  status:         WsStatus
  connected:      boolean
  liveMetrics:    LiveMetrics | null
  snapshot:       LiveMetrics | null
  lastEvent:      JobEvent | null
  eventHistory:   JobEvent[]
  reconnectAttempt: number
  send:           (msg: Record<string, unknown>) => void
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useWebSocket(): UseWebSocketReturn {
  const wsRef              = useRef<WebSocket | null>(null)
  const reconnectTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptRef         = useRef(0)
  const unmountedRef       = useRef(false)

  const [status,           setStatus]           = useState<WsStatus>('idle')
  const [liveMetrics,      setLiveMetrics]      = useState<LiveMetrics | null>(null)
  const [snapshot,         setSnapshot]         = useState<LiveMetrics | null>(null)
  const [lastEvent,        setLastEvent]        = useState<JobEvent | null>(null)
  const [eventHistory,     setEventHistory]     = useState<JobEvent[]>([])
  const [reconnectAttempt, setReconnectAttempt] = useState(0)

  const scheduleReconnect = useCallback(() => {
    if (unmountedRef.current) return
    const delay = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attemptRef.current), MAX_BACKOFF_MS)
    attemptRef.current += 1
    setReconnectAttempt(attemptRef.current)
    setStatus('reconnecting')
    reconnectTimerRef.current = setTimeout(connect, delay) // eslint-disable-line @typescript-eslint/no-use-before-define
  }, []) // connect defined below with useCallback

  const connect = useCallback(() => {
    if (unmountedRef.current) return
    // Clean up any existing socket before creating a new one.
    wsRef.current?.close()

    setStatus('connecting')

    const socket = new WebSocket(WS_URL())
    wsRef.current = socket

    socket.onopen = () => {
      if (unmountedRef.current) { socket.close(); return }
      attemptRef.current = 0
      setReconnectAttempt(0)
      setStatus('connected')
    }

    socket.onmessage = (ev: MessageEvent<string>) => {
      if (unmountedRef.current) return
      let msg: WsMessage
      try {
        msg = JSON.parse(ev.data) as WsMessage
      } catch {
        return
      }

      switch (msg.type) {
        case 'snapshot':
          setSnapshot(msg.payload)
          setLiveMetrics(msg.payload)
          break

        case 'metrics':
          setLiveMetrics(msg.payload)
          break

        case 'job_event':
          setLastEvent(msg.payload)
          setEventHistory((prev) => {
            const next = [msg.payload, ...prev]
            return next.length > EVENT_HISTORY_CAP ? next.slice(0, EVENT_HISTORY_CAP) : next
          })
          break

        case 'connected':
        case 'pong':
        case 'error':
          // Handled at protocol level; no state change needed.
          break
      }
    }

    socket.onclose = (ev: CloseEvent) => {
      if (unmountedRef.current) return
      setStatus('disconnected')
      // 1000 = Normal Closure (e.g. server-initiated graceful shutdown).
      // 1001 = Going Away. Both warrant a reconnect attempt.
      if (!ev.wasClean || ev.code === 1000 || ev.code === 1001) {
        scheduleReconnect()
      }
    }

    socket.onerror = () => {
      // onerror is always followed by onclose, so we let onclose drive reconnect.
      socket.close()
    }
  }, [scheduleReconnect])

  useEffect(() => {
    unmountedRef.current = false
    connect()
    return () => {
      unmountedRef.current = true
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      wsRef.current?.close(1000, 'component unmounted')
    }
  }, [connect])

  const send = useCallback((msg: Record<string, unknown>) => {
    const socket = wsRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg))
    }
  }, [])

  return {
    status,
    connected: status === 'connected',
    liveMetrics,
    snapshot,
    lastEvent,
    eventHistory,
    reconnectAttempt,
    send,
  }
}
