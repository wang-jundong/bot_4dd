/** One in-flight buy or sell per mint, shared by every strategy on this wallet. */
export class MintTradeLock {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(mint: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(mint) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.#tails.set(mint, run.then(() => undefined, () => undefined));
    return run;
  }
}
