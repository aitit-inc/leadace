// One Durable Object per chat thread, named by its id. It takes a turn whenever
// the thread holds something the agent should answer (services/chat/threads.ts
// hasUnanswered) or an approval comes in, one turn at a time, and streams every
// turn to everyone viewing the thread. What is owed an answer lives in the
// database, so a restart loses only the turn in flight.
import { DurableObject } from 'cloudflare:workers'
import type { ExecutionContext } from 'hono'
import { withTenantConnection } from '../db/rls'
import type { TenantId } from '../domain/ids'
import { runChatTurn, type ChatEvent, type ChatTurnDeps, type ChatTurnInput } from '../services/chat/agent'
import { hasUnanswered, listMessages, markRead } from '../services/chat/threads'
import { withPaidCallScope } from '../services/paid-calls'
import { getTenantOwnerUserId } from '../services/tenants'
import { buildToolExecutor, type InternalDispatch } from './tool-executor'
import type { Env } from './types'

type ThreadRef = { tenantId: TenantId; threadId: string }

// `state` tells a viewer whether a turn is running and, to one who opens the
// thread mid-turn, what the model has written so far.
type RunnerEvent = ChatEvent | { type: 'state'; running: boolean; text: string }

// An awaited fetch() does not keep a Durable Object from eviction (70-140 s
// with no incoming event), and a turn waits on the model longer than that. An
// alarm is an incoming event.
const HEARTBEAT_MS = 30_000

// A factory because a turn's tool calls re-enter the app through `dispatch`,
// which lives with the app in api/index.ts.
export function threadRunner(dispatch: InternalDispatch) {
  return class ThreadRunner extends DurableObject<Env> {
    private running = false
    // A turn has run since the loop started: what viewers are told. A wake
    // that finds nothing to answer shows them nothing.
    private busy = false
    // An input came in since the loop last looked for one.
    private dirty = false
    private text = ''
    private confirms: Array<{ callId: string; approve: boolean }> = []
    private stop = new AbortController()
    private drained = Promise.resolve()

    async wake(ref: ThreadRef): Promise<void> {
      this.dirty = true
      if (this.running) return
      await this.ctx.storage.put('thread', ref)
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS)
      // Marked only once the writes hold, so a failed one never leaves the
      // loop marked up with none running.
      if (this.running) return
      this.running = true
      this.stop = new AbortController()
      this.drained = this.drain(ref)
    }

    async confirm(ref: ThreadRef, callId: string, approve: boolean): Promise<void> {
      this.confirms.push({ callId, approve })
      await this.wake(ref)
    }

    // Resolves once the turn in flight has recorded what ran. What was waiting
    // for an answer stops with it, read and not answered, unless an input came
    // in after Stop and set the loop going again.
    async halt(ref: ThreadRef): Promise<void> {
      this.dirty = false
      this.confirms = []
      this.stop.abort()
      await this.drained
      if (this.running) return
      await withTenantConnection(this.env.DATABASE_URL, ref.tenantId, async (db) => {
        const history = await listMessages(db, ref.tenantId, ref.threadId)
        if (history.ok) await markRead(db, ref.tenantId, ref.threadId, history.value.messages)
      })
    }

    // A viewer's socket; the route has checked the thread is theirs. It
    // hibernates with the object, so an open thread costs nothing between turns.
    override fetch(request: Request): Response {
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      pair[1].send(JSON.stringify({ type: 'state', running: this.busy, text: this.text } satisfies RunnerEvent))
      // A browser drops a socket whose server picks none of the subprotocols it offered.
      const protocol = request.headers.get('Sec-WebSocket-Protocol')?.split(',')[0]?.trim()
      return new Response(null, { status: 101, webSocket: pair[0], headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : {} })
    }

    // The heartbeat, and the way back after a reset mid-turn: the alarm
    // outlives the object, which then answers whatever is still unread.
    override async alarm(): Promise<void> {
      if (this.running) {
        await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS)
        return
      }
      const ref = await this.ctx.storage.get<ThreadRef>('thread')
      if (ref) await this.wake(ref)
    }

    override webSocketClose(ws: WebSocket): void {
      ws.close()
    }

    private async drain(ref: ThreadRef): Promise<void> {
      const run: ChatTurnDeps['run'] = (fn) => withTenantConnection(this.env.DATABASE_URL, ref.tenantId, fn)
      try {
        while (!this.stop.signal.aborted) {
          this.dirty = false
          const confirm = this.confirms.shift()
          if (confirm) await this.turn(ref, run, { kind: 'confirm', ...confirm })
          else if (await run((db) => hasUnanswered(db, ref.tenantId, ref.threadId))) await this.turn(ref, run, { kind: 'unread' })
          else if (!this.dirty) break
        }
      } catch (e) {
        console.error(`[thread-runner] thread=${ref.threadId} failed`, e)
        this.broadcast({ type: 'error', message: 'The turn failed part-way. Reload the thread to see what was saved.' })
      } finally {
        this.running = false
        this.text = ''
        await this.ctx.storage.deleteAlarm()
        if (this.busy) {
          this.busy = false
          this.broadcast({ type: 'state', running: false, text: '' })
        }
      }
      // Stop ends what came before it, not an input that arrived after.
      if (this.dirty) await this.wake(ref)
    }

    private async turn(ref: ThreadRef, run: ChatTurnDeps['run'], input: ChatTurnInput): Promise<void> {
      this.busy = true
      this.text = ''
      this.broadcast({ type: 'state', running: true, text: '' })
      // No person's request carries the turn, so it acts as the workspace owner.
      const userId = await run((db) => getTenantOwnerUserId(db, ref.tenantId))
      if (!userId) throw new Error(`tenant ${ref.tenantId} has no owner`)
      // waitUntil does nothing in a Durable Object, so what a tool call leaves
      // running in the background (a credit top-up) holds the turn open instead.
      const background: Array<Promise<unknown>> = []
      const executionCtx: ExecutionContext = { waitUntil: (p) => void background.push(p), passThroughOnException: () => {}, props: {} }
      const tools = buildToolExecutor(this.env, executionCtx, dispatch, { origin: 'chat', userId })
      const deps = { run, signal: this.stop.signal, tenantId: ref.tenantId, userId, env: this.env, tools }
      await withPaidCallScope({ databaseUrl: this.env.DATABASE_URL, tenantId: ref.tenantId, threadId: ref.threadId }, async () => {
        for await (const event of runChatTurn(deps, ref.threadId, input)) {
          if (event.type === 'text_delta') this.text += event.text
          else if (event.type === 'message') this.text = ''
          this.broadcast(event)
        }
      })
      await Promise.allSettled(background)
    }

    private broadcast(event: RunnerEvent): void {
      const data = JSON.stringify(event)
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(data)
        } catch {
          // A viewer leaving as the event goes out.
        }
      }
    }
  }
}

export type ThreadRunner = InstanceType<ReturnType<typeof threadRunner>>
