import { Redis } from 'ioredis';
import { config } from './config.js';

// One shared subscriber for Redis pub/sub (kept separate from the command connection).
let redis: Redis | undefined;
let subscriber: Redis | undefined;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
      reconnectOnError: () => true,
    });
    redis.on('error', (err) => console.error('Redis error:', err.message));
  }
  return redis;
}

export function getSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(config.redisUrl, {
      lazyConnect: false,
      enableOfflineQueue: true,
      reconnectOnError: () => true,
    });
    subscriber.on('error', (err) => console.error('Redis subscriber error:', err.message));
  }
  return subscriber;
}
