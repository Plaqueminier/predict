import { DateTime } from 'luxon'
import type { MarketSummary, MarketCandidate, RawEvent } from './types.js'

/**
 * Normalize a list of raw market events into structured market candidates.
 */
export function normaliseMarkets(entry: RawEvent, now: DateTime): MarketCandidate[] {
  const markets = Array.isArray(entry.markets) && entry.markets.length > 0 ? entry.markets : [null]
  return markets.map((market) => normaliseMarket(entry, market, now))
}

/**
 * Normalize a single raw market event into a structured market candidate.
 */
export function normaliseMarket(
  entry: RawEvent,
  market: Record<string, any> | null,
  now: DateTime
): MarketCandidate {
  const endDate = resolveEndDate(entry, market)
  const hoursToClose = endDate ? computeHoursToClose(endDate, now) : null
  const timeToEnd = endDate ? computeTimeToEnd(endDate, now) : null

  const outcomes = parseStringList(market?.outcomes ?? entry.outcomes)
  const outcomePrices = parseNumberList(market?.outcomePrices ?? entry.outcomePrices)
  const tags = extractTags(entry.tags, entry.categories, market?.tags, market?.categories)
  const bestPrice =
    outcomePrices.length > 0 ? Math.min(...outcomePrices.filter((price) => price > 0)) : null
  const url = resolveMarketUrl(entry, market)
  const eventUrl = resolveEventUrl(entry)
  const volume = asNullableNumber(market?.volume ?? market?.volumeNum ?? entry.volume)

  const oneDayPriceChange = asNullableNumber(market?.oneDayPriceChange ?? entry.oneDayPriceChange)
  const oneWeekPriceChange = asNullableNumber(
    market?.oneWeekPriceChange ?? entry.oneWeekPriceChange
  )
  const oneMonthPriceChange = asNullableNumber(
    market?.oneMonthPriceChange ?? entry.oneMonthPriceChange
  )

  const question = asString(
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
    resolutionState: resolveResolutionState(entry, market),
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

export function asString(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value : ''
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }

  return ''
}

export function asNullableString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value : null
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return null
}

export function asNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

export function parseStringList(value: unknown): string[] {
  const items = parseUnknownArray(value)
  return items.reduce<string[]>((acc, item) => {
    if (typeof item === 'string') {
      acc.push(item)
    } else if (typeof item === 'number' || typeof item === 'boolean') {
      acc.push(String(item))
    }
    return acc
  }, [])
}

export function parseNumberList(value: unknown): number[] {
  const items = parseUnknownArray(value)
  return items.reduce<number[]>((acc, item) => {
    const num = asNullableNumber(item)
    if (num !== null) {
      acc.push(num)
    }
    return acc
  }, [])
}

export function parseUnknownArray(value: unknown): unknown[] {
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

export function extractTags(...sources: unknown[]): Array<{ id: string; label: string }> {
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

export function deduplicateTags(
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

export function resolveResolutionState(
  entry: RawEvent,
  market: Record<string, any> | null
): string | null {
  const marketState = asNullableString(market?.resolutionState ?? market?.status)
  if (marketState) {
    return marketState
  }

  if (typeof market?.resolved === 'boolean') {
    return market.resolved ? 'resolved' : 'unresolved'
  }

  const eventState = asNullableString(entry.resolutionState ?? entry.status)
  if (eventState) {
    return eventState
  }

  if (typeof entry.resolved === 'boolean') {
    return entry.resolved ? 'resolved' : 'unresolved'
  }

  return null
}

export function resolveEndDate(
  entry: RawEvent,
  market: Record<string, any> | null
): DateTime | null {
  if (market) {
    const fromMarket = resolveEndDateFromMarket(market)
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
      .map((candidate) => resolveEndDateFromMarket(candidate))
      .filter((value): value is DateTime => !!value)
      .sort((a, b) => a.toMillis() - b.toMillis())
    if (candidates.length > 0) {
      return candidates[0]
    }
  }

  return null
}

export function resolveEndDateFromMarket(market: Record<string, any>): DateTime | null {
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
    const millis = market.closeTime < 1_000_000_000_000 ? market.closeTime * 1000 : market.closeTime
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

export function computeHoursToClose(endDate: DateTime, now: DateTime): number | null {
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

export function computeTimeToEnd(endDate: DateTime, now: DateTime): MarketSummary['timeToEnd'] {
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

export function resolveMarketUrl(entry: RawEvent, market: Record<string, any> | null): string {
  const marketSlug = asNullableString(market?.slug)
  if (marketSlug) {
    return `https://polymarket.com/market/${marketSlug}`
  }

  const eventSlug = asNullableString(entry.slug ?? entry.id)
  if (eventSlug) {
    return `https://polymarket.com/event/${eventSlug}`
  }

  return 'https://polymarket.com'
}

export function resolveEventUrl(entry: RawEvent): string {
  const eventSlug = asNullableString(entry.slug ?? entry.id)
  if (eventSlug) {
    return `https://polymarket.com/event/${eventSlug}`
  }

  return 'https://polymarket.com'
}
