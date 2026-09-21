// runs fn over inputs with at most limit in flight, results in input order
export async function pool<I, O>(inputs: I[], limit: number, fn: (input: I) => Promise<O>): Promise<O[]> {
  const out = new Array<O>(inputs.length);
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const i = next++;
      out[i] = await fn(inputs[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, inputs.length)) }, worker));
  return out;
}
