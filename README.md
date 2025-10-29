# Predict API

## Configuration
- `POLYMARKET_API_URL` *(optional)*: Override the Polymarket Gamma Events endpoint. Defaults to `https://gamma-api.polymarket.com/events?limit=1000&sortKey=endDate&sortDir=asc`.

## Running Tests
- Install dependencies with `npm install` (or `pnpm install`).
- Execute `npm test` to run the functional suite. The Japa runner exercises the `/events/ending-soon` endpoint with mocked Polymarket responses.

## Endpoint
- `GET /events/ending-soon` calls the Polymarket Events API with the following defaults: `active=true`, `closed=false`, `archived=false`, `exclude_tag_id=1`, `end_date_min=today`, `end_date_max=today+72h`.
- The response is an array of objects containing `question`, `endDate`, `resolutionState`, `tags` (id + label), `outcomes`, `outcomePrices`, `oneDayPriceChange`, `oneWeekPriceChange`, `oneMonthPriceChange`, and `timeToEnd` (`HH:mm:ss`).
