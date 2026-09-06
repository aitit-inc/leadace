import { Hono } from 'hono'
import type { Context } from 'hono'
import { zValidator } from '../zvalidator'
import {
  startJob,
  listJobs,
  getJob,
  cancelJob,
  startJobBodySchema,
  listJobsQuerySchema,
  jobIdParamSchema,
  type JobRunner,
} from '../../services/jobs'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const jobsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

export function jobRunner(env: Env): JobRunner {
  return {
    create: async (jobId, tenantId) => {
      await env.JOBS.create({ id: jobId, params: { jobId, tenantId } })
    },
    terminate: async (jobId) => {
      const instance = await env.JOBS.get(jobId).catch(() => null)
      if (!instance) return
      const { status } = await instance.status()
      if (status === 'complete' || status === 'errored' || status === 'terminated') return
      await instance.terminate()
    },
  }
}

function originOf(c: Context<{ Bindings: Env; Variables: Variables }>) {
  return c.get('origin')
}

jobsRouter.post('/jobs', zValidator('json', startJobBodySchema), async (c) => {
  const result = await startJob(c.get('db'), c.get('tenantId'), jobRunner(c.env), originOf(c), c.req.valid('json'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value, 201)
})

jobsRouter.get('/jobs', zValidator('query', listJobsQuerySchema), async (c) => {
  const result = await listJobs(c.get('db'), c.get('tenantId'), c.req.valid('query'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

jobsRouter.get('/jobs/:id', zValidator('param', jobIdParamSchema), async (c) => {
  const result = await getJob(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

jobsRouter.post('/jobs/:id/cancel', zValidator('param', jobIdParamSchema), async (c) => {
  const result = await cancelJob(c.get('db'), c.get('tenantId'), jobRunner(c.env), c.req.valid('param').id)
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})
