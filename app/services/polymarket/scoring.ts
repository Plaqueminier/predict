import type { MarketCandidate } from './types.js'

/**
 * Calculate opportunity score (0-100) - higher is better/safer
 *
 * This score helps identify the safest arbitrage opportunities by combining:
 * 1. Time to resolution (70 points max): DOMINANT FACTOR - Shorter time = less uncertainty
 *    - <4 hours gets full 70 points (Crypto 4H markets!)
 *    - <8 hours gets 50 points
 *    - <12 hours gets 35 points
 *    - Scales down dramatically as time increases
 *
 * 2. Volume (15 points max): Secondary factor for liquidity
 *    - $1M+ volume gets full 15 points
 *    - Scales down for lower volumes
 *
 * 3. Price attractiveness (15 points max): Tertiary factor
 *    - Lower prices (1-5%) get more points than higher prices (15-20%)
 *    - Represents your potential upside
 */
export function calculateOpportunityScore(candidate: MarketCandidate): number {
  let score = 0

  // Time score (0-70 points): DOMINANT FACTOR - Ending soon is king
  const hours = candidate.hoursToClose ?? 24
  if (hours <= 4) {
    score += 70 // <4h is ideal (Crypto 4H markets!)
  } else if (hours <= 8) {
    score += 50 // <8h is good but clearly less valuable
  } else if (hours <= 12) {
    score += 35 // <12h is okay
  } else if (hours <= 24) {
    score += 20 // <24h is acceptable
  } else if (hours <= 48) {
    score += 10 // <48h is not ideal
  } else if (hours <= 72) {
    score += 5 // <72h is low priority
  } else {
    score += 1 // >72h is very low priority
  }

  // Volume score (0-15 points): Secondary factor for liquidity
  const volume = candidate.volume ?? 0
  if (volume >= 1_000_000) {
    score += 15 // $1M+ is excellent liquidity
  } else if (volume >= 500_000) {
    score += 13 // $500K+ is very good
  } else if (volume >= 250_000) {
    score += 11 // $250K+ is good
  } else if (volume >= 100_000) {
    score += 9 // $100K+ is decent
  } else if (volume >= 50_000) {
    score += 7 // $50K+ is acceptable
  } else if (volume >= 10_000) {
    score += 5 // $10K+ is minimal
  } else {
    score += 3 // Below $10K is very risky
  }

  // Price score (0-15 points): Tertiary factor
  const price = candidate.bestPrice ?? 0.2
  if (price <= 0.05) {
    score += 15 // 1-5% range: 19x-20x potential return
  } else if (price <= 0.1) {
    score += 13 // 5-10% range: 9x-10x potential return
  } else if (price <= 0.15) {
    score += 11 // 10-15% range: 6x-7x potential return
  } else {
    score += 9 // 15-20% range: 4x-5x potential return
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
export function calculateFlippedScore(candidate: MarketCandidate): number {
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
 * This score helps identify stable trending markets with small, consistent gains by combining:
 * 1. Volume (50 points max): Liquidity is critical for stable markets
 *    - Higher volume = more stable, reliable price movements
 *    - Better ability to enter/exit positions
 *
 * 2. Day velocity consistency (30 points max): Steady daily movement is key
 *    - Target: 0.02-0.08 daily change (2-8%)
 *    - Too slow (<0.02) = capital locked up
 *    - Too fast (>0.2) = volatile, risky
 *
 * 3. Week velocity confirmation (20 points max): Weekly trend should confirm daily
 *    - Week change should be in same direction as day change
 *    - Indicates sustained trend, not noise
 */
export function calculateVelocityScore(candidate: MarketCandidate): number {
  let score = 0

  // Volume score (0-50 points): DOMINANT FACTOR - liquidity is king for stable plays
  const volume = candidate.volume ?? 0
  if (volume >= 1_000_000) {
    score += 50 // $1M+ is excellent - very stable market
  } else if (volume >= 500_000) {
    score += 45 // $500K+ is very good
  } else if (volume >= 250_000) {
    score += 40 // $250K+ is good
  } else if (volume >= 100_000) {
    score += 35 // $100K+ is decent
  } else if (volume >= 50_000) {
    score += 30 // $50K+ is acceptable
  } else {
    score += 20 // Below $50K is risky for stable plays
  }

  // Day velocity score (0-30 points): Steady movement, not explosive
  const dayVelocity = Math.abs(candidate.oneDayPriceChange ?? 0)
  if (dayVelocity >= 0.03 && dayVelocity <= 0.06) {
    score += 30 // 3-6% daily is ideal - steady gains
  } else if (dayVelocity >= 0.02 && dayVelocity < 0.03) {
    score += 28 // 2-3% daily is good but slower
  } else if (dayVelocity >= 0.01 && dayVelocity < 0.02) {
    score += 25 // 1-2% daily is slower but still usable
  } else if (dayVelocity >= 0.06 && dayVelocity <= 0.08) {
    score += 26 // 6-8% daily is acceptable but getting faster
  } else if (dayVelocity >= 0.08 && dayVelocity <= 0.1) {
    score += 20 // 8-10% is getting volatile
  } else if (dayVelocity > 0.1 && dayVelocity <= 0.15) {
    score += 15 // 10-15% is too fast but still usable
  } else if (dayVelocity > 0.15 && dayVelocity <= 0.2) {
    score += 10 // 15-20% is very volatile
  } else {
    score += 5 // Either too slow (<1%) or too fast (>20%)
  }

  // Week velocity confirmation (0-20 points): Trend consistency check
  const weekVelocity = candidate.oneWeekPriceChange
  const dayChange = candidate.oneDayPriceChange

  if (weekVelocity !== null && dayChange !== null) {
    // Check if week and day are in same direction (both positive or both negative)
    const sameDirection = (weekVelocity > 0 && dayChange > 0) || (weekVelocity < 0 && dayChange < 0)

    if (sameDirection) {
      const absWeekVelocity = Math.abs(weekVelocity)
      // Week velocity should be substantial but not explosive (steady trend over time)
      if (absWeekVelocity >= 0.1 && absWeekVelocity <= 0.3) {
        score += 20 // Perfect: 10-30% weekly change confirms steady trend
      } else if (absWeekVelocity >= 0.05 && absWeekVelocity < 0.1) {
        score += 15 // Good: 5-10% weekly is slower but consistent
      } else if (absWeekVelocity >= 0.3 && absWeekVelocity <= 0.5) {
        score += 12 // Acceptable: 30-50% weekly is getting fast
      } else if (absWeekVelocity > 0.5) {
        score += 8 // Too fast: >50% weekly is volatile
      } else {
        score += 5 // Too slow: <5% weekly might not move enough
      }
    } else {
      // Direction mismatch = unstable trend
      score += 3
    }
  } else {
    // Missing data = less confident
    score += 5
  }

  return Math.round(score)
}
