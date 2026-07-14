/** Shared required-field asterisk — replaces the app's previously duplicated
 *  `text-red-400` / `text-red-500` / `text-red-600` asterisk spans. */
export function RequiredMark() {
  return <span style={{ color: 'var(--accent-red)' }}>*</span>
}
