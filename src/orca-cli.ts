// Runs the `orca` CLI from the worker. The plugin host API cannot create worktrees, but the CLI can.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { PluginError } from './clickup'

const MAC_APP_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'
const TIMEOUT_MS = 110_000

export type RunOrca = (cliPath: string, args: string[]) => Promise<unknown>

/** Finds the CLI: the setting first, then the macOS app bundle, then `orca` on PATH. */
export function resolveOrcaCli(setting: unknown): string {
  if (typeof setting === 'string' && setting.trim() !== '') return setting.trim()
  if (process.platform === 'darwin' && existsSync(MAC_APP_CLI)) return MAC_APP_CLI
  return 'orca'
}

/** Runs `orca <args> --json` and returns `result`. A failed command throws a PluginError. */
export const runOrca: RunOrca = (cliPath, args) =>
  new Promise((resolve, reject) => {
    execFile(cliPath, [...args, '--json'], { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      let body: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } } | null = null
      try {
        body = JSON.parse(String(stdout))
      } catch {
        body = null
      }
      if (body?.ok === true) {
        resolve(body.result)
        return
      }
      if (body?.error) {
        reject(new PluginError(body.error.code ?? 'orca_error', `Orca refused the command: ${body.error.message ?? 'unknown error'}`))
        return
      }
      const detail = String(stderr).trim() || (error ? error.message : 'no output')
      reject(new PluginError('orca_cli_failed', `The Orca CLI at "${cliPath}" failed: ${detail}`))
    })
  })
