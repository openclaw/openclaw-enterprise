// Image rebuild timing demo (closed unmerged).
/** True when `value` contains a C0 control character (U+0000-U+001F) or DEL (U+007F). */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}
