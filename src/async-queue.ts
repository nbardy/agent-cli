export interface AsyncQueue<T> {
  push: (value: T) => void;
  close: () => void;
  iterator: AsyncIterableIterator<T>;
}

export function createAsyncQueue<T>(): AsyncQueue<T> {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  const iterator: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (values.length > 0) {
        return Promise.resolve({ done: false, value: values.shift()! });
      }
      if (closed) {
        return Promise.resolve({ done: true, value: undefined as never });
      }
      return new Promise<IteratorResult<T>>((resolve) => {
        waiters.push(resolve);
      });
    },
  };

  return {
    iterator,
    push(value) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value });
        return;
      }
      values.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()!({ done: true, value: undefined as never });
      }
    },
  };
}
