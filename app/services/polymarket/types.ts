export type BucketKey = 'oneToFive' | 'fiveToTen' | 'tenToFifteen' | 'fifteenToTwenty'

export type FlippedCategory = 'twentyToFifty' | 'aboveFifty'

export type VelocityCategory = 'moderate' | 'fast' | 'rapid'

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

export class PolymarketServiceError extends Error {
  status: number

  constructor(message: string, status = 502) {
    super(message)
    this.status = status
  }
}

export type RawEvent = Record<string, any>

export interface MarketCandidate extends MarketSummary {
  hoursToClose: number | null
}
