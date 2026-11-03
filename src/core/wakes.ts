/**
 * Things that should start a turn without the user typing: background work finishing (its note
 * is already waiting in the conversation) and scheduled prompts coming due. The interactive UI
 * runs them when it is idle; print mode runs them before it exits.
 */
export class WakeQueue {
  private prompts: string[] = [];
  private notes = false;
  private readonly listeners = new Set<() => void>();

  /** A note for the model is waiting. */
  notify(): void {
    this.notes = true;
    this.emit();
  }

  /** A prompt to run as if the user had typed it. */
  prompt(text: string): void {
    this.prompts.push(text);
    this.emit();
  }

  pending(): boolean {
    return this.notes || this.prompts.length > 0;
  }

  /** Everything waiting, oldest first, and clears it. */
  take(): { prompts: string[]; notes: boolean } {
    const taken = { prompts: this.prompts, notes: this.notes };
    this.prompts = [];
    this.notes = false;
    return taken;
  }

  /** Calls `listener` whenever something new is waiting. Returns a function that stops it. */
  onWake(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves when something is waiting, or the signal fires. */
  wait(signal?: AbortSignal): Promise<void> {
    if (this.pending() || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        stop();
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const stop = this.onWake(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
