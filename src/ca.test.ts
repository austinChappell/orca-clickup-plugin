import { afterEach, assert, test } from 'orca/testing'
import { applyCaFile, caDeps, pemBlocks, resetCa } from './ca'
import { networkDetail } from './clickup'

const CERT_A = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'
const CERT_B = '-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----'
const original = { ...caDeps }

function fakeTls(files: Record<string, string>) {
  const calls: string[][] = []
  caDeps.readFile = async (path) => {
    if (!(path in files)) throw new Error('ENOENT: no such file')
    return files[path]
  }
  caDeps.defaultCertificates = () => ['DEFAULT']
  caDeps.setDefaultCACertificates = (certs) => void calls.push(certs)
  return calls
}

afterEach(() => {
  Object.assign(caDeps, original)
  resetCa()
})

test('pemBlocks splits a bundle into certificates', () => {
  assert.deepEqual(pemBlocks(`subject=x\n${CERT_A}\n\n${CERT_B}\n`), [CERT_A, CERT_B])
  assert.deepEqual(pemBlocks('nothing here'), [])
})

test('applyCaFile adds the certificates to the defaults once', async () => {
  const calls = fakeTls({ '/ca.pem': `${CERT_A}\n${CERT_B}` })
  await applyCaFile('')
  await applyCaFile(undefined)
  assert.equal(calls.length, 0)
  await applyCaFile(' /ca.pem ')
  await applyCaFile('/ca.pem')
  assert.deepEqual(calls, [['DEFAULT', CERT_A, CERT_B]])
  await applyCaFile('')
  assert.deepEqual(calls.at(-1), ['DEFAULT'])
})

test('applyCaFile reports a missing file or a file with no certificates', async () => {
  const calls = fakeTls({ '/empty.pem': 'not a cert' })
  await assert.rejects(applyCaFile('/missing.pem'), /Cannot read the CA certificates file \/missing.pem/)
  await assert.rejects(applyCaFile('/empty.pem'), /contains no PEM certificates/)
  assert.equal(calls.length, 0)
})

test('networkDetail shows the cause and a hint for certificate errors', () => {
  const certError = Object.assign(new TypeError('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } })
  assert.match(networkDetail(certError), /^fetch failed \(SELF_SIGNED_CERT_IN_CHAIN\)\. .*CA certificates file/)
  const dnsError = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
  assert.equal(networkDetail(dnsError), 'fetch failed (ENOTFOUND)')
  assert.equal(networkDetail(new Error('offline')), 'offline')
})
