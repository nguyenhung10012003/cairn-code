/**
 * The colors of the interactive screen, by what they mean rather than by name, drawn with chalk.
 *
 * Color is on only when stdout is a terminal and NO_COLOR is unset, so piped output stays plain.
 * Terminals with 256 colors or more get the palette below; the rest get the nearest of the
 * terminal's own 16 colors, so a user's color scheme still applies there.
 */
import { Chalk, supportsColor } from 'chalk';
import type { ChalkInstance, ColorSupportLevel, ForegroundColorName } from 'chalk';

function colorLevel(): ColorSupportLevel {
  if (process.stdout.isTTY !== true || process.env.NO_COLOR) return 0;
  return supportsColor ? supportsColor.level : 0;
}

const chalk = new Chalk({ level: colorLevel() });

/** Mid-tone colors, readable on dark and light backgrounds alike. */
const PALETTE = {
  accent: ['#22b8cf', 'cyan'],
  secondary: ['#9775fa', 'magenta'],
  success: ['#40c057', 'green'],
  warning: ['#fab005', 'yellow'],
  error: ['#fa5252', 'red'],
  info: ['#4dabf7', 'blue'],
  code: ['#ff922b', 'yellow'],
} as const satisfies Record<string, readonly [string, ForegroundColorName]>;

type Tone = keyof typeof PALETTE;

function tone(name: Tone): ChalkInstance {
  const [hex, ansi] = PALETTE[name];
  return chalk.level >= 2 ? chalk.hex(hex) : chalk[ansi];
}

type Paint = (text: string) => string;

/**
 * One argument each, so they can be passed to `map`: a chalk function given map's three
 * arguments would join them all into the text.
 */
const paint =
  (instance: ChalkInstance): Paint =>
  (text) =>
    instance(text);

export const style = {
  dim: paint(chalk.dim),
  bold: paint(chalk.bold),
  italic: paint(chalk.italic),
  underline: paint(chalk.underline),
  strike: paint(chalk.strikethrough),
  inverse: paint(chalk.inverse),
  accent: paint(tone('accent')),
  secondary: paint(tone('secondary')),
  success: paint(tone('success')),
  warning: paint(tone('warning')),
  error: paint(tone('error')),
  info: paint(tone('info')),
  /** Code inside a line of prose. */
  code: paint(tone('code')),
  /** Lines inside a fenced code block. */
  codeBlock: paint(tone('accent')),
  /** Box lines and rules that frame content without competing with it. */
  border: paint(tone('accent').dim),
  heading: paint(tone('accent').bold),
  /** The model's thinking while it streams. */
  thinking: paint(chalk.dim.italic),
  link: paint(tone('info').underline),
};

const hexToRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/**
 * Bold text that fades from the accent color to the secondary one, a character at a time. Plain
 * accent where the terminal has only 16 colors, since the steps would be too coarse.
 */
export function gradient(text: string): string {
  if (chalk.level < 2) return style.heading(text);
  const chars = [...text];
  const from = hexToRgb(PALETTE.accent[0]);
  const to = hexToRgb(PALETTE.secondary[0]);
  const steps = Math.max(1, chars.length - 1);
  return chars
    .map((char, i) => {
      if (char === ' ') return char;
      const [r, g, b] = from.map((start, c) => Math.round(start + ((to[c]! - start) * i) / steps)) as [number, number, number];
      return chalk.bold.rgb(r, g, b)(char);
    })
    .join('');
}

/** The color of a permission mode's badge before the prompt: the riskier the mode, the louder. */
export function modeStyle(mode: string): Paint {
  switch (mode) {
    case 'plan':
      return style.info;
    case 'acceptEdits':
      return style.secondary;
    case 'bypassPermissions':
      return (text) => style.error(style.bold(text));
    default:
      return style.warning;
  }
}
