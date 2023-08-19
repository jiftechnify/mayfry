/**
 * The data structure of Nostr event.
 */
export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type Result<T, E> =
  | {
      isOk: true;
      val: T;
    }
  | {
      isOk: false;
      err: E;
    };

export const Result = {
  ok<T>(val: T): Result<T, never> {
    return { isOk: true, val };
  },
  err<E>(err: E): Result<never, E> {
    return { isOk: false, err };
  },
};
