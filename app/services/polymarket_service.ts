import env from '#start/env'
import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'

type BucketKey = 'oneToFive' | 'fiveToTen' | 'tenToFifteen' | 'fifteenToTwenty'

type FlippedCategory = 'twentyToFifty' | 'aboveFifty'

export interface MarketSummary {
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
  bestPrice: number | null
  url: string
  eventUrl: string
  volume: number | null
}

export type OpportunitiesResponse = Record<BucketKey, MarketSummary[]>

export type FlippedResponse = Record<FlippedCategory, MarketSummary[]>

class PolymarketServiceError extends Error {
  status: number

  constructor(message: string, status = 502) {
    super(message)
    this.status = status
  }
}

type RawEvent = Record<string, any>

interface CacheEntry {
  payload: unknown
  expiresAt: DateTime
}

const DEFAULT_ENDPOINT = 'https://gamma-api.polymarket.com/events'
const CACHE_KEY_OPPORTUNITIES = 'opportunities'
const CACHE_KEY_FLIPPED = 'flipped'
const CACHE_TTL_SECONDS = 60

interface MarketCandidate extends MarketSummary {
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
   * Retrieve investable markets grouped by price thresholds.
   */
  async getOpportunities(windowHours = 24): Promise<OpportunitiesResponse> {
    const now = this.nowFn()
    const cached = this.lookupCache<OpportunitiesResponse>(CACHE_KEY_OPPORTUNITIES, now)

    if (cached) {
      return cached
    }

    const requestUrl = this.buildUrl(now, windowHours)
    logger.debug({ url: requestUrl.toString() }, 'polymarket opportunities fetch started')
    const data = await this.fetchEvents(requestUrl)
    const candidates = data
      .flatMap((entry) => this.normaliseMarkets(entry, now))
      .filter((market): market is MarketCandidate => (market.volume ?? 0) >= 10_000)
      .filter((market): market is MarketCandidate => this.hasInvestableOdds(market))
      .filter((market): market is MarketCandidate => this.isWithinWindow(market, windowHours))
      .sort((a, b) => {
        // Sort by volume descending (highest first)
        const volA = a.volume ?? 0
        const volB = b.volume ?? 0
        return volB - volA
      })

    const payload = this.buildBuckets(candidates)

    logger.debug(
      {
        counts: Object.fromEntries(
          Object.entries(payload).map(([key, markets]) => [key, markets.length])
        ),
      },
      'polymarket opportunities fetch completed'
    )

    this.setCache(CACHE_KEY_OPPORTUNITIES, payload, now)
    return payload
  }

  async getFlipped(windowHours = 168): Promise<FlippedResponse> {
    const now = this.nowFn()
    const cached = this.lookupCache<FlippedResponse>(CACHE_KEY_FLIPPED, now)

    if (cached) {
      return cached
    }

    const requestUrl = this.buildUrl(now, windowHours)
    logger.debug({ url: requestUrl.toString() }, 'polymarket flipped fetch started')
    const data = await this.fetchEvents(requestUrl)
    const candidates = data
      .flatMap((entry) => this.normaliseMarkets(entry, now))
      .filter((market): market is MarketCandidate => (market.volume ?? 0) >= 50_000)
      .filter((market): market is MarketCandidate => this.hasInvestableOdds(market))
      .filter((market): market is MarketCandidate => this.hasFlipped(market))
      .filter((market): market is MarketCandidate => this.isWithinWindow(market, windowHours))
      .sort((a, b) => {
        // Sort by volume descending (highest first)
        const volA = a.volume ?? 0
        const volB = b.volume ?? 0
        return volB - volA
      })

    const payload = this.buildFlippedCategories(candidates)

    logger.debug(
      {
        counts: Object.fromEntries(
          Object.entries(payload).map(([key, markets]) => [key, markets.length])
        ),
      },
      'polymarket flipped fetch completed'
    )

    this.setCache(CACHE_KEY_FLIPPED, payload, now)
    return payload
  }

  private lookupCache<T>(key: string, now: DateTime): T | null {
    const entry = PolymarketService.cache[key]

    if (!entry) {
      return null
    }

    if (entry.expiresAt <= now) {
      PolymarketService.cache[key] = undefined
      return null
    }

    return entry.payload as T
  }

