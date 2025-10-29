import env from '#start/env'
import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'

export interface EventSummary {
  question: string
  endDate: string | null
  resolutionState: string | null
  tags: Array<{ id: string; label: string }>
  outcomes: string[]
  outcomePrices: number[]
  oneDayPriceChange: number | null
  oneWeekPriceChange: number | null
  oneMonthPriceChange: number | null
  timeToEnd: string | null
}

export interface EndingSoonResponse {
  meta: {
    fetchedAt: string
    count: number
    gammaUrl: string
    windowHours: number
  }
  data: EventSummary[]
}

class PolymarketServiceError extends Error {
  status: number

  constructor(message: string, status = 502) {
    super(message)
    this.status = status
  }
}

type RawEvent = Record<string, any>

interface CacheEntry {
  payload: EndingSoonResponse
  expiresAt: DateTime
}

const DEFAULT_ENDPOINT =
  'https://gamma-api.polymarket.com/events?limit=1000&sortKey=endDate&sortDir=asc'
const CACHE_KEY = 'ending-soon'
const CACHE_TTL_SECONDS = 60

interface EventCandidate extends EventSummary {
  hoursToClose: number | null
}

/**
 * Service responsible for retrieving and normalising Polymarket markets.
 */
export default class PolymarketService {
  /**
   * Simple in-memory cache scoped to the process.
   * Using a Record to allow extending to additional keys if needed.
   */
  private static cache: Record<string, CacheEntry | undefined> = {}

  static clearCache() {
    PolymarketService.cache = {}
  }

  constructor(private readonly nowFn: () => DateTime = () => DateTime.utc()) {}

  /**
   * Retrieve markets closing within the provided time window.
   */
  async getEndingSoon(windowHours = 72): Promise<EndingSoonResponse> {
    const now = this.nowFn()
    const cached = this.lookupCache(now)

    if (cached) {
      return cached
    }

    const requestUrl = this.buildUrl(now, windowHours)
    logger.debug({ url: requestUrl.toString() }, 'polymarket events fetch started')
    const data = await this.fetchEvents(requestUrl)
    const candidates = data
      .map((entry) => this.normaliseEvent(entry, now))
      .filter((event): event is EventCandidate => this.isWithinWindow(event, windowHours))
      .sort((a, b) => {
        if (!a.endDate || !b.endDate) {
          return 0
        }

        return DateTime.fromISO(a.endDate).toMillis() - DateTime.fromISO(b.endDate).toMillis()
      })

    const events: EventSummary[] = candidates.map((event) => ({
      question: event.question,
      endDate: event.endDate,
      resolutionState: event.resolutionState,
      tags: this.deduplicateTags(event.tags),
      outcomes: event.outcomes,
      outcomePrices: event.outcomePrices,
      oneDayPriceChange: event.oneDayPriceChange,
      oneWeekPriceChange: event.oneWeekPriceChange,
      oneMonthPriceChange: event.oneMonthPriceChange,
      timeToEnd: event.timeToEnd,
    }))

    const payload: EndingSoonResponse = {
      meta: {
        fetchedAt: now.toISO() ?? '',
        count: events.length,
        gammaUrl: requestUrl.toString(),
        windowHours,
      },
      data: events,
    }

    logger.debug({ count: events.length }, 'polymarket events fetch completed')

    this.setCache(payload, now)
    return payload
  }

  private lookupCache(now: DateTime): EndingSoonResponse | null {
    const entry = PolymarketService.cache[CACHE_KEY]

    if (!entry) {
      return null
    }

    if (entry.expiresAt <= now) {
      PolymarketService.cache[CACHE_KEY] = undefined
      return null
    }

    return entry.payload
  }

  private setCache(payload: EndingSoonResponse, now: DateTime) {
    PolymarketService.cache[CACHE_KEY] = {
      payload,
      expiresAt: now.plus({ seconds: CACHE_TTL_SECONDS }),
    }
  }

