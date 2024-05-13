import {
  requestAsyncStorage,
  type RequestStore,
} from '../../client/components/request-async-storage.external'
import { BaseServerSpan } from '../lib/trace/constants'
import { getTracer } from '../lib/trace/tracer'
import type { CacheScope } from './react-cache-scope'
import { ResponseCookies } from '../web/spec-extension/cookies'
import type { RequestLifecycleOpts } from '../base-server'
import type { AfterCallback, AfterTask, WaitUntilFn } from './shared'

export interface AfterContext {
  run<T>(requestStore: RequestStore, callback: () => T): T
  after(task: AfterTask): void
}

export type AfterContextOpts = {
  waitUntil: WaitUntilFn | undefined
  onClose: RequestLifecycleOpts['onClose'] | undefined
  cacheScope: CacheScope | undefined
}

export function createAfterContext(opts: AfterContextOpts): AfterContext {
  return new AfterContextImpl(opts)
}

export class AfterContextImpl implements AfterContext {
  private waitUntil: WaitUntilFn | undefined
  private onClose: RequestLifecycleOpts['onClose'] | undefined
  private cacheScope: CacheScope | undefined

  private requestStore: RequestStore | undefined

  private afterCallbacks: AfterCallback[] = []

  constructor({ waitUntil, onClose, cacheScope }: AfterContextOpts) {
    this.waitUntil = waitUntil
    this.onClose = onClose
    this.cacheScope = cacheScope
  }

  public run<T>(requestStore: RequestStore, callback: () => T): T {
    this.requestStore = requestStore
    if (this.cacheScope) {
      return this.cacheScope.run(() => callback())
    } else {
      return callback()
    }
  }

  public after(task: AfterTask): void {
    if (isPromise(task)) {
      task.catch(() => {}) // avoid unhandled rejection crashes
      if (!this.waitUntil) {
        errorWaitUntilNotAvailable()
      }
      this.waitUntil(task)
    } else if (typeof task === 'function') {
      // TODO(after): will this trace correctly?
      this.addCallback(() =>
        getTracer().trace(BaseServerSpan.after, () => task())
      )
    } else {
      throw new Error(
        '`unstable_after()` must receive a promise or a function as its argument'
      )
    }
  }

  private addCallback(callback: AfterCallback) {
    if (this.afterCallbacks.length === 0) {
      // if something is wrong, throw synchronously, bubbling up to the `unstable_after` callsite.
      if (!this.waitUntil) {
        errorWaitUntilNotAvailable()
      }
      if (!this.requestStore) {
        throw new Error(
          'Invariant: expected `AfterContext.requestStore` to be initialized'
        )
      }
      if (!this.onClose) {
        throw new Error(
          '`unstable_after()` received a function, but Next.js will not be able to run it, because `onClose` is not implemented for the current environment.'
        )
      }

      this.waitUntil(this.runCallbacksOnClose())
    }
    this.afterCallbacks.push(callback)
  }

  private async runCallbacksOnClose() {
    await new Promise<void>((resolve) => this.onClose!(resolve))
    return this.runCallbacks(this.requestStore!)
  }

  private async runCallbacks(requestStore: RequestStore): Promise<void> {
    if (this.afterCallbacks.length === 0) return

    const runCallbacksImpl = async () => {
      // TODO(after): we should consider limiting the parallelism here via something like `p-queue`.
      // (having a queue will also be needed for after-within-after, so this'd solve two problems at once).
      await Promise.all(
        this.afterCallbacks.map(async (afterCallback) => {
          try {
            await afterCallback()
          } catch (err) {
            // TODO(after): this is fine for now, but will need better intergration with our error reporting.
            console.error(
              'An error occurred in a function passed to `unstable_after()`:',
              err
            )
          }
        })
      )
    }

    const readonlyRequestStore: RequestStore =
      wrapRequestStoreForAfterCallbacks(requestStore)

    return requestAsyncStorage.run(readonlyRequestStore, () => {
      if (this.cacheScope) {
        return this.cacheScope.run(runCallbacksImpl)
      } else {
        return runCallbacksImpl()
      }
    })
  }
}

function errorWaitUntilNotAvailable(): never {
  throw new Error(
    '`unstable_after()` will not work correctly, because `waitUntil` is not implemented for the current environment.'
  )
}

/** Disable mutations of `requestStore` within `after()` and disallow nested after calls.  */
function wrapRequestStoreForAfterCallbacks(
  requestStore: RequestStore
): RequestStore {
  return {
    get headers() {
      return requestStore.headers
    },
    get cookies() {
      return requestStore.cookies
    },
    get draftMode() {
      return requestStore.draftMode
    },
    // TODO(after): calling a `cookies.set()` in an after() that's in an action doesn't currently error.
    mutableCookies: new ResponseCookies(new Headers()),
    assetPrefix: requestStore.assetPrefix,
    reactLoadableManifest: requestStore.reactLoadableManifest,

    afterContext: {
      after: () => {
        throw new Error(
          'Cannot call `unstable_after()` from within `unstable_after()`'
        )
      },
      run: () => {
        throw new Error(
          'Invariant: Cannot call `AfterContext.run()` from within an `unstable_after()` callback'
        )
      },
    },
  }
}

function isPromise(p: unknown): p is Promise<unknown> {
  return (
    p !== null &&
    typeof p === 'object' &&
    'then' in p &&
    typeof p.then === 'function'
  )
}
