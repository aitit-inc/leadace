import { Hono } from 'hono'
import { listCountryCodes } from '../../services/country-codes'
import type { Env, Variables } from '../types'

export const countryCodesRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

countryCodesRouter.get('/country-codes', (c) => c.json(listCountryCodes()))
