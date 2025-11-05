/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import router from '@adonisjs/core/services/router'

router.get('/', async () => {
  return {
    hello: 'world',
  }
})

router.get('/events/opportunities', '#controllers/opportunities_controller.index')
router.get('/events/flipped', '#controllers/opportunities_controller.flipped')
router.get('/events/velocity', '#controllers/opportunities_controller.velocity')
