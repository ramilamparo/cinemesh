// contextBridge drops custom Error properties, so every cross-process call returns a plain union.
export type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function err<T = never>(code: string, message: string): Result<T> {
  return { ok: false, code, message }
}

export class CodedError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CodedError'
    this.code = code
  }
}
