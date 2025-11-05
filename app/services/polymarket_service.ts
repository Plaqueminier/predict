import env from '#start/env'
import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'

type BucketKey = 'oneToFive' | 'fiveToTen' | 'tenToFifteen' | 'fifteenToTwenty'

type FlippedCategory = 'twentyToFifty' | 'aboveFifty'

type VelocityCategory = 'moderate' | 'fast' | 'rapid'

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
  score: number | null
}

export type OpportunitiesResponse = Record<BucketKey, MarketSummary[]>

export type FlippedResponse = Record<FlippedCategory, MarketSummary[]>

export type VelocityResponse = Record<VelocityCategory, MarketSummary[]>

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
const CACHE_KEY_VELOCITY = 'velocity'
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

  async getVelocity(windowHours = 168): Promise<VelocityResponse> {
    const now = this.nowFn()
    const cached = this.lookupCache<VelocityResponse>(CACHE_KEY_VELOCITY, now)

    if (cached) {
      return cached
    }

    const requestUrl = this.buildUrl(now, windowHours)
    logger.debug({ url: requestUrl.toString() }, 'polymarket velocity fetch started')
    const data = await this.fetchEvents(requestUrl)
    const candidates = data
      .flatMap((entry) => this.normaliseMarkets(entry, now))
      .filter((market): market is MarketCandidate => (market.volume ?? 0) >= 50_000)
      .filter((market): market is MarketCandidate => this.hasInvestableOdds(market))
      .filter((market): market is MarketCandidate => this.hasVelocity(market))
      .filter((market): market is MarketCandidate => this.isWithinWindow(market, windowHours))
      .sort((a, b) => {
        // Sort by absolute velocity descending (fastest first)
        const velA = Math.abs(a.oneDayPriceChange ?? 0)
        const velB = Math.abs(b.oneDayPriceChange ?? 0)
        return velB - velA
      })

    const payload = this.buildVelocityCategories(candidates)

    logger.debug(
      {
        counts: Object.fromEntries(
          Object.entries(payload).map(([key, markets]) => [key, markets.length])
        ),
      },
      'polymarket velocity fetch completed'
    )

    this.setCache(CACHE_KEY_VELOCITY, payload, now)
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
      score: null, // Will be calculated later based on route type
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

    // Calculate scores for all candidates and sort by score (highest first)
    const scoredCandidates = candidates.map((candidate) => ({
      candidate,
      score: this.calculateFlippedScore(candidate),
      category: this.resolveFlippedCategory(candidate),
    }))

    // Sort by score descending (best flips first)
    scoredCandidates.sort((a, b) => b.score - a.score)

    // Fill categories with top-scored candidates
    for (const { candidate, score, category } of scoredCandidates) {
      if (!category) {
        continue
      }

      const categoryList = categories[category]
      if (categoryList.length >= 5) {
        continue
      }

      categoryList.push(this.toSummary(candidate, score))
    }

    return categories
  }

  private hasVelocity(market: MarketCandidate): boolean {
    if (market.oneDayPriceChange === null) {
      return false
    }

    return Math.abs(market.oneDayPriceChange) >= 0.1
  }

  private resolveVelocityCategory(market: MarketCandidate): VelocityCategory | null {
    if (market.oneDayPriceChange === null) {
      return null
    }

    const absChange = Math.abs(market.oneDayPriceChange)

    if (absChange >= 0.3) return 'rapid'
    if (absChange >= 0.2) return 'fast'
    if (absChange >= 0.1) return 'moderate'

    return null
  }

  private buildVelocityCategories(candidates: MarketCandidate[]): VelocityResponse {
    const categories: VelocityResponse = {
      moderate: [],
      fast: [],
      rapid: [],
    }

    // Calculate scores for all candidates and sort by score (highest first)
    const scoredCandidates = candidates.map((candidate) => ({
      candidate,
      score: this.calculateVelocityScore(candidate),
      category: this.resolveVelocityCategory(candidate),
    }))

    // Sort by score descending (best velocity plays first)
    scoredCandidates.sort((a, b) => b.score - a.score)

    // Fill categories with top-scored candidates
    for (const { candidate, score, category } of scoredCandidates) {
      if (!category) {
        continue
      }

      const categoryList = categories[category]
      if (categoryList.length >= 5) {
        continue
      }

      categoryList.push(this.toSummary(candidate, score))
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

    // Calculate scores for all candidates and sort by score (highest first)
    const scoredCandidates = candidates.map((candidate) => ({
      candidate,
      score: this.calculateOpportunityScore(candidate),
      bucketKey: this.resolveBucket(candidate.bestPrice),
    }))

    // Sort by score descending (best opportunities first)
    scoredCandidates.sort((a, b) => b.score - a.score)

    // Fill buckets with top-scored candidates
    for (const { candidate, score, bucketKey } of scoredCandidates) {
      if (!bucketKey) {
        continue
      }

      const bucket = buckets[bucketKey]
      if (bucket.length >= 5) {
        continue
      }

      bucket.push(this.toSummary(candidate, score))
    }

    return buckets
  }

  /**
   * Calculate opportunity score (0-100) - higher is better/safer
   *
   * This score helps identify the safest arbitrage opportunities by combining:
   * 1. Volume (40 points max): Higher volume = more liquid, easier to enter/exit
   *    - $1M+ volume gets full 40 points
   *    - Scales down for lower volumes
   *
   * 2. Time to resolution (30 points max): Shorter time = less uncertainty
   *    - <12 hours gets full 30 points
   *    - Scales down as time increases (more time = more risk)
   *
   * 3. Price attractiveness (30 points max): Better odds = higher potential return
   *    - Lower prices (1-5%) get more points than higher prices (15-20%)
   *    - Represents your potential upside
   */
  private calculateOpportunityScore(candidate: MarketCandidate): number {
    let score = 0

    // Volume score (0-40 points): Liquidity is crucial for safe entry/exit
    const volume = candidate.volume ?? 0
    if (volume >= 1_000_000) {
      score += 40 // $1M+ is excellent liquidity
    } else if (volume >= 500_000) {
      score += 35 // $500K+ is very good
    } else if (volume >= 250_000) {
      score += 30 // $250K+ is good
    } else if (volume >= 100_000) {
      score += 25 // $100K+ is decent
    } else if (volume >= 50_000) {
      score += 20 // $50K+ is acceptable
    } else {
      score += 15 // Below $50K is risky
    }

    // Time score (0-30 points): Shorter time = less uncertainty
    const hours = candidate.hoursToClose ?? 24
    if (hours <= 12) {
      score += 30 // <12h is ideal
    } else if (hours <= 24) {
      score += 25 // <24h is very good
    } else if (hours <= 48) {
      score += 20 // <48h is good
    } else if (hours <= 72) {
      score += 15 // <72h is okay
    } else {
      score += 10 // >72h has more risk
    }

    // Price score (0-30 points): Lower price = higher potential return
    const price = candidate.bestPrice ?? 0.2
    if (price <= 0.05) {
      score += 30 // 1-5% range: 19x-20x potential return
    } else if (price <= 0.1) {
      score += 25 // 5-10% range: 9x-10x potential return
    } else if (price <= 0.15) {
      score += 20 // 10-15% range: 6x-7x potential return
    } else {
      score += 15 // 15-20% range: 4x-5x potential return
    }

    return Math.round(score)
  }

  /**
   * Calculate flipped market score (0-100) - higher is better
   *
   * This score helps identify the best flip opportunities by combining:
   * 1. Volume (40 points max): Same as opportunities - liquidity is key
   *
   * 2. Flip magnitude (40 points max): Bigger flips often mean more opportunity
   *    - >50% flip gets full 40 points (major sentiment shift)
   *    - 20-50% flip gets scaled points (moderate shift)
   *
   * 3. Time to resolution (20 points max): Shorter time preferred
   *    - Flips need time to potentially reverse
   *    - But not too much time (increases uncertainty)
   */
  private calculateFlippedScore(candidate: MarketCandidate): number {
    let score = 0

    // Volume score (0-40 points): Same logic as opportunities
    const volume = candidate.volume ?? 0
    if (volume >= 1_000_000) {
      score += 40
    } else if (volume >= 500_000) {
      score += 35
    } else if (volume >= 250_000) {
      score += 30
    } else if (volume >= 100_000) {
      score += 25
    } else {
      score += 20
    }

    // Flip magnitude score (0-40 points): Bigger flip = more opportunity
    const flipMagnitude = Math.abs(candidate.oneDayPriceChange ?? 0)
    if (flipMagnitude >= 0.5) {
      score += 40 // >50% flip is massive
    } else if (flipMagnitude >= 0.4) {
      score += 35 // 40-50% flip is very significant
    } else if (flipMagnitude >= 0.3) {
      score += 30 // 30-40% flip is significant
    } else if (flipMagnitude >= 0.2) {
      score += 25 // 20-30% flip is notable
    } else {
      score += 20 // <20% flip is minor
    }

    // Time score (0-20 points): Moderate time window is best for flips
    const hours = candidate.hoursToClose ?? 168
    if (hours >= 24 && hours <= 72) {
      score += 20 // 1-3 days is ideal for flip opportunities
    } else if (hours >= 12 && hours < 24) {
      score += 15 // 12-24h is good
    } else if (hours >= 72 && hours <= 168) {
      score += 15 // 3-7 days is acceptable
    } else {
      score += 10 // Too short or too long
    }

    return Math.round(score)
  }

  /**
   * Calculate velocity score (0-100) - higher is better
   *
   * This score helps identify the best momentum opportunities by combining:
   * 1. Volume (30 points max): Liquidity matters but less critical than velocity
   *
   * 2. Velocity magnitude (50 points max): Speed of movement is most important
   *    - Rapid velocity (>30%) gets full 50 points
   *    - Fast velocity (20-30%) gets 40 points
   *    - Moderate velocity (10-20%) gets 30 points
   *
   * 3. Time to resolution (20 points max): Shorter time = momentum more likely to continue
   *    - <24 hours is best for riding momentum
   */
  private calculateVelocityScore(candidate: MarketCandidate): number {
    let score = 0

    // Volume score (0-30 points): Less weight than other routes
    const volume = candidate.volume ?? 0
    if (volume >= 1_000_000) {
      score += 30
    } else if (volume >= 500_000) {
      score += 25
    } else if (volume >= 250_000) {
      score += 20
    } else if (volume >= 100_000) {
      score += 15
    } else {
      score += 10
    }

    // Velocity magnitude score (0-50 points): This is the key factor
    const velocity = Math.abs(candidate.oneDayPriceChange ?? 0)
    if (velocity >= 0.5) {
      score += 50 // >50% velocity is explosive
    } else if (velocity >= 0.4) {
      score += 45 // 40-50% velocity is very fast
    } else if (velocity >= 0.3) {
      score += 40 // 30-40% velocity is fast (rapid category)
    } else if (velocity >= 0.2) {
      score += 35 // 20-30% velocity is moderate-fast
    } else if (velocity >= 0.15) {
      score += 30 // 15-20% velocity is moderate
    } else {
      score += 25 // <15% velocity is slow
    }

    // Time score (0-20 points): Shorter time better for momentum plays
    const hours = candidate.hoursToClose ?? 168
    if (hours <= 24) {
      score += 20 // <24h is ideal for momentum
    } else if (hours <= 48) {
      score += 15 // <48h is good
    } else if (hours <= 72) {
      score += 10 // <72h is okay
    } else {
      score += 5 // >72h makes momentum less reliable
    }

    return Math.round(score)
  }

  private toSummary(candidate: MarketCandidate, score: number | null = null): MarketSummary {
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
      score: score ?? candidate.score,
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