  private buildUrl(now: DateTime, windowHours: number): URL {
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

    url.searchParams.set('limit', url.searchParams.get('limit') ?? '1000')
    url.searchParams.set('closed', url.searchParams.get('closed') ?? 'false')
    url.searchParams.set('active', url.searchParams.get('active') ?? 'true')
    url.searchParams.set('archived', url.searchParams.get('archived') ?? 'false')
    // Tag 1 is "Sports"
    url.searchParams.set('exclude_tag_id', url.searchParams.get('exclude_tag_id') ?? '1')
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

  private async fetchEvents(url: URL): Promise<RawEvent[]> {
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

  private normaliseEvent(entry: RawEvent, now: DateTime): EventCandidate {
    const primaryMarket = this.pickPrimaryMarket(entry)
    const endDate = this.resolveEndDate(entry, primaryMarket)
    const hoursToClose = endDate ? this.computeHoursToClose(endDate, now) : null
    const timeToEnd = endDate ? this.computeTimeToEnd(endDate, now) : null

    const outcomes = this.parseStringList(primaryMarket?.outcomes ?? entry.outcomes)
    const outcomePrices = this.parseNumberList(primaryMarket?.outcomePrices ?? entry.outcomePrices)

    const tags = this.extractTags(entry, primaryMarket)

    const oneDayPriceChange = this.asNullableNumber(
      primaryMarket?.oneDayPriceChange ?? entry.oneDayPriceChange
    )
    const oneWeekPriceChange = this.asNullableNumber(
      primaryMarket?.oneWeekPriceChange ?? entry.oneWeekPriceChange
    )
    const oneMonthPriceChange = this.asNullableNumber(
      primaryMarket?.oneMonthPriceChange ?? entry.oneMonthPriceChange
    )

    const event: EventCandidate = {
      question: this.asString(
        entry.question ??
          entry.title ??
          entry.name ??
          primaryMarket?.question ??
          primaryMarket?.title
      ),
      endDate: endDate?.toISO() ?? null,
      hoursToClose,
      resolutionState: this.resolveResolutionState(entry, primaryMarket),
      tags,
      outcomes,
      outcomePrices,
      oneDayPriceChange,
      oneWeekPriceChange,
      oneMonthPriceChange,
      timeToEnd,
    }

    return event
  }

  private asString(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim().length > 0 ? value : ''
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }

    return ''
  }

  private asNullableString(value: unknown): string | null {
    if (typeof value === 'string') {
      return value.trim().length > 0 ? value : null
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
    return null
  }

  private asNullableNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }

    if (typeof value === 'string') {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : null
    }

    return null
  }

  private parseStringList(value: unknown): string[] {
    const items = this.parseUnknownArray(value)
    return items.reduce<string[]>((acc, item) => {
      if (typeof item === 'string') {
        acc.push(item)
      } else if (typeof item === 'number' || typeof item === 'boolean') {
        acc.push(String(item))
      }
      return acc
    }, [])
  }

  private parseNumberList(value: unknown): number[] {
    const items = this.parseUnknownArray(value)
    return items.reduce<number[]>((acc, item) => {
      const num = this.asNullableNumber(item)
      if (num !== null) {
        acc.push(num)
      }
      return acc
    }, [])
  }

  private parseUnknownArray(value: unknown): unknown[] {
    if (Array.isArray(value)) {
      return value
    }

    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }

