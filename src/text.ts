// Text helpers for the panel. Pure functions without Orca imports.

/** An invisible character where the browser can break a line. */
export const BREAK = '​'

/** A word longer than this gets break points. */
const MAX_WORD = 16

/** Characters that end a natural part of a path, an identifier or a URL. */
const SEPARATORS = /([/_\-.:?&=@\\])/g

/**
 * Adds invisible break points to long words, so that a narrow card can wrap them.
 * Orca components cannot set CSS word breaks, so the text must carry the break points.
 *
 * 1. A break point goes after each separator (/ _ - . : ? & = @ \) in a long word.
 * 2. A part that is still longer than 16 characters gets a break point every 16 characters.
 *
 * Words with 16 characters or fewer do not change.
 */
export function breakLongWords(text: string): string {
  return text.replace(/\S{17,}/g, (word) =>
    word
      .replace(SEPARATORS, `$1${BREAK}`)
      .split(BREAK)
      .map((part) => part.replace(new RegExp(`(.{${MAX_WORD}})(?=.)`, 'gu'), `$1${BREAK}`))
      .join(BREAK)
  )
}
