export async function* mapOrdered<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): AsyncGenerator<R> {
  const inFlight: Promise<R>[] = [];
  let next = 0;
  while (next < items.length || inFlight.length > 0) {
    while (inFlight.length < limit && next < items.length) {
      const promise = work(items[next++]);
      promise.catch(() => {}); // The rejection is propagated when awaited in order below.
      inFlight.push(promise);
    }
    yield await inFlight.shift()!;
  }
}
