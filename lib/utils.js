import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import { fileURLToPath } from 'url';

export function getClientConfigPaths() {
  const homeDir = os.homedir();
  
  return [
    { name: 'Claude Code', path: path.join(homeDir, '.claude.json') },
    { name: 'Antigravity', path: path.join(homeDir, '.gemini', 'antigravity', 'mcp.json') },
    // Codex config placeholder - exact path depends on how Codex stores user config.
    // Assuming a common pattern here like ~/.codex/mcp.json or similar.
    { name: 'Codex', path: path.join(homeDir, '.codex', 'mcp.json') }
  ];
}

export function getExtensionPath() {
   // When bundled, we are in dist/cli.js, extension is at ../extension
   // When running from source (lib/utils.js), extension is at ../extension
   const __filename = fileURLToPath(import.meta.url);
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
    const __filename = fileURLToPath(import.meta.url);
    const currentDir = path.dirname(__filename);
    if (currentDir.endsWith('/dist') || currentDir.endsWith('\\dist')) {
      return path.resolve(currentDir, 'server.js');
    }
    return path.resolve(currentDir, '../dist/server.js');
}

export function getUserExtensionDir() {
    return path.join(os.homedir(), 'ghost-bridge', 'extension');
}
