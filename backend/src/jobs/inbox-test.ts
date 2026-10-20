import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { Env } from '../api/types'
import { withDb } from '../db/connection'
import {
  cleanSeeds,
  parseInboxTestSeeds,
  readSeeds,
  recordResults,
  releaseInboxTest,
  sendCopy,
  type InboxTestParams,
  type Probe,
} from '../services/inbox-test'
import { sendContextOf } from '../services/pipeline/context'

export class InboxTestWorkflow extends WorkflowEntrypoint<Env, InboxTestParams> {
  override async run(event: Readonly<WorkflowEvent<InboxTestParams>>, step: WorkflowStep): Promise<void> {
    const seeds = parseInboxTestSeeds(this.env.INBOX_TEST_SEEDS)
    const probes: Probe[] = []
    for (const target of event.payload.targets) {
      const copies: Probe['copies'] = []
      for (const seed of seeds) {
        const sent = await step.do(`send ${target.tenantId} ${target.identityId} ${seed.address}`, () =>
          withDb(this.env.DATABASE_URL, (db) => sendCopy(db, sendContextOf(this.env), seed, target)),
        )
        if (!sent) break
        copies.push({ address: seed.address, messageId: sent.messageId })
      }
      if (copies.length > 0) {
        probes.push({ target, copies })
      } else {
        await step.do(`release ${target.tenantId} ${target.identityId}`, () =>
          withDb(this.env.DATABASE_URL, (db) => releaseInboxTest(db, target)).then(() => true),
        )
      }
    }
    if (probes.length === 0) return
    // Every copy measured arrived within seconds.
    await step.sleep('deliver', '1 minute')
    const observed = await step.do('read', () => readSeeds(seeds, probes))
    const s = await step.do('record', () => withDb(this.env.DATABASE_URL, (db) => recordResults(db, probes, observed)))
    await step.do('clean', () => cleanSeeds(seeds, probes).then(() => true))
    console.log(
      `[inbox-test] sent=${probes.length} failed=${event.payload.targets.length - probes.length} tested=${s.tested} held=${s.held} seedReadErrors=${observed.seedReadErrors}`,
    )
  }
}
