// Adds extra trusted CA certificates to the worker, for networks that inspect TLS traffic.
// Orca starts the plugin host with a small environment, so NODE_EXTRA_CA_CERTS does not get to the worker.
// For this reason, the plugin reads the CA file from its own setting.
import { readFile } from 'node:fs/promises'
import * as tls from 'node:tls'
import { PluginError } from './clickup'

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/** Returns each PEM certificate in a bundle. */
export function pemBlocks(text: string): string[] {
  return text.match(PEM_BLOCK) ?? []
}

/** Replaceable dependencies. The tests replace them. */
export const caDeps = {
  readFile: (path: string) => readFile(path, 'utf8'),
  setDefaultCACertificates: (certs: string[]) => tls.setDefaultCACertificates(certs),
  defaultCertificates: () => tls.getCACertificates('default')
}

let appliedPath = ''

/** Trusts the certificates in `path` in addition to the default ones. An empty path removes the extra certificates. */
export async function applyCaFile(value: unknown): Promise<void> {
  const path = typeof value === 'string' ? value.trim() : ''
  if (path === appliedPath) return
  if (path === '') {
    caDeps.setDefaultCACertificates([...caDeps.defaultCertificates()])
    appliedPath = ''
    return
  }
  let text: string
  try {
    text = await caDeps.readFile(path)
  } catch (error) {
    throw new PluginError('ca_file', `Cannot read the CA certificates file ${path}: ${(error as Error).message}`)
  }
  const certs = pemBlocks(text)
  if (certs.length === 0) throw new PluginError('ca_file', `The CA certificates file ${path} contains no PEM certificates.`)
  caDeps.setDefaultCACertificates([...caDeps.defaultCertificates(), ...certs])
  appliedPath = path
}

/** For the tests: forget the applied file. */
export function resetCa(): void {
  appliedPath = ''
}
