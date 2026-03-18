import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const SERVER_NAME = 'ghost-bridge';

function getHomeDir() {
  return os.homedir();
}

function getJsonClientDefinition(name, configPath, options = {}) {
  return {
    name,
    kind: 'json',
    configPath,
    shouldCreate: Boolean(options.shouldCreate),
    isAvailable() {
      return options.isAvailable ? options.isAvailable() : fs.existsSync(configPath);
    }
  };
}

export function getClientDefinitions() {
  const homeDir = getHomeDir();
  const claudeDir = path.join(homeDir, '.claude');
  const claudeSettingsPath = path.join(claudeDir, 'settings.json');
  const claudeLegacyPath = path.join(homeDir, '.claude.json');
  const cursorDir = path.join(homeDir, '.cursor');
  const antigravityDir = path.join(homeDir, '.gemini', 'antigravity');

  return [
    getJsonClientDefinition('Claude Code', fs.existsSync(claudeSettingsPath) ? claudeSettingsPath : claudeLegacyPath, {
      shouldCreate: true,
      isAvailable: () => fs.existsSync(claudeDir) || fs.existsSync(claudeLegacyPath)
    }),
    {
      name: 'Codex',
      kind: 'toml',
      configPath: path.join(homeDir, '.codex', 'config.toml'),
      shouldCreate: fs.existsSync(path.join(homeDir, '.codex')),
      isAvailable() {
        return fs.existsSync(path.join(homeDir, '.codex'));
      }
    },
    getJsonClientDefinition('Cursor', path.join(cursorDir, 'mcp.json'), {
      shouldCreate: fs.existsSync(cursorDir),
      isAvailable: () => fs.existsSync(cursorDir)
    }),
    getJsonClientDefinition('Antigravity', path.join(antigravityDir, 'mcp.json'), {
      shouldCreate: fs.existsSync(antigravityDir),
      isAvailable: () => fs.existsSync(antigravityDir)
    })
  ];
}

function getTomlSectionHeader(serverName = SERVER_NAME) {
  return `[mcp_servers.${serverName}]`;
}

function buildTomlSection(config, serverName = SERVER_NAME) {
  return [
    getTomlSectionHeader(serverName),
    `type = ${JSON.stringify(config.type || 'stdio')}`,
    `command = ${JSON.stringify(config.command)}`,
    `args = ${JSON.stringify(config.args || [])}`
  ].join('\n');
}

function findTomlSectionRange(content, serverName = SERVER_NAME) {
  const header = getTomlSectionHeader(serverName);
  const lines = content.split('\n');
  const start = lines.findIndex((line) => line.trim() === header);

  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^\s*\[/.test(lines[index])) {
      end = index;
      break;
    }
  }

  return { start, end, lines };
}

function parseTomlStringValue(line, key) {
  const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*"(.*)"\\s*$`));
  return match ? JSON.parse(`"${match[1].replace(/"/g, '\\"')}"`) : null;
}

function parseTomlArgsValue(line) {
  const match = line.match(/^\s*args\s*=\s*(\[.*\])\s*$/);
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function readTomlMcpServer(content, serverName = SERVER_NAME) {
  const range = findTomlSectionRange(content, serverName);
  if (!range) {
    return null;
  }

  const sectionLines = range.lines.slice(range.start + 1, range.end);
  const config = {
    type: 'stdio',
    command: null,
    args: []
  };

  for (const line of sectionLines) {
    const type = parseTomlStringValue(line, 'type');
    if (type) {
      config.type = type;
      continue;
    }

    const command = parseTomlStringValue(line, 'command');
    if (command) {
      config.command = command;
      continue;
    }

    const args = parseTomlArgsValue(line);
    if (args) {
      config.args = args;
    }
  }

  return config.command ? config : null;
}

export function upsertTomlMcpServer(content, config, serverName = SERVER_NAME) {
  const section = buildTomlSection(config, serverName);
  const range = findTomlSectionRange(content, serverName);

  if (!range) {
    const trimmed = content.trimEnd();
    return trimmed ? `${trimmed}\n\n${section}\n` : `${section}\n`;
  }

  const before = range.lines.slice(0, range.start).join('\n');
  const after = range.lines.slice(range.end).join('\n');
  const parts = [before.trimEnd(), section, after.trimStart()].filter(Boolean);
  return `${parts.join('\n\n')}\n`;
}

export async function readClientConfiguration(client) {
  if (!fs.existsSync(client.configPath)) {
    return null;
  }

  if (client.kind === 'toml') {
    const content = await fs.readFile(client.configPath, 'utf8');
    return readTomlMcpServer(content);
  }

  try {
    const json = await fs.readJson(client.configPath);
    return json.mcpServers?.[SERVER_NAME] || null;
  } catch {
    return null;
  }
}

export async function writeClientConfiguration(client, config) {
  await fs.ensureDir(path.dirname(client.configPath));

  if (client.kind === 'toml') {
    const content = fs.existsSync(client.configPath)
      ? await fs.readFile(client.configPath, 'utf8')
      : '';
    const nextContent = upsertTomlMcpServer(content, config);
    await fs.writeFile(client.configPath, nextContent, 'utf8');
    return;
  }

  const json = fs.existsSync(client.configPath)
    ? await fs.readJson(client.configPath)
    : {};
  json.mcpServers = json.mcpServers || {};
  json.mcpServers[SERVER_NAME] = {
    command: config.command,
    args: config.args
  };
  await fs.writeJson(client.configPath, json, { spaces: 2 });
}

export function isClientManaged(client) {
  return client.shouldCreate || client.isAvailable();
}

