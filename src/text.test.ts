import { assert, test } from 'orca/testing'
import { BREAK, breakLongWords } from './text'

const visible = (text: string) => text.split(BREAK).join('')
const longestPart = (text: string) => Math.max(...text.split(/[\s​]/).map((part) => part.length))

test('breakLongWords breaks a path after its separators', () => {
  const name = 'PUT /calendar_event_series/:seriesId/shifts/:shiftId'
  const result = breakLongWords(name)
  assert.equal(visible(result), name)
  assert.ok(result.startsWith('PUT /'))
  assert.ok(result.includes(`/${BREAK}:${BREAK}seriesId/${BREAK}`))
  assert.ok(longestPart(result) <= 16)
})

test('breakLongWords breaks a long word without separators every 16 characters', () => {
  const word = 'Supercalifragilisticexpialidocious'
  const result = breakLongWords(`Fix ${word} now`)
  assert.equal(visible(result), `Fix ${word} now`)
  assert.deepEqual(result.split(' ')[1].split(BREAK), ['Supercalifragili', 'sticexpialidocio', 'us'])
})

test('breakLongWords keeps normal text', () => {
  const name = 'Add service method to create series events'
  assert.equal(breakLongWords(name), name)
  assert.equal(breakLongWords('exactly-sixteen!'), 'exactly-sixteen!')
  assert.equal(breakLongWords(''), '')
})
