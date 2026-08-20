import { readFileSync } from 'node:fs'

// Both values ship from the same `main` commit: deploy.yml publishes the Worker
// (which serves MIN_PLUGIN_VERSION via get_server_version) and the plugin
// marketplace (which serves plugin.json). If main carries a MIN above the
// plugin it publishes, `/plugin update` fetches a version that still fails the
// gate and every user gets a permanent, unfixable upgrade nag.
//
// On develop the inverse is normal and expected: a feature raises MIN, and the
// release bump lands plugin.json on the same version right before main.

const pluginVersion = JSON.parse(readFileSync('plugin/.claude-plugin/plugin.json', 'utf8')).version
const src = readFileSync('backend/src/mcp/index.ts', 'utf8')
const match = src.match(/^const MIN_PLUGIN_VERSION\s*=\s*'([^']*)'/m)
if (!match) {
  console.error('could not find MIN_PLUGIN_VERSION in backend/src/mcp/index.ts')
  process.exit(1)
}
const minVersion = match[1]

const parse = (v, label) => {
  // Reject anything Number.parseInt would happily truncate ("0.7.16-rc1" -> 16).
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    console.error(`${label} is not an x.y.z version: ${v}`)
    process.exit(1)
  }
  return v.split('.').map(Number)
}

const isAtLeast = (a, b) => {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return true
}

const satisfied = isAtLeast(parse(pluginVersion, 'plugin.json version'), parse(minVersion, 'MIN_PLUGIN_VERSION'))
const enforce = process.env.ENFORCE === 'true'

if (satisfied) {
  console.log(`ok: plugin.json ${pluginVersion} >= MIN_PLUGIN_VERSION ${minVersion}`)
  process.exit(0)
}

const message = `plugin.json ${pluginVersion} < MIN_PLUGIN_VERSION ${minVersion}`
if (!enforce) {
  console.log(`::notice::${message} — expected on develop; the release bump must land plugin.json at ${minVersion} or higher before this reaches main.`)
  process.exit(0)
}

console.error(
  `${message}\n\n` +
  `Shipping this to main would publish a backend that rejects the plugin it publishes:\n` +
  `\`/plugin update\` would fetch ${pluginVersion}, still below the gate, so the upgrade\n` +
  `warning would never clear.\n\n` +
  `Fix: run the "release PR" workflow (blank version auto-bumps plugin.json), or set\n` +
  `plugin.json to ${minVersion} or higher.`,
)
process.exit(1)
