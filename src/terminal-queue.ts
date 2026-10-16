/** Keeps IPC input writes ordered without allowing a stalled PTY to grow memory forever. */
export class TerminalInputQueue {
  private tail: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private generation = 0;
  constructor(
    private readonly send: (runtimeId: string, data: string) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    readonly limit = 256 * 1024,
  ) {}
  get pending() {
    return this.pendingBytes;
  }
  enqueue(runtimeId: string, data: string): boolean {
    const bytes = new TextEncoder().encode(data).byteLength;
    if (this.pendingBytes + bytes > this.limit) {
      this.onError(new Error('待送終端輸入已達 256 KiB 上限。請等待程序讀取後再試，或分段貼上。'));
      return false;
    }
    const generation = this.generation;
    this.pendingBytes += bytes;
    this.tail = this.tail
      .then(() => {
        if (generation === this.generation) return this.send(runtimeId, data);
      })
      .catch(this.onError)
      .finally(() => {
        this.pendingBytes -= bytes;
      });
    return true;
  }
  /** Discard unsent input from a detached stream; already-sent writes cannot be recalled. */
  cancel(): void {
    this.generation += 1;
  }
  async drained(): Promise<void> {
    await this.tail;
  }
}
