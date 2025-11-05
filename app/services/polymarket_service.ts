import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'
import {
  MarketCache,
  CACHE_KEY_OPPORTUNITIES,
  CACHE_KEY_FLIPPED,
  CACHE_KEY_VELOCITY,
} from './polymarket/cache.js'
import { buildUrl, fetchEvents } from './polymarket/fetcher.js'
import { normaliseMarkets, deduplicateTags } from './polymarket/normalizer.js'
import {
  calculateOpportunityScore,
  calculateFlippedScore,
  calculateVelocityScore,
} from './polymarket/scoring.js'
import type {
  BucketKey,
  FlippedCategory,
  VelocityCategory,
  MarketSummary,
  MarketCandidate,
  OpportunitiesResponse,
  FlippedResponse,
  VelocityResponse,
} from './polymarket/types.js'
import { PolymarketServiceError } from './polymarket/types.js'

/**
 * Service responsible for retrieving and normalising Polymarket markets.
 */
export default class PolymarketService {
  private static cache = new MarketCache()

  static clearCache() {
    PolymarketService.cache.clear()
  }

  constructor(private readonly nowFn: () => DateTime = () => DateTime.utc()) {}

  /**
   * Retrieve investable markets grouped by price thresholds.
   */
  async getOpportunities(windowHours = 24): Promise<OpportunitiesResponse> {
    const now = this.nowFn()
    const cached = PolymarketService.cache.lookup<OpportunitiesResponse>(
      CACHE_KEY_OPPORTUNITIES,
      now
    )

    if (cached) {
      return cached
    }

    const requestUrl = buildUrl(now, windowHours)
    logger.debug({ url: requestUrl.toString() }, 'polymarket opportunities fetch started')
    const data = await fetchEvents(requestUrl)
    const candidates = data
      .flatMap((entry) => normaliseMarkets(entry, now))
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

    PolymarketService.cache.set(CACHE_KEY_OPPORTUNITIES, payload, now)
    return payload
  }

  async getFlipped(windowHours = 72): Promise<FlippedResponse> {
    const now = this.nowFn()
    const cached = PolymarketService.cache.lookup<FlippedResponse>(CACHE_KEY_FLIPPED, now)

    if (cached) {
      return cached
    }

    const requestUrl = buildUrl(now, windowHours)
    logger.debug({ url: requestUrl.toString() }, 'polymarket flipped fetch started')
    const data = await fetchEvents(requestUrl)
    const candidates = data
      .flatMap((entry) => normaliseMarkets(entry, now))
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

    PolymarketService.cache.set(CACHE_KEY_FLIPPED, payload, now)
    return payload
  }

  async getVelocity(windowHours = 72): Promise<VelocityResponse> {
    const now = this.nowFn()
    const cached = PolymarketService.cache.lookup<VelocityResponse>(CACHE_KEY_VELOCITY, now)

    if (cached) {
      return cached
    }

    const requestUrl = buildUrl(now, windowHours)
    logger.debug({ url: requestUrl.toString() }, 'polymarket velocity fetch started')
    const data = await fetchEvents(requestUrl)
    const candidates = data
      .flatMap((entry) => normaliseMarkets(entry, now))
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

    PolymarketService.cache.set(CACHE_KEY_VELOCITY, payload, now)
    return payload
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
      score: calculateFlippedScore(candidate),
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
      score: calculateVelocityScore(candidate),
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
      score: calculateOpportunityScore(candidate),
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

  private toSummary(candidate: MarketCandidate, score: number | null = null): MarketSummary {
    return {
      question: candidate.question,
      endDate: candidate.endDate,
      resolutionState: candidate.resolutionState,
      tags: deduplicateTags(candidate.tags),
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
}

export { PolymarketServiceError }
export type {
  BucketKey,
  FlippedCategory,
  VelocityCategory,
  MarketSummary,
  MarketCandidate,
  OpportunitiesResponse,
  FlippedResponse,
  VelocityResponse,
} from './polymarket/types.js'
