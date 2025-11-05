import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'

import PolymarketService, {
  OpportunitiesResponse,
  FlippedResponse,
  VelocityResponse,
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

  async velocity({ request, response }: HttpContext) {
    logger.debug({ path: request.url(), ip: request.ip() }, 'markets velocity requested')

    try {
      const categories: VelocityResponse = await this.polymarketService.getVelocity()
      return response.ok(categories)
    } catch (error) {
      if (error instanceof PolymarketServiceError) {
        logger.warn(
          { message: error.message, status: error.status },
          'markets velocity upstream failure'
        )
        return response.status(error.status).send({
          error: error.message,
        })
      }

      logger.error(error, 'markets velocity unexpected failure')

      return response.status(500).send({
        error: 'Unexpected error while fetching velocity markets',
      })
    }
  }
}
