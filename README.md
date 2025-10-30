# Predict API

## Configuration
- `POLYMARKET_API_URL` *(optional)*: Override the Polymarket Gamma Events endpoint. Defaults to `https://gamma-api.polymarket.com/events`.

## Opportunities Endpoint
- `GET /events/opportunities` queries Gamma with sensible defaults: `active=true`, `closed=false`, `archived=false`, excludes sports/short-term crypto tags, and limits the window to 72 hours from “now”. Markets must have volume ≥ 10 000 and at least one outcome priced between 1 % and 5 %.
- The response is an object with five arrays: `onePercent`, `twoPercent`, `threePercent`, `fourPercent`, `fivePercent`. Each array holds up to 10 markets (soonest closing first) whose best outcome price falls within the corresponding 1–5 % band.
- Every market entry includes `question`, `endDate`, `resolutionState`, `tags` (id + label), `outcomes`, `outcomePrices`, `oneDayPriceChange`, `oneWeekPriceChange`, `oneMonthPriceChange`, `timeToEnd` (`HH:mm:ss`), `bestPrice`, `volume`, and both `url` (market-level) and `eventUrl` pointing to the relevant Polymarket pages.

## Flipped Markets Endpoint
- `GET /events/flipped` reuses the same upstream query but filters to markets whose best outcome price remains within 1–5 %, whose reported one-day price change is ≥ 50 % (absolute), volume exceeds 50 000, and whose end date is within the next 72 hours.
- The response is a list of market objects containing the same fields as the opportunities endpoint.
