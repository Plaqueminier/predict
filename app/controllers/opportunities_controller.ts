import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'

import PolymarketService, {
  OpportunitiesResponse,
  FlippedResponse,
  PolymarketServiceError,
} from '#services/polymarket_service'

export default class OpportunitiesController {
  constructor(private readonly polymarketService = new PolymarketService()) {}

  async index({ request, response }: HttpContext) {
    logger.debug({ path: request.url(), ip: request.ip() }, 'markets opportunities requested')

    try {
      const buckets: OpportunitiesResponse = await this.polymarketService.getOpportunities()
      return response.ok(buckets)
    } catch (error) {
      if (error instanceof PolymarketServiceError) {
        logger.warn(
          { message: error.message, status: error.status },
          'markets opportunities upstream failure'
        )
        return response.status(error.status).send({
          error: error.message,
        })
      }

      logger.error(error, 'markets opportunities unexpected failure')

      return response.status(500).send({
        error: 'Unexpected error while fetching Polymarket opportunities',
      })
    }
  }

  async flipped({ request, response }: HttpContext) {
    logger.debug({ path: request.url(), ip: request.ip() }, 'markets flipped requested')

    try {
      const categories: FlippedResponse = await this.polymarketService.getFlipped()
      return response.ok(categories)
    } catch (error) {
      if (error instanceof PolymarketServiceError) {
        logger.warn(
          { message: error.message, status: error.status },
          'markets flipped upstream failure'
        )
        return response.status(error.status).send({
          error: error.message,
        })
      }

      logger.error(error, 'markets flipped unexpected failure')

      return response.status(500).send({
        error: 'Unexpected error while fetching flipped markets',
      })
    }
  }
}
