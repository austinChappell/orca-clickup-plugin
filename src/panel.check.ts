// `orca plugin check` renders the panel one time for each scenario, with the worker on a new host.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  disconnected: { results: { 'secrets.protection': { status: 'os-keyring' } } }
})
