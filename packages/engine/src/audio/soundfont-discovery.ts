/**
 * Local SoundFont discovery for the automatic sample backend.
 *
 * Discovery is deliberately filesystem-only: it never downloads, extracts, or
 * writes anything. Callers may still configure an explicit SoundFont; this
 * module is only the "find a provisioned font without manual setup" path.
 *
 * Search order is stable and documented:
 *
 * 1. `VAMP_SOUNDFONT_PATH`
 * 2. `VAMP_SOUNDFONT_DIR` (preferred font names first, then alphabetical)
 * 3. The Vamp data directory (`$XDG_DATA_HOME/vamp/soundfonts` or
 *    `~/.local/share/vamp/soundfonts`)
 * 4. Standard system SoundFont directories for the host platform
 *
 * A candidate must be a regular file, at least 1 MiB, and start with a
 * RIFF/sfbk header. SoundFonts below that size are almost always fragments or
 * unrelated assets. `.sf2` is preferred over `.sf3` because the pinned
 * FluidR3 checksum and the widest FluidSynth support target SF2.
 */

import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SoundFontDiscoverySource =
  'environment-file' | 'environment-directory' | 'vamp-data' | 'system' | 'custom';

export interface DiscoveredSoundFont {
  /** Absolute path to the provisioned font. */
  readonly path: string;
  readonly source: SoundFontDiscoverySource;
  readonly bytes: number;
  readonly fileName: string;
}

export interface SoundFontDiscoveryResult {
  readonly soundFont: DiscoveredSoundFont | null;
  /** Every path consulted, in order, for diagnostics. */
  readonly searchedPaths: readonly string[];
}

export interface SoundFontDiscoveryOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  /** Extra directories to scan after the standard locations. */
  readonly extraDirectories?: readonly string[];
}

const MIN_SOUNDFONT_BYTES = 1_048_576;

const PREFERRED_FONT_PATTERN =
  /(generaluser|fluidr3[_ -]?gm|musescore[_ -]?general|default[-_ ]?gm|default)/i;

const SOUNDFONT_EXTENSION_PATTERN = /\.sf[23]$/i;

function systemDirectories(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  if (platform === 'win32') {
    const programData = env.ProgramData ?? 'C:\\ProgramData';
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
    const appData = env.APPDATA;
    return [
      join(programData, 'Vamp', 'soundfonts'),
      join(programData, 'soundfonts'),
      join(programFiles, 'FluidSynth', 'soundfonts'),
      ...(appData === undefined ? [] : [join(appData, 'Vamp', 'soundfonts')]),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/opt/homebrew/share/soundfonts',
      '/opt/homebrew/share/fluid-synth',
      '/usr/local/share/soundfonts',
      '/usr/local/share/fluid-synth',
      '/Library/Audio/Sounds/Banks',
      '/usr/share/sounds/sf2',
    ];
  }
  return [
    '/usr/share/sounds/sf2',
    '/usr/share/soundfonts',
    '/usr/local/share/sounds/sf2',
    '/usr/local/share/soundfonts',
    '/opt/soundfonts',
  ];
}

function dataDirectories(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg.trim().length > 0 ? xdg : join(home, '.local', 'share');
  return [join(base, 'vamp', 'soundfonts')];
}

export function soundFontSearchDirectories(
  options: SoundFontDiscoveryOptions = {},
): Array<{ directory: string; source: SoundFontDiscoverySource }> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const directories: Array<{ directory: string; source: SoundFontDiscoverySource }> = [];
  const seen = new Set<string>();
  const add = (directory: string | undefined, source: SoundFontDiscoverySource): void => {
    if (directory === undefined || directory.trim().length === 0) {
      return;
    }
    const key = directory.trim();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    directories.push({ directory: key, source });
  };

  add(env.VAMP_SOUNDFONT_DIR, 'environment-directory');
  for (const directory of dataDirectories(home, env)) {
    add(directory, 'vamp-data');
  }
  for (const directory of systemDirectories(platform, env)) {
    add(directory, 'system');
  }
  for (const directory of options.extraDirectories ?? []) {
    add(directory, 'custom');
  }
  return directories;
}

function preferredFirst(a: string, b: string): number {
  const aPreferred = PREFERRED_FONT_PATTERN.test(a);
  const bPreferred = PREFERRED_FONT_PATTERN.test(b);
  if (aPreferred !== bPreferred) {
    return aPreferred ? -1 : 1;
  }
  const aSf2 = /\.sf2$/i.test(a);
  const bSf2 = /\.sf2$/i.test(b);
  if (aSf2 !== bSf2) {
    return aSf2 ? -1 : 1;
  }
  return a.localeCompare(b);
}

async function isUsableSoundFont(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < MIN_SOUNDFONT_BYTES) {
      return null;
    }
    const handle = await open(path, 'r');
    try {
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, 12, 0);
      if (
        bytesRead < 12 ||
        header.toString('ascii', 0, 4) !== 'RIFF' ||
        header.toString('ascii', 8, 12) !== 'sfbk'
      ) {
        return null;
      }
    } finally {
      await handle.close();
    }
    return info.size;
  } catch {
    return null;
  }
}

async function candidateFromFile(
  path: string,
  source: SoundFontDiscoverySource,
): Promise<DiscoveredSoundFont | null> {
  const bytes = await isUsableSoundFont(path);
  if (bytes === null) {
    return null;
  }
  return {
    path,
    source,
    bytes,
    fileName: path.split(/[\\/]/).at(-1) ?? path,
  };
}

/**
 * Find a provisioned SoundFont without network access.
 *
 * The function never throws for missing directories or unreadable files. It
 * returns the first usable candidate and the full search list for diagnostics.
 */
export async function discoverSoundFont(
  options: SoundFontDiscoveryOptions = {},
): Promise<SoundFontDiscoveryResult> {
  const env = options.env ?? process.env;
  const searchedPaths: string[] = [];
  const explicit = env.VAMP_SOUNDFONT_PATH?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    searchedPaths.push(explicit);
    const found = await candidateFromFile(explicit, 'environment-file');
    if (found !== null) {
      return { soundFont: found, searchedPaths };
    }
  }

  for (const { directory, source } of soundFontSearchDirectories(options)) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = entries
      .filter(
        (entry) =>
          (entry.isFile() || entry.isSymbolicLink()) &&
          SOUNDFONT_EXTENSION_PATTERN.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort(preferredFirst);
    for (const name of names) {
      const path = join(directory, name);
      searchedPaths.push(path);
      const found = await candidateFromFile(path, source);
      if (found !== null) {
        return { soundFont: found, searchedPaths };
      }
    }
  }

  return { soundFont: null, searchedPaths };
}

/** Compact human-readable setup instructions used by CLI and MCP hints. */
export const SOUNDFONT_SETUP_HINT =
  'Install FluidSynth 2.x and provision a GM SoundFont. On Debian/Ubuntu run "sudo apt install fluidsynth fluid-soundfont-gm"; on macOS use Homebrew for FluidSynth and place a GM .sf2 in ~/.local/share/vamp/soundfonts/. You can also set VAMP_SOUNDFONT_PATH to an absolute .sf2 path. Vamp never downloads a SoundFont during a render.';
