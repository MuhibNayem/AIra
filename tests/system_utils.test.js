import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'os';
import { formatSystemPrompt, detectSystemInfo } from '../src/utils/system.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('system utils', () => {
  it('formats system prompt with environment context', () => {
    const prompt = formatSystemPrompt({
      prettyName: 'TestOS 1.0 (x64)',
      shell: '/bin/zsh',
      platform: 'darwin',
      isWindows: false,
    });

    expect(prompt).toContain('Host: TestOS 1.0 (x64)');
    expect(prompt).toContain('Shell: /bin/zsh');
    expect(prompt).toContain('Platform: darwin');
    expect(prompt).toContain('Unix-like environment supports standard POSIX utilities.');
  });

  it('adds Windows guidance when applicable', () => {
    const prompt = formatSystemPrompt({
      prettyName: 'Windows Test 11',
      shell: 'C\\\Windows\\\System32\\\cmd.exe',
      platform: 'win32',
      isWindows: true,
    });

    expect(prompt).toContain('Windows prefers commands such as "dir"');
  });

  it('detects system info on Windows hosts', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const releaseSpy = vi.spyOn(os, 'release').mockReturnValue('10.0.0');
    const archSpy = vi.spyOn(os, 'arch').mockReturnValue('x64');
    const typeSpy = vi.spyOn(os, 'type').mockReturnValue('Windows_NT');
    const originalComspec = process.env.COMSPEC;
    const originalShell = process.env.SHELL;
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    delete process.env.SHELL;

    const info = detectSystemInfo();

    expect(info.isWindows).toBe(true);
    expect(info.shell.toLowerCase()).toContain('cmd.exe');
    expect(info.platform).toBe('win32');
    expect(info.prettyName).toContain('Windows_NT');

    platformSpy.mockRestore();
    releaseSpy.mockRestore();
    archSpy.mockRestore();
    typeSpy.mockRestore();
    if (originalComspec === undefined) {
      delete process.env.COMSPEC;
    } else {
      process.env.COMSPEC = originalComspec;
    }
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
  });

  it('falls back to default Windows shell when COMSPEC missing', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const releaseSpy = vi.spyOn(os, 'release').mockReturnValue('10.0.0');
    const archSpy = vi.spyOn(os, 'arch').mockReturnValue('x64');
    const typeSpy = vi.spyOn(os, 'type').mockReturnValue('Windows_NT');
    const originalComspec = process.env.COMSPEC;
    const originalShell = process.env.SHELL;
    delete process.env.COMSPEC;
    delete process.env.SHELL;

    const info = detectSystemInfo();
    expect(info.shell.toLowerCase()).toContain('cmd.exe');

    if (originalComspec === undefined) {
      delete process.env.COMSPEC;
    } else {
      process.env.COMSPEC = originalComspec;
    }
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
    platformSpy.mockRestore();
    releaseSpy.mockRestore();
    archSpy.mockRestore();
    typeSpy.mockRestore();
  });

  it('detects system info using default shell when available', () => {
    const info = detectSystemInfo();
    expect(info.platform).toBe(process.platform);
    expect(info.shell).toBe(process.env.SHELL || (info.isWindows ? process.env.COMSPEC || 'C\\Windows\\System32\\cmd.exe' : '/bin/bash'));
  });
});
