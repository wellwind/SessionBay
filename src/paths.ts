export type PathPlatform = 'windows' | 'posix';

export function pathPlatform(): PathPlatform {
  return typeof navigator !== 'undefined' && /Win/i.test(navigator.platform) ? 'windows' : 'posix';
}

function windowsComponent(name: string): boolean {
  if (!name || /[. ]$|[:*?"<>|]/.test(name) || /\p{Cc}/u.test(name)) return false;
  const stem = name.split('.')[0].trimEnd().toUpperCase();
  return !/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])$/.test(stem);
}

/** Lexical UI check only: the native backend validates paths and opens sources. */
export function isAbsoluteFilesystemPath(value: string, platform = pathPlatform()): boolean {
  if (!value || /\p{Cc}/u.test(value)) return false;
  if (platform === 'posix') return value.startsWith('/');

  const verbatim = value.startsWith('\\\\?\\');
  if (verbatim && value.includes('/')) return false;
  let path = verbatim ? value.slice(4) : value.replaceAll('/', '\\');
  if (verbatim && path.startsWith('UNC\\')) path = `\\\\${path.slice(4)}`;
  let components: string[];
  if (/^[A-Za-z]:\\/.test(path)) {
    components = path.slice(3).split('\\');
  } else if (path.startsWith('\\\\')) {
    const [server, share, ...rest] = path.slice(2).split('\\');
    if (!windowsComponent(server ?? '') || !windowsComponent(share ?? '') || /^(pipe|mailslot)$/i.test(share)) return false;
    components = rest;
  } else {
    return false; // Includes drive-relative, root-relative and device namespaces.
  }
  return components.every((part) => !part || (!verbatim && part === '.') || windowsComponent(part));
}
