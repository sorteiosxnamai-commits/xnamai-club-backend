import { createClient, type RedisClientType } from 'redis';

const memory = new Map<string, { expiresAt: number; value: string }>();
let redis: RedisClientType | null = null;
let redisFailed = false;

async function getRedis() {
  const url = process.env.REDIS_URL?.trim();
  if (!url || redisFailed) return null;
  if (redis?.isOpen) return redis;
  try {
    redis = createClient({ url });
    redis.on('error', (error) => {
      console.error('Redis:', error);
    });
    await redis.connect();
    return redis;
  } catch (error) {
    redisFailed = true;
    redis = null;
    console.error('Redis indisponível, usando cache em memória:', error);
    return null;
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const client = await getRedis();
  try {
    if (client) {
      const raw = await client.get(key);
      return raw ? JSON.parse(raw) as T : null;
    }
  } catch (error) {
    console.error('Falha ao ler cache Redis:', error);
  }
  const hit = memory.get(key);
  if (!hit || hit.expiresAt < Date.now()) {
    memory.delete(key);
    return null;
  }
  return JSON.parse(hit.value) as T;
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number) {
  const raw = JSON.stringify(value);
  memory.set(key, { value: raw, expiresAt: Date.now() + ttlSeconds * 1000 });
  const client = await getRedis();
  if (!client) return;
  try {
    await client.set(key, raw, { EX: ttlSeconds });
  } catch (error) {
    console.error('Falha ao gravar cache Redis:', error);
  }
}

export async function cacheDel(key: string) {
  memory.delete(key);
  const client = await getRedis();
  if (!client) return;
  try {
    await client.del(key);
  } catch (error) {
    console.error('Falha ao limpar cache Redis:', error);
  }
}
