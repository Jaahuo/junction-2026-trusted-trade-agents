export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type Brand<T, B extends string> = T & { readonly __brand: B };

export const newId = <B extends string>(): Brand<string, B> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a brand exists only in the type system, so minting one needs a cast
  crypto.randomUUID() as Brand<string, B>;
