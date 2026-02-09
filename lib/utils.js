import path from 'path';
import fs from 'fs-extra';
import os from 'os';

export function getClaudeConfigPath() {
  const homeDir = os.homedir();
  // Claude Code CLI uses ~/.claude.json
  return path.join(homeDir, '.claude.json');
}

export function getExtensionPath() {
   // When bundled, we are in dist/cli.js, extension is at ../extension
   // When running from source (lib/utils.js), extension is at ../extension
   const __filename = new URL(import.meta.url).pathname;
   const currentDir = path.dirname(__filename);
   // Check if we're in dist/ or lib/
   if (currentDir.endsWith('/dist') || currentDir.endsWith('\\dist')) {
     return path.resolve(currentDir, '../extension');
   }
   return path.resolve(currentDir, '../extension');
}

export function getServerPath() {
    // When bundled, server is at dist/server.js
    // When running from source, server is at src/server.js
    const __filename = new URL(import.meta.url).pathname;
    const currentDir = path.dirname(__filename);
    if (currentDir.endsWith('/dist') || currentDir.endsWith('\\dist')) {
      return path.resolve(currentDir, 'server.js');
    }
    return path.resolve(currentDir, '../dist/server.js');
}

export function getUserExtensionDir() {
    return path.join(os.homedir(), '.ghost-bridge', 'extension');
}
