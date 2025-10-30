import os from 'os';

const WINDOWS_PLATFORM = 'win32';

/**
 * Detects runtime system details for the CLI agent.
 * @returns {{ platform: NodeJS.Platform, release: string, arch: string, isWindows: boolean, shell: string, prettyName: string }}
 */
export const detectSystemInfo = () => {
  const platform = process.platform;
  const release = os.release();
  const arch = os.arch();
  const isWindows = platform === WINDOWS_PLATFORM;
  const shell =
    process.env.SHELL ||
    (isWindows ? process.env.COMSPEC || 'C:\\\\Windows\\\\System32\\\\cmd.exe' : '/bin/bash');
  const prettyName = `${os.type()} ${release} (${arch})`;

  return {
    platform,
    release,
    arch,
    isWindows,
    shell,
    prettyName,
  };
};

/**
 * Formats system details into a compact sentence suitable for a prompt.
 * @param {ReturnType<typeof detectSystemInfo>} info
 * @returns {string}
 */
export const formatSystemPrompt = (info) => {
  const parts = [
    `Host: ${info.prettyName}`,
    `Shell: ${info.shell}`,
    `Platform: ${info.platform}`,
  ];

  if (info.isWindows) {
    parts.push('Windows prefers commands such as "dir" for listing directories.');
  } else {
    parts.push('Unix-like environment supports standard POSIX utilities.');
  }

  return parts.join(' | ');
};
