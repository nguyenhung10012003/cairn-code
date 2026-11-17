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

type Palette = Record<'accent' | 'secondary' | 'success' | 'warning' | 'error' | 'info' | 'code', readonly [string, ForegroundColorName]>;

/**
 * The themes `"theme"` and /theme choose from. Each tone has a color for terminals with 256 colors
 * or more, and the nearest of the terminal's own 16 for the rest.
 */
export const THEMES = {
  /** Mid-tone colors, readable on dark and light backgrounds alike. */
  default: {
    accent: ['#22b8cf', 'cyan'],
    secondary: ['#9775fa', 'magenta'],
    success: ['#40c057', 'green'],
    warning: ['#fab005', 'yellow'],
    error: ['#fa5252', 'red'],
    info: ['#4dabf7', 'blue'],
    code: ['#ff922b', 'yellow'],
  },
  /** Lighter colors, for a dark background. */
  dark: {
    accent: ['#66d9e8', 'cyanBright'],
    secondary: ['#b197fc', 'magentaBright'],
    success: ['#8ce99a', 'greenBright'],
    warning: ['#ffe066', 'yellowBright'],
    error: ['#ff8787', 'redBright'],
    info: ['#74c0fc', 'blueBright'],
    code: ['#ffc078', 'yellowBright'],
  },
  /** Deeper colors, for a light background. */
  light: {
    accent: ['#0b7285', 'cyan'],
    secondary: ['#6741d9', 'magenta'],
    success: ['#2b8a3e', 'green'],
    warning: ['#e67700', 'yellow'],
    error: ['#c92a2a', 'red'],
    info: ['#1864ab', 'blue'],
    code: ['#d9480f', 'red'],
  },
  /** Blue for success and orange for errors, which red-green color blindness tells apart. */
  colorblind: {
    accent: ['#22b8cf', 'cyan'],
    secondary: ['#9775fa', 'magenta'],
    success: ['#339af0', 'blue'],
    warning: ['#fcc419', 'yellow'],
    error: ['#ff922b', 'yellow'],
    info: ['#66d9e8', 'cyan'],
    code: ['#e599f7', 'magenta'],
  },
  /** Only the terminal's own 16 colors, so its color scheme decides how everything looks. */
  ansi: {
    accent: ['', 'cyan'],
    secondary: ['', 'magenta'],
    success: ['', 'green'],
    warning: ['', 'yellow'],
    error: ['', 'red'],
    info: ['', 'blue'],
    code: ['', 'yellow'],
  },
} as const satisfies Record<string, Palette>;

export type ThemeName = keyof typeof THEMES;
let palette: Palette = THEMES.default;
let themeName: ThemeName = 'default';

type Tone = keyof Palette;
function tone(name: Tone): ChalkInstance {
  const [hex, ansi] = palette[name];
  return chalk.level >= 2 && hex ? chalk.hex(hex) : chalk[ansi];
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

function buildStyle() {
  return {
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
}

export const style = buildStyle();

export function currentTheme(): ThemeName {
  return themeName;
}

export function isThemeName(name: string): name is ThemeName {
  return Object.hasOwn(THEMES, name);
}

/**
 * Switches every color to another theme. The functions in `style` are replaced in place, so code
 * that reads `style.error` when it draws gets the new colors.
 */
export function setTheme(name: string): boolean {
  if (!isThemeName(name)) return false;
  themeName = name;
  palette = THEMES[name];
  Object.assign(style, buildStyle());
  return true;
}

const hexToRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/**
 * Bold text that fades from the accent color to the secondary one, a character at a time. Plain
 * accent where the terminal has only 16 colors, since the steps would be too coarse.
 */
export function gradient(text: string): string {
  if (chalk.level < 2 || !palette.accent[0] || !palette.secondary[0]) return style.heading(text);
  const chars = [...text];
  const from = hexToRgb(palette.accent[0]);
  const to = hexToRgb(palette.secondary[0]);
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
