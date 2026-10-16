import { describe, expect, it } from 'vitest';
import { isAbsoluteFilesystemPath } from './paths';

describe('native absolute filesystem paths', () => {
  it.each([
    String.raw`C:\Users\Synthetic User\.codex`,
    'D:/資料/History & Space/.claude',
    String.raw`\\server\share\history`,
    '//server/share/history',
    String.raw`\\?\C:\Users\中文\.grok`,
    String.raw`\\?\UNC\server\share\history`,
    'C:\\',
    String.raw`\\server\share`,
  ])('accepts Windows drive, UNC and canonical picker paths: %s', (path) => {
    expect(isAbsoluteFilesystemPath(path, 'windows')).toBe(true);
  });

  it.each([
    '', 'relative', '~/.codex', 'C:relative', 'C:', '/Users/test/.codex',
    String.raw`\Users\test\.codex`, String.raw`\\server`, '\\\\server\\',
    String.raw`\\.\pipe\name`, String.raw`\\server\pipe\name`,
    String.raw`\\server\mailslot\name`, String.raw`\\?\GLOBALROOT\Device\HarddiskVolume1\history`,
    String.raw`\\?\C:/history`, String.raw`C:\history\file:stream`,
    String.raw`C:\history\CON`, String.raw`C:\history\nul.txt`,
    String.raw`C:\history\COM1`, String.raw`C:\history\LPT².txt`,
    String.raw`C:\history\CONOUT$`, String.raw`C:\history\..\outside`,
    'C:\\history\\trailing.', 'C:\\history\\trailing ',
    'C:\\history\\a\0b', 'C:\\history\\a\nb', 'C:\\history\\a\u0085b',
  ])('rejects ambiguous or non-filesystem Windows paths: %s', (path) => {
    expect(isAbsoluteFilesystemPath(path, 'windows')).toBe(false);
  });

  it.each(['/Users/test/.codex', '/home/中文/History & Space', '/'])('keeps POSIX paths: %s', (path) => {
    expect(isAbsoluteFilesystemPath(path, 'posix')).toBe(true);
  });
  it.each(['relative', '~/.codex', 'C:/history', String.raw`\\server\share`, '/history/\0'])('rejects non-POSIX paths: %s', (path) => {
    expect(isAbsoluteFilesystemPath(path, 'posix')).toBe(false);
  });
});
