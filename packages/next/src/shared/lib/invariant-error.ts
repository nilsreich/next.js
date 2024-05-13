// Internal wrapper around build errors at development
// time, to prevent us from propagating or logging them
export class InvariantError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(
      `Invariant: ${message.endsWith('.') ? message : message + '.'} This is a bug in Next.js.`,
      options
    )
    this.name = 'InvariantError'
  }
}
