/** Run `worker` over `items` with a bounded number of in-flight promises. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Rough token estimate. Good enough for chunk sizing; avoids a tokenizer dep. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