  private setCache(key: string, payload: unknown, now: DateTime) {
    PolymarketService.cache[key] = {
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

  private normaliseMarkets(entry: RawEvent, now: DateTime): MarketCandidate[] {
    const markets =
      Array.isArray(entry.markets) && entry.markets.length > 0 ? entry.markets : [null]
    return markets.map((market) => this.normaliseMarket(entry, market, now))
  }

  private normaliseMarket(
    entry: RawEvent,
    market: Record<string, any> | null,
    now: DateTime
  ): MarketCandidate {
    const endDate = this.resolveEndDate(entry, market)
    const hoursToClose = endDate ? this.computeHoursToClose(endDate, now) : null
    const timeToEnd = endDate ? this.computeTimeToEnd(endDate, now) : null

    const outcomes = this.parseStringList(market?.outcomes ?? entry.outcomes)
    const outcomePrices = this.parseNumberList(market?.outcomePrices ?? entry.outcomePrices)
    const tags = this.extractTags(entry.tags, entry.categories, market?.tags, market?.categories)
    const bestPrice =
      outcomePrices.length > 0 ? Math.min(...outcomePrices.filter((price) => price > 0)) : null
    const url = this.resolveMarketUrl(entry, market)
    const eventUrl = this.resolveEventUrl(entry)
    const volume = this.asNullableNumber(market?.volume ?? market?.volumeNum ?? entry.volume)

    const oneDayPriceChange = this.asNullableNumber(
      market?.oneDayPriceChange ?? entry.oneDayPriceChange
    )
    const oneWeekPriceChange = this.asNullableNumber(
      market?.oneWeekPriceChange ?? entry.oneWeekPriceChange
    )
    const oneMonthPriceChange = this.asNullableNumber(
      market?.oneMonthPriceChange ?? entry.oneMonthPriceChange
    )

    const question = this.asString(
      market?.question ??
        market?.title ??
        market?.name ??
        entry.question ??
        entry.title ??
        entry.name ??
        entry.slug ??
        entry.id
    )

    const summary: MarketCandidate = {
      question,
      endDate: endDate?.toISO() ?? null,
      hoursToClose,
      resolutionState: this.resolveResolutionState(entry, market),
      tags,
      outcomes,
      outcomePrices,
      oneDayPriceChange,
      oneWeekPriceChange,
      oneMonthPriceChange,
      timeToEnd,
      bestPrice: Number.isFinite(bestPrice ?? Number.NaN) ? bestPrice : null,
      url,
      eventUrl,
      volume,
    }

    return summary
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

  private extractTags(...sources: unknown[]): Array<{ id: string; label: string }> {
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

    for (const source of sources) {
      if (!source) {
        continue
      }

      if (Array.isArray(source)) {
        source.forEach(collect)
        continue
      }

      collect(source)
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
    market: Record<string, any> | null
  ): string | null {
    const marketState = this.asNullableString(market?.resolutionState ?? market?.status)
    if (marketState) {
      return marketState
    }

    if (typeof market?.resolved === 'boolean') {
      return market.resolved ? 'resolved' : 'unresolved'
    }

    const eventState = this.asNullableString(entry.resolutionState ?? entry.status)
    if (eventState) {
      return eventState
    }

    if (typeof entry.resolved === 'boolean') {
      return entry.resolved ? 'resolved' : 'unresolved'
    }

    return null
  }

  private resolveEndDate(entry: RawEvent, market: Record<string, any> | null): DateTime | null {
    if (market) {
      const fromMarket = this.resolveEndDateFromMarket(market)
      if (fromMarket) {
        return fromMarket
      }
    }

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

    if (Array.isArray(entry.markets)) {
      const candidates = entry.markets
        .map((candidate) => this.resolveEndDateFromMarket(candidate))
        .filter((value): value is DateTime => !!value)
        .sort((a, b) => a.toMillis() - b.toMillis())
      if (candidates.length > 0) {
        return candidates[0]
      }
    }

    return null
  }

  private resolveEndDateFromMarket(market: Record<string, any>): DateTime | null {
    if (typeof market.endDate === 'string') {
      const parsed = DateTime.fromISO(market.endDate, { zone: 'utc' })
      if (parsed.isValid) {
        return parsed.toUTC()
      }
    }

    if (typeof market.endDateIso === 'string') {
      const parsed = DateTime.fromISO(market.endDateIso, { zone: 'utc' })
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

  private computeTimeToEnd(endDate: DateTime, now: DateTime): MarketSummary['timeToEnd'] {
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

  private isWithinWindow(market: MarketCandidate, windowHours: number): market is MarketCandidate {
    if (market.hoursToClose === null) {
      return false
    }

    if (market.hoursToClose <= 0) {
      return false
    }

    if (market.hoursToClose > windowHours) {
      return false
    }

    const resolutionState = market.resolutionState?.toLowerCase()
    if (resolutionState === 'resolved') {
      return false
    }

    return true
  }

  private hasInvestableOdds(market: MarketCandidate): boolean {
    const bucket = this.resolveBucket(market.bestPrice)
    return bucket !== null
  }

  private hasFlipped(market: MarketCandidate): boolean {
    if (market.oneDayPriceChange === null) {
      return false
    }

    return Math.abs(market.oneDayPriceChange) >= 0.2
  }

  private resolveFlippedCategory(market: MarketCandidate): FlippedCategory | null {
    if (market.oneDayPriceChange === null) {
      return null
    }

    const absChange = Math.abs(market.oneDayPriceChange)

    if (absChange >= 0.5) return 'aboveFifty'
    if (absChange >= 0.2) return 'twentyToFifty'

    return null
  }

  private buildFlippedCategories(candidates: MarketCandidate[]): FlippedResponse {
    const categories: FlippedResponse = {
      twentyToFifty: [],
      aboveFifty: [],
    }

    for (const candidate of candidates) {
      const category = this.resolveFlippedCategory(candidate)
      if (!category) {
        continue
      }

      const categoryList = categories[category]
      if (categoryList.length >= 5) {
        continue
      }

      categoryList.push(this.toSummary(candidate))
    }

    return categories
  }

  private resolveBucket(price: number | null): BucketKey | null {
    if (price === null || price < 0.01) {
      return null
    }

    if (price <= 0.05) return 'oneToFive'
    if (price <= 0.1) return 'fiveToTen'
    if (price <= 0.15) return 'tenToFifteen'
    if (price <= 0.2) return 'fifteenToTwenty'

    return null
  }

  private buildBuckets(candidates: MarketCandidate[]): OpportunitiesResponse {
    const buckets: OpportunitiesResponse = {
      oneToFive: [],
      fiveToTen: [],
      tenToFifteen: [],
      fifteenToTwenty: [],
    }

    for (const candidate of candidates) {
      const bucketKey = this.resolveBucket(candidate.bestPrice)
      if (!bucketKey) {
        continue
      }

      const bucket = buckets[bucketKey]
      if (bucket.length >= 5) {
        continue
      }

      bucket.push(this.toSummary(candidate))
    }

    return buckets
  }

  private toSummary(candidate: MarketCandidate): MarketSummary {
    return {
      question: candidate.question,
      endDate: candidate.endDate,
      resolutionState: candidate.resolutionState,
      tags: this.deduplicateTags(candidate.tags),
      outcomes: candidate.outcomes,
      outcomePrices: candidate.outcomePrices,
      oneDayPriceChange: candidate.oneDayPriceChange,
      oneWeekPriceChange: candidate.oneWeekPriceChange,
      oneMonthPriceChange: candidate.oneMonthPriceChange,
      timeToEnd: candidate.timeToEnd,
      bestPrice: candidate.bestPrice,
      url: candidate.url,
      eventUrl: candidate.eventUrl,
      volume: candidate.volume,
    }
  }

  private resolveMarketUrl(entry: RawEvent, market: Record<string, any> | null): string {
    const marketSlug = this.asNullableString(market?.slug)
    if (marketSlug) {
      return `https://polymarket.com/market/${marketSlug}`
    }

    const eventSlug = this.asNullableString(entry.slug ?? entry.id)
    if (eventSlug) {
      return `https://polymarket.com/event/${eventSlug}`
    }

    return 'https://polymarket.com'
  }

  private resolveEventUrl(entry: RawEvent): string {
    const eventSlug = this.asNullableString(entry.slug ?? entry.id)
    if (eventSlug) {
      return `https://polymarket.com/event/${eventSlug}`
    }

    return 'https://polymarket.com'
  }
}

export { PolymarketServiceError }
