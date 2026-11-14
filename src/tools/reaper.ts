/**
 * Stops a session's background processes when Cairn's own process ends without stopping them:
 * a crash, `kill -9`, or the terminal window closing. Commands run detached, in process groups
 * of their own, so nothing else would end them.
 *
 * A small shell process reads the groups to watch from a pipe. Whenever Cairn's process ends, by
 * any means, the operating system closes its end of the pipe, and the shell then signals every
 * group still on its list: TERM, then KILL two seconds later. A group that ends is taken off the
 * list, so a clean shutdown leaves it nothing to do.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

// Only numbers Cairn writes itself reach this, one per line.
const SCRIPT = `
groups=" "
while IFS= read -r line; do
  case "$line" in
    +*) groups="$groups\${line#+} " ;;
    -*) groups=$(printf '%s' "$groups" | sed "s/ \${line#-} / /") ;;
  esac
done
[ "$groups" = " " ] && exit 0
for g in $groups; do kill -TERM -"$g" 2>/dev/null; done
sleep 2
for g in $groups; do kill -KILL -"$g" 2>/dev/null; done
`;

export class Reaper {
  private child: ChildProcess | undefined;
  private readonly watched = new Set<number>();
  private closed = false;

  /** Started with the first group, so a session without background work runs no extra process. */
  private start(): ChildProcess | undefined {
    if (this.child || this.closed) return this.child;
    try {
      // Detached, so a terminal closing or Ctrl+C reaching Cairn's group does not end it first.
      // It needs only sed and sleep, so it gets none of Cairn's environment, keys included.
      const child = spawn('/bin/sh', ['-c', SCRIPT], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
      child.on('error', () => {});
      child.stdin!.on('error', () => {});
      child.unref();
      // The pipe must not keep Cairn running; it only has to close when Cairn ends.
      (child.stdin as unknown as { unref?: () => void }).unref?.();
      this.child = child;
    } catch {
      return undefined;
    }
    return this.child;
  }

  /** The watcher process, once it runs. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  add(pgid: number | undefined): void {
    if (pgid === undefined || this.watched.has(pgid)) return;
    this.watched.add(pgid);
    this.start()?.stdin?.write(`+${pgid}\n`);
  }

  remove(pgid: number | undefined): void {
    if (pgid === undefined || !this.watched.delete(pgid)) return;
    this.child?.stdin?.write(`-${pgid}\n`);
  }

  /**
   * At shutdown, after the session stopped its work: whatever has not exited yet gets KILL if it
   * ignores TERM, even though Cairn itself is about to exit and cannot send it.
   */
  close(): void {
    this.closed = true;
    this.child?.stdin?.end();
  }
}
