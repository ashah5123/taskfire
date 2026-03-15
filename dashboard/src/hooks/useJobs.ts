import { useEffect, useState, useCallback } from 'react'
import { api } from '../api/client'
import type { Job } from '../types/job'

export function useJobs(params?: { status?: string; page?: number; limit?: number }) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.jobs.list(params)
      setJobs(data.jobs)
      setTotal(data.total)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [params?.status, params?.page, params?.limit])

  useEffect(() => {
    fetch()
    const interval = setInterval(fetch, 5000)
    return () => clearInterval(interval)
  }, [fetch])

  const retry = useCallback(async (id: string) => {
    await api.jobs.retry(id)
    fetch()
  }, [fetch])

  const cancel = useCallback(async (id: string) => {
    await api.jobs.cancel(id)
    fetch()
  }, [fetch])

  return { jobs, total, loading, error, refetch: fetch, retry, cancel }
}
