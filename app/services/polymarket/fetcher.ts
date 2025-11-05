import env from '#start/env'
import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'
import { PolymarketServiceError, type RawEvent } from './types.js'

const DEFAULT_ENDPOINT = 'https://gamma-api.polymarket.com/events'

export function buildUrl(now: DateTime, windowHours: number): URL {
  const base = env.get('POLYMARKET_API_URL', DEFAULT_ENDPOINT)
  let url: URL

  try {
    url = new URL(base)
  } catch (error) {
    throw new PolymarketServiceError('Invalid POLYMARKET_API_URL', 500)
  }

  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/events'
  }

  url.searchParams.set('limit', '500')
  url.searchParams.set('closed', 'false')
  url.searchParams.set('active', 'true')
  url.searchParams.set('archived', 'false')

  // Tag 1 is "Sports", 64 is for "Esports", 102467 is for "Crypto 15 minutes", 102175 is for "Crypto 1 hour", 102531 is "Crypto 4H", 84 is for "Weather", 1013 is for "Earnings"
  for (const tagId of [1, 64, 102467, 102175, 102531, 84, 1013]) {
    url.searchParams.append('exclude_tag_id', tagId.toString())
  }
  const endDateMin = now.toISODate() ?? undefined
  const endDateMax = now.plus({ hours: windowHours }).toISODate() ?? undefined
  if (endDateMin) {
    url.searchParams.set('end_date_min', url.searchParams.get('end_date_min') ?? endDateMin)
  }
  if (endDateMax) {
    url.searchParams.set('end_date_max', url.searchParams.get('end_date_max') ?? endDateMax)
  }

  return url
}

export async function fetchEvents(url: URL): Promise<RawEvent[]> {
  let response: Response

  try {
    response = await fetch(url.toString(), {
      headers: {
        accept: 'application/json',
      },
    })
  } catch (error) {
    logger.warn({ error }, 'polymarket events fetch failed to reach endpoint')
    throw new PolymarketServiceError('Failed to reach Polymarket API')
  }

  if (!response.ok) {
    logger.warn({ status: response.status }, 'polymarket events fetch non-ok status')
    throw new PolymarketServiceError(
      `Polymarket API responded with status ${response.status}`,
      response.status >= 500 ? 502 : 500
    )
  }

  let body: unknown

  try {
    body = await response.json()
  } catch {
    logger.warn('polymarket events fetch invalid JSON')
    throw new PolymarketServiceError('Failed to parse Polymarket API response', 500)
  }

  if (Array.isArray(body)) {
    return body
  }

  if (body && typeof body === 'object') {
    const events = (body as Record<string, unknown>).events
    if (Array.isArray(events)) {
      return events
    }

    const markets = (body as Record<string, unknown>).markets
    if (Array.isArray(markets)) {
      return markets
    }
  }

  logger.warn('polymarket events fetch unexpected payload shape')
  throw new PolymarketServiceError('Polymarket API returned an unexpected payload', 500)
}
