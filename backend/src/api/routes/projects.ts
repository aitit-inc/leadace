import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  projectIdParamSchema,
  createProjectBodySchema,
  listProjects,
  createProject,
  deleteProject,
} from '../../services/projects'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const projectsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

projectsRouter.get('/', async (c) => {
  const result = await listProjects(c.get('db'), c.get('tenantId'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

projectsRouter.post('/', zValidator('json', createProjectBodySchema), async (c) => {
  const result = await createProject(
    c.get('db'),
    c.get('tenantId'),
    c.get('edition'),
    c.req.valid('json'),
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value, 201)
})

projectsRouter.delete('/:id', zValidator('param', projectIdParamSchema), async (c) => {
  const result = await deleteProject(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})
