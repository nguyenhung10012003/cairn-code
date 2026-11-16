/**
 * `karst migrate`: moves what Cairn, as Karst was called before 0.2.0, kept in `~/.cairn` into
 * Karst's home. Cairn Code (github.com/cairn/cairn), a different program, uses `~/.cairn` too, so
 * this runs only when asked, moves only the names Cairn wrote there, and never replaces anything
 * already in Karst's home. Karst itself reads nothing from Cairn's places.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { APP_NAME, appHome, INSTRUCTION_FILE, LOCAL_INSTRUCTION_FILE, PROJECT_DIR } from '../config/paths.ts';

export const LEGACY_DIR = '.cairn';
export const LEGACY_INSTRUCTION_FILE = 'CAIRN.md';
export const LEGACY_LOCAL_INSTRUCTION_FILE = 'CAIRN.local.md';
const OTHER_PROGRAM = 'Cairn Code (github.com/cairn/cairn)';

export function legacyAppHome(): string {
  return join(homedir(), LEGACY_DIR);
}

/** What Cairn wrote in its home folder, and the name each has in Karst's. */
const KNOWN_ENTRIES: Record<string, string> = Object.fromEntries([
  ...[
    'settings.json', 'credentials.json', 'trust.json', 'mcp.json', 'loop.md', 'update.log',
    'workspaces', 'projects', 'memory', 'plans', 'file-history', 'background',
    'agents', 'skills', 'commands', 'rules', 'plugins', 'plugin-data', 'mcp-auth', 'mcp-logs',
  ].map((name) => [name, name]),
  [LEGACY_INSTRUCTION_FILE, INSTRUCTION_FILE],
]);
/** Only held while an update installs, so one left behind is stale and not worth keeping. */
const DISCARDED_ENTRIES = new Set(['update.lock']);

/** `~/.cairn` rather than the full path, which is easier to read. */
function shown(path: string): string {
  const home = homedir();
  return path === home ? '~' : path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

export interface MigrationReport {
  /** Paths, relative to the old folder, moved (or, in a dry run, to be moved). */
  moved: string[];
  /** Paths left in the old folder because the new one already has something there. */
  conflicts: string[];
  /** Top-level names left alone because Cairn did not write them. */
  unknown: string[];
  /** Files in the new folder that mention Cairn's variables or folders, which Karst does not read. */
  mentions: string[];
  errors: string[];
  /** Whether the old folder is gone afterwards. */
  removed: boolean;
}

function removeIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // Still in use, or already gone: either way there is nothing to do.
  }
}

/** Moves `from` to `to`, merging folder into folder, and records what it could not. */
function moveInto(from: string, to: string, relative: string, dryRun: boolean, report: MigrationReport): void {
  try {
    if (!existsSync(to)) {
      report.moved.push(relative);
      if (dryRun) return;
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      try {
        renameSync(from, to);
      } catch {
        // Another file system: copy, then remove what was copied.
        cpSync(from, to, { recursive: true, preserveTimestamps: true });
        rmSync(from, { recursive: true, force: true });
      }
      return;
    }
    if (lstatSync(from).isDirectory() && lstatSync(to).isDirectory()) {
      for (const entry of readdirSync(from).sort()) moveInto(join(from, entry), join(to, entry), join(relative, entry), dryRun, report);
      if (!dryRun) removeIfEmpty(from);
      return;
    }
    report.conflicts.push(relative);
  } catch (error) {
    report.errors.push(`${relative}: ${(error as Error).message}`);
  }
}

const OLD_NAMES = /CAIRN_|\.cairn\b|CAIRN\.md/;

/** Settings and MCP files that still name Cairn's variables or folders, which no longer work. */
function findMentions(home: string): string[] {
  const files = [join(home, 'settings.json'), join(home, 'mcp.json')];
  const workspaces = join(home, 'workspaces');
  if (existsSync(workspaces)) {
    for (const entry of readdirSync(workspaces).sort()) files.push(join(workspaces, entry, 'settings.json'), join(workspaces, entry, 'mcp.json'));
  }
  return files.filter((file) => {
    try {
      return OLD_NAMES.test(readFileSync(file, 'utf8'));
    } catch {
      return false;
    }
  });
}

export function migrateLegacyHome(options: { dryRun?: boolean } = {}): MigrationReport {
  const dryRun = options.dryRun === true;
  const from = legacyAppHome();
  const to = appHome();
  const report: MigrationReport = { moved: [], conflicts: [], unknown: [], mentions: [], errors: [], removed: false };
  for (const entry of readdirSync(from).sort()) {
    if (DISCARDED_ENTRIES.has(entry)) {
      if (!dryRun) rmSync(join(from, entry), { force: true });
      continue;
    }
    const target = KNOWN_ENTRIES[entry];
    if (target === undefined) {
      report.unknown.push(entry);
      continue;
    }
    moveInto(join(from, entry), join(to, target), entry, dryRun, report);
  }
  if (!dryRun) {
    removeIfEmpty(from);
    report.removed = !existsSync(from);
    report.mentions = findMentions(to);
  }
  return report;
}

