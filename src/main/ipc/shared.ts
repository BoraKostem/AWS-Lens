import { createHandlerWrapper, type OperationOptions } from '../operations'

export type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }

export const wrap: <T>(
  fn: () => Promise<T> | T,
  label?: string,
  options?: OperationOptions
) => Promise<HandlerResult<T>> = createHandlerWrapper('ipc', { timeoutMs: 60000 })
