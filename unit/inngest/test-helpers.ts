// Inngest's `InngestFunction.fn` is a real, public runtime property (see
// node_modules/inngest/components/InngestFunction.js: `this.fn = fn`) — it's
// only marked `private` in the .d.ts to keep it out of the public API
// surface. Casting through this narrow, explicit interface (rather than
// `as any`) is how these tests reach the raw async handler directly,
// bypassing Inngest's step-memoization/checkpointing machinery entirely.
// There's no official `@inngest/test` package in this project's
// dependencies to do this more officially.

export interface StepStub {
  run:        (name: string, cb: () => unknown) => unknown
  sleep?:     (...args: unknown[]) => unknown
  sendEvent?: (...args: unknown[]) => unknown
}

export interface HandlerContext {
  event:  unknown
  step:   StepStub
  logger?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
}

interface RunnableInngestFunction {
  fn: (ctx: HandlerContext) => Promise<unknown>
}

export function invokeHandler(target: unknown, ctx: HandlerContext): Promise<unknown> {
  return (target as RunnableInngestFunction).fn(ctx)
}