/** Shown once, as Karst first starts on a machine that has `~/.cairn` and no home of its own yet. */
export function legacyHomeHint(): string | undefined {
  if (process.env.KARST_HOME !== undefined) return undefined;
  if (existsSync(appHome()) || !existsSync(legacyAppHome())) return undefined;
  return (
    `Found ${shown(legacyAppHome())}, from Cairn, as Karst was called before 0.2.0. Karst does not read it: ` +
    `run \`${APP_NAME} migrate\` to move your settings, keys, sessions and memory to ${shown(appHome())}. ` +
    `If it belongs to ${OTHER_PROGRAM}, leave it.`
  );
}

/** For `karst doctor`: Cairn's files that Karst sees but does not read. */
export function legacyFindings(cwd: string): string[] {
  const findings: string[] = [];
  if (existsSync(legacyAppHome()) && legacyAppHome() !== appHome()) {
    findings.push(
      `${shown(legacyAppHome())} is not read. If it is from cairn-code, \`${APP_NAME} migrate\` moves it to ${shown(appHome())}; if it belongs to ${OTHER_PROGRAM}, leave it`,
    );
  }
  const renames: [string, string][] = [
    [LEGACY_DIR, PROJECT_DIR],
    [LEGACY_INSTRUCTION_FILE, INSTRUCTION_FILE],
    [LEGACY_LOCAL_INSTRUCTION_FILE, LOCAL_INSTRUCTION_FILE],
  ];
  const found = renames.filter(([old]) => existsSync(join(cwd, old)));
  if (found.length > 0) {
    findings.push(
      `${found.map(([old]) => old).join(', ')} in this directory ${found.length === 1 ? 'is' : 'are'} not read. If written for cairn-code, rename to ${found.map(([, name]) => name).join(', ')}`,
    );
  }
  return findings;
}

const MIGRATE_USAGE = `Usage: ${APP_NAME} migrate [--dry-run]
Moves what Cairn, as Karst was called before 0.2.0, saved in ~/${LEGACY_DIR} into ~/${PROJECT_DIR} (or KARST_HOME): settings,
saved keys, trust, sessions, memory, plans, skills, agents, plugins and MCP sign-ins. ${LEGACY_INSTRUCTION_FILE} becomes ${INSTRUCTION_FILE}.
Nothing already in ~/${PROJECT_DIR} is replaced, and files Cairn did not write are left where they are, since
${OTHER_PROGRAM} uses ~/${LEGACY_DIR} too. --dry-run lists what would move and changes nothing.
`;

export function runMigrateCommand(args: string[]): number {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(MIGRATE_USAGE);
    return 0;
  }
  const unknown = args.find((arg) => arg !== '--dry-run');
  if (unknown !== undefined) {
    process.stderr.write(`Unknown argument: ${unknown}\n${MIGRATE_USAGE}`);
    return 2;
  }
  const dryRun = args.includes('--dry-run');
  const from = legacyAppHome();
  const to = appHome();
  if (from === to) {
    process.stderr.write(`KARST_HOME is ${shown(from)}, Cairn's own folder, so there is nowhere to move it. Set KARST_HOME to another folder, or unset it.\n`);
    return 2;
  }
  if (!existsSync(from)) {
    process.stdout.write(`There is no ${shown(from)}, so there is nothing to move.\n`);
    return 0;
  }
  const report = migrateLegacyHome({ dryRun });
  const lines: string[] = [];
  const list = (title: string, items: string[]): void => {
    if (items.length > 0) lines.push(title, ...items.map((item) => `  ${item}`));
  };
  // A merged folder lists every file moved into it, so show each top-level name once.
  const movedTop = [...new Set(report.moved.map((path) => path.split(sep)[0]!))];
  list(`${dryRun ? 'Would move' : 'Moved'} from ${shown(from)} to ${shown(to)}:`, movedTop.map((name) => (KNOWN_ENTRIES[name] === name ? name : `${name} (as ${KNOWN_ENTRIES[name]})`)));
  list(`${dryRun ? 'Would leave' : 'Left'} in ${shown(from)}, because ${shown(to)} already has them:`, report.conflicts);
  list(`${dryRun ? 'Would leave' : 'Left'} in ${shown(from)}, because Cairn did not write them (${OTHER_PROGRAM} may have):`, report.unknown);
  list(`These mention CAIRN_ variables, .cairn or ${LEGACY_INSTRUCTION_FILE}, which Karst does not read or set. Change them to KARST_, ${PROJECT_DIR} and ${INSTRUCTION_FILE}:`, report.mentions.map(shown));
  list('Could not move:', report.errors);
  if (lines.length === 0) lines.push(`${shown(from)} has nothing Cairn wrote, so nothing ${dryRun ? 'would move' : 'was moved'}.`);
  if (!dryRun && report.removed) lines.push(`${shown(from)} is now empty and was removed.`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return report.errors.length === 0 ? 0 : 1;
}
