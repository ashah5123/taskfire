import { createClient, RedisClientType } from 'redis'

let client: RedisClientType

export async function getRedisClient(): Promise<RedisClientType> {
  if (client) return client
  client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' }) as RedisClientType
  client.on('error', (err) => console.error('Redis error:', err))
  await client.connect()
  return client
}

export async function enqueueJob(job: object): Promise<void> {
  const redis = await getRedisClient()
  const data = JSON.stringify(job)
  const priority = (job as any).priority ?? 0
  await redis.zAdd('taskfire:queue:default', [{ score: -priority, value: data }])
}

export async function getQueueDepth(queueName = 'default'): Promise<number> {
  const redis = await getRedisClient()
  return redis.zCard(`taskfire:queue:${queueName}`)
}

export async function getDLQDepth(): Promise<number> {
  const redis = await getRedisClient()
  return redis.lLen('taskfire:dlq')
}

export async function getRecentCompleted(limit = 100): Promise<string[]> {
  const redis = await getRedisClient()
  return redis.lRange('taskfire:done', 0, limit - 1)
}
