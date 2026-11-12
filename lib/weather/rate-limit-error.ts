/**
 * Tomorrow.io answered 429.
 *
 * Its own type, in a module with no imports, so a caller can tell "the provider
 * told us to slow down" apart from "the provider is broken" without matching on
 * message text, and without importing the Redis-backed weather client just to
 * name an error.
 *
 * `name` is deliberately left as "Error": Sentry groups by exception type plus
 * message, and renaming the type would split every existing rate-limit event
 * into a new issue.
 */
export class TomorrowRateLimitError extends Error {
  constructor(message = 'Tomorrow.io rate limit exceeded. Check daily/hourly limits.') {
    super(message)
  }
}
