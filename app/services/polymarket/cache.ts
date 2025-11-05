import { DateTime } from 'luxon'

interface CacheEntry {
  payload: unknown
  expiresAt: DateTime
}

const CACHE_TTL_SECONDS = 60

export class MarketCache {
  private cache: Record<string, CacheEntry | undefined> = {}

  lookup<T>(key: string, now: DateTime): T | null {
    const entry = this.cache[key]

    if (!entry) {
      return null
    }

    if (entry.expiresAt <= now) {
      this.cache[key] = undefined
      return null
    }

    return entry.payload as T
  }

  set(key: string, payload: unknown, now: DateTime): void {
    this.cache[key] = {
      payload,
      expiresAt: now.plus({ seconds: CACHE_TTL_SECONDS }),
    }
  }

  clear(): void {
    this.cache = {}
  }
}

export const CACHE_KEY_OPPORTUNITIES = 'opportunities'
export const CACHE_KEY_FLIPPED = 'flipped'
export const CACHE_KEY_VELOCITY = 'velocity'
