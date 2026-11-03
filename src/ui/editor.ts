/**
 * The text being typed at the main prompt, edited key by key. It stays live while the agent
 * works, so it is drawn by the footer rather than by readline.
 */

/** Characters, not UTF-16 units, so a cursor never lands inside an emoji. */
function chars(text: string): string[] {
  return [...text];
}

const WORD = /[\p{L}\p{N}_]/u;

export class LineEditor {
  private buffer: string[] = [];
  /** Index into the characters. */
  cursor = 0;
  private readonly history: string[] = [];
  /** Where Up and Down are in the history, with what was being typed before. */
  private browsing: { index: number; draft: string } | undefined;

  get text(): string {
    return this.buffer.join('');
  }

  setText(text: string): void {
    this.buffer = chars(text);
    this.cursor = this.buffer.length;
    this.browsing = undefined;
  }

  /** Returns the text, remembers it for Up, and clears the line. */
  take(): string {
    const text = this.text;
    if (text.trim() && this.history.at(-1) !== text) this.history.push(text);
    if (this.history.length > 500) this.history.shift();
    this.setText('');
    return text;
  }

  insert(text: string): void {
    const added = chars(text);
    this.buffer.splice(this.cursor, 0, ...added);
    this.cursor += added.length;
    this.browsing = undefined;
  }

  backspace(): void {
    if (this.cursor === 0) return;
    this.buffer.splice(this.cursor - 1, 1);
    this.cursor--;
  }

  deleteForward(): void {
    this.buffer.splice(this.cursor, 1);
  }

  left(): void {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  right(): void {
    this.cursor = Math.min(this.buffer.length, this.cursor + 1);
  }

  home(): void {
    // To the start of the current line, for text that spans several.
    while (this.cursor > 0 && this.buffer[this.cursor - 1] !== '\n') this.cursor--;
  }

  end(): void {
    while (this.cursor < this.buffer.length && this.buffer[this.cursor] !== '\n') this.cursor++;
  }

  wordLeft(): void {
    while (this.cursor > 0 && !WORD.test(this.buffer[this.cursor - 1]!)) this.cursor--;
    while (this.cursor > 0 && WORD.test(this.buffer[this.cursor - 1]!)) this.cursor--;
  }

  wordRight(): void {
    while (this.cursor < this.buffer.length && !WORD.test(this.buffer[this.cursor]!)) this.cursor++;
    while (this.cursor < this.buffer.length && WORD.test(this.buffer[this.cursor]!)) this.cursor++;
  }

  deleteWordBack(): void {
    const end = this.cursor;
    this.wordLeft();
    this.buffer.splice(this.cursor, end - this.cursor);
  }

  deleteToStart(): void {
    const end = this.cursor;
    this.home();
    this.buffer.splice(this.cursor, end - this.cursor);
  }

  deleteToEnd(): void {
    const start = this.cursor;
    this.end();
    this.buffer.splice(start, this.cursor - start);
    this.cursor = start;
  }

  /** Up: the previous message sent. False when there is none. */
  historyBack(): boolean {
    if (this.history.length === 0) return false;
    const index = this.browsing ? this.browsing.index - 1 : this.history.length - 1;
    if (index < 0) return false;
    const draft = this.browsing?.draft ?? this.text;
    this.setText(this.history[index]!);
    this.browsing = { index, draft };
    return true;
  }

  /** Down: the next message sent, then back to what was being typed. */
  historyForward(): boolean {
    if (!this.browsing) return false;
    const { index, draft } = this.browsing;
    if (index + 1 >= this.history.length) {
      this.setText(draft);
      return true;
    }
    this.setText(this.history[index + 1]!);
    this.browsing = { index: index + 1, draft };
    return true;
  }
}