    return []
  }

  private extractTags(
    entry: RawEvent,
    primaryMarket: Record<string, any> | null
  ): Array<{ id: string; label: string }> {
    const tags: Array<{ id: string; label: string }> = []

    const collect = (value: unknown) => {
      if (!value) {
        return
      }

      if (typeof value === 'string') {
        const label = value.trim()
        if (label) {
          tags.push({ id: label, label })
        }
        return
      }

      if (typeof value === 'number') {
        const label = String(value)
        tags.push({ id: label, label })
        return
      }

      if (typeof value === 'object') {
        const record = value as Record<string, unknown>
        const labelCandidate = record.label ?? record.name ?? record.slug
        const idCandidate = record.id ?? record.slug ?? record.label

        if (typeof labelCandidate === 'string' && labelCandidate.trim()) {
          const label = labelCandidate.trim()
          const id =
            typeof idCandidate === 'string'
              ? idCandidate.trim()
              : typeof idCandidate === 'number'
                ? String(idCandidate)
                : label

          tags.push({ id, label })
        }
      }
    }

    if (Array.isArray(entry.tags)) {
      entry.tags.forEach(collect)
    }

    if (Array.isArray(entry.categories)) {
      entry.categories.forEach(collect)
    }

    if (primaryMarket && Array.isArray(primaryMarket.tags)) {
      primaryMarket.tags.forEach(collect)
    }

    return tags
  }

  private deduplicateTags(
    tags: Array<{ id: string; label: string }>
  ): Array<{ id: string; label: string }> {
    const seen = new Map<string, string>()

    for (const tag of tags) {
      const id = tag.id.trim()
      const label = tag.label.trim()
      if (!id || !label) {
        continue
      }

      if (!seen.has(id)) {
        seen.set(id, label)
      }
    }

    return Array.from(seen.entries()).map(([id, label]) => ({ id, label }))
  }

  private resolveResolutionState(
    entry: RawEvent,
    primaryMarket: Record<string, any> | null
  ): string | null {
    const state = this.asNullableString(entry.resolutionState)
    if (state) {
      return state
    }

    const status = this.asNullableString(entry.status)
    if (status && ['resolved', 'closed', 'settled'].includes(status.toLowerCase())) {
      return status
    }

    if (primaryMarket) {
      const primaryState = this.asNullableString(
        primaryMarket.resolutionState ?? primaryMarket.status
      )
      if (primaryState) {
        return primaryState
      }

      if (typeof primaryMarket.resolved === 'boolean') {
        return primaryMarket.resolved ? 'resolved' : 'unresolved'
      }
    }

    if (typeof entry.resolved === 'boolean') {
      return entry.resolved ? 'resolved' : 'unresolved'
    }

    return null
  }

  private resolveEndDate(
    entry: RawEvent,
    primaryMarket: Record<string, any> | null
  ): DateTime | null {
    if (typeof entry.endDate === 'string') {
      const parsed = DateTime.fromISO(entry.endDate, { zone: 'utc' })
      if (parsed.isValid) {
        return parsed.toUTC()
      }
    }

    if (typeof entry.closeDate === 'string') {
      const parsed = DateTime.fromISO(entry.closeDate, { zone: 'utc' })
      if (parsed.isValid) {
        return parsed.toUTC()
      }
    }

    if (typeof entry.endTime === 'number') {
      const millis = entry.endTime < 1_000_000_000_000 ? entry.endTime * 1000 : entry.endTime
      const parsed = DateTime.fromMillis(millis, { zone: 'utc' })
      if (parsed.isValid) {
        return parsed.toUTC()
      }
    }

    if (typeof entry.closeTime === 'number') {
      const millis = entry.closeTime < 1_000_000_000_000 ? entry.closeTime * 1000 : entry.closeTime
      const parsed = DateTime.fromMillis(millis, { zone: 'utc' })
      if (parsed.isValid) {
        return parsed.toUTC()
      }
    }

    if (primaryMarket) {
      const fromPrimary = this.resolveEndDateFromMarket(primaryMarket)
      if (fromPrimary) {
        return fromPrimary
      }
    }

    if (Array.isArray(entry.markets)) {
      const candidates = entry.markets
        .map((market) => this.resolveEndDateFromMarket(market))
        .filter((value): value is DateTime => !!value)
        .sort((a, b) => a.toMillis() - b.toMillis())
      if (candidates.length > 0) {
        return candidates[0]
      }
    }

    return null
  }

  private pickPrimaryMarket(entry: RawEvent): Record<string, any> | null {
    if (!Array.isArray(entry.markets)) {
      return null
    }

    const candidates = entry.markets.filter(
      (market): market is Record<string, any> => market && typeof market === 'object'
    )

    if (candidates.length === 0) {
      return null
    }

    candidates.sort((a, b) => {
      const aEnd = this.resolveEndDateFromMarket(a)
      const bEnd = this.resolveEndDateFromMarket(b)

      if (!aEnd && !bEnd) {
        return 0
      }

      if (!aEnd) {
        return 1
      }

      if (!bEnd) {
        return -1
      }

      return aEnd.toMillis() - bEnd.toMillis()
    })

    return candidates[0] ?? null
  }

  private resolveEndDateFromMarket(market: Record<string, any>): DateTime | null {
    if (typeof market.endDate === 'string') {
      const parsed = DateTime.fromISO(market.endDate, { zone: 'utc' })
      if (parsed.isValid) {
        return parsed.toUTC()
      }
    }

    if (typeof market.closeDate === 'string') {
      const parsed = DateTime.fromISO(market.closeDate, { zone: 'utc' })
      if (parsed.isValid) {
        return parsed.toUTC()
      }
    }

    if (typeof market.endTime === 'number') {
      const millis = market.endTime < 1_000_000_000_000 ? market.endTime * 1000 : market.endTime
      const parsed = DateTime.fromMillis(millis, { zone: 'utc' })
      if (parsed.isValid) {
        return parsed.toUTC()
      }
    }

    if (typeof market.closeTime === 'number') {
      const millis =
        market.closeTime < 1_000_000_000_000 ? market.closeTime * 1000 : market.closeTime
      const parsed = DateTime.fromMillis(millis, { zone: 'utc' })
      if (parsed.isValid) {
        return parsed.toUTC()
      }
    }

    if (typeof market.timeResolved === 'string') {
      const parsed = DateTime.fromISO(market.timeResolved, { zone: 'utc' })
      if (parsed.isValid) {
        return parsed.toUTC()
      }
    }

    return null
  }

  private computeHoursToClose(endDate: DateTime, now: DateTime): number | null {
    const diff = endDate.diff(now, 'hours').hours

    if (!Number.isFinite(diff)) {
      return null
    }

    if (diff <= 0) {
      return null
    }

    // Keep a fractional value rounded to two decimals for readability.
    return Math.round(diff * 100) / 100
  }

  private computeTimeToEnd(endDate: DateTime, now: DateTime): EventSummary['timeToEnd'] {
    const diff = endDate.diff(now, ['hours', 'minutes', 'seconds'])

    if (!diff.isValid || diff.as('seconds') <= 0) {
      return null
    }

    const totalSeconds = Math.floor(diff.as('seconds'))
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60

    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
  }

  private isWithinWindow(event: EventCandidate, windowHours: number): event is EventCandidate {
    if (event.hoursToClose === null) {
      return false
    }

    if (event.hoursToClose <= 0) {
      return false
    }

    if (event.hoursToClose > windowHours) {
      return false
    }

    const resolutionState = event.resolutionState?.toLowerCase()
    if (resolutionState === 'resolved') {
      return false
    }

    return true
  }
}

export { PolymarketServiceError }
