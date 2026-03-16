import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query'
import { api } from '../api/client'
import type { CreateJobInput, ListJobsParams, RetryJobInput } from '../types/job'

// ── Query key factory ─────────────────────────────────────────────────────────

export const jobKeys = {
  all:    ['jobs'] as const,
  list:   (params: ListJobsParams) => ['jobs', 'list', params] as const,
  detail: (id: string)             => ['jobs', 'detail', id]   as const,
  logs:   (id: string)             => ['jobs', 'logs', id]     as const,
}

// ── Job list hook ─────────────────────────────────────────────────────────────

export function useJobs(params: ListJobsParams = {}) {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey:       jobKeys.list(params),
    queryFn:        () => api.jobs.list(params),
    refetchInterval: 5_000,
    staleTime:       2_000,
    placeholderData: keepPreviousData,
  })

  const enqueueMutation = useMutation({
    mutationFn: (input: CreateJobInput) => api.jobs.create(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: jobKeys.all }),
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.jobs.cancel(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: jobKeys.all }),
  })

  const retryMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input?: RetryJobInput }) =>
      api.jobs.retry(id, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: jobKeys.all }),
  })

  return {
    jobs:       query.data?.jobs  ?? [],
    total:      query.data?.total ?? 0,
    pages:      query.data?.pages ?? 1,
    isLoading:  query.isLoading,
    isFetching: query.isFetching,
    error:      query.error,

    enqueueJob: enqueueMutation.mutateAsync,
    cancelJob:  cancelMutation.mutateAsync,
    retryJob:   (id: string, input?: RetryJobInput) => retryMutation.mutateAsync({ id, input }),

    isEnqueueing: enqueueMutation.isPending,
    isCancelling: cancelMutation.isPending,
    isRetrying:   retryMutation.isPending,
  }
}

// ── Single job hook ───────────────────────────────────────────────────────────

export function useJob(id: string) {
  return useQuery({
    queryKey:        jobKeys.detail(id),
    queryFn:         () => api.jobs.get(id),
    refetchInterval: 5_000,
    staleTime:       2_000,
    enabled:         Boolean(id),
  })
}

// ── Job logs hook ─────────────────────────────────────────────────────────────

export function useJobLogs(id: string) {
  return useQuery({
    queryKey: jobKeys.logs(id),
    queryFn:  () => api.jobs.getLogs(id),
    staleTime: 10_000,
    enabled:   Boolean(id),
  })
}
