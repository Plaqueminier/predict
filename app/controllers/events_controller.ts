import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'

import PolymarketService, { PolymarketServiceError } from '#services/polymarket_service'

export default class EventsController {
  constructor(private readonly polymarketService = new PolymarketService()) {}

  async endingSoon({ request, response }: HttpContext) {
    logger.debug({ path: request.url(), ip: request.ip() }, 'events ending-soon requested')

    try {
      const payload = await this.polymarketService.getEndingSoon()
      logger.debug({ count: payload.data.length }, 'events ending-soon success')
      return response.ok(payload.data)
    } catch (error) {
      if (error instanceof PolymarketServiceError) {
        logger.warn(
          { message: error.message, status: error.status },
          'events ending-soon upstream failure'
        )
        return response.status(error.status).send({
          error: error.message,
        })
      }

      logger.error(error, 'events ending-soon unexpected failure')

      return response.status(500).send({
        error: 'Unexpected error while fetching Polymarket events',
      })
    }
  }
}
