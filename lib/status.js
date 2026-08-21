import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getUserExtensionDir, getServerCommandConfig, getExtensionPath } from './utils.js';
import { getClientDefinitions, readClientConfiguration } from './clients.js';

const execFileAsync = promisify(execFile);
const PORT_INFO_FILE = path.join(os.tmpdir(), 'ghost-bridge-port.json');

function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

async function getProcessCommand(pid) {
    try {
        const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
        return stdout.trim();
    } catch {
        return '';
    }
}

async function readActiveServiceInfo() {
    if (!fs.existsSync(PORT_INFO_FILE)) {
        return null;
    }

    try {
        return await fs.readJson(PORT_INFO_FILE);
    } catch {
        return null;
    }
}

async function hashFile(filePath) {
    const content = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

async function collectExtensionFiles(rootDir, currentDir = rootDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        if (entry.name === '.DS_Store' || entry.name === '.ghost-bridge-managed') {
            continue;
        }

        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectExtensionFiles(rootDir, fullPath));
        } else if (entry.isFile()) {
            files.push(path.relative(rootDir, fullPath));
        }
    }

    return files.sort();
}

async function getExtensionSyncStatus(sourceDir, targetDir) {
    if (!fs.existsSync(sourceDir)) {
        return { ok: false, reason: `Source extension directory not found: ${sourceDir}` };
    }
    if (!fs.existsSync(targetDir)) {
        return { ok: false, reason: 'Extension directory is not installed' };
    }

    const sourceFiles = await collectExtensionFiles(sourceDir);
    const targetFiles = await collectExtensionFiles(targetDir);
    const sourceSet = new Set(sourceFiles);
    const targetSet = new Set(targetFiles);

    const missing = sourceFiles.filter((file) => !targetSet.has(file));
    if (missing.length > 0) {
        return { ok: false, reason: `Installed extension is missing ${missing[0]}` };
    }

    const extra = targetFiles.filter((file) => !sourceSet.has(file));

    for (const file of sourceFiles) {
        const sourceHash = await hashFile(path.join(sourceDir, file));
        const targetHash = await hashFile(path.join(targetDir, file));
        if (sourceHash !== targetHash) {
            return { ok: false, reason: `Installed extension differs at ${file}` };
        }
    }

    return { ok: true, extraFile: extra[0] };
}

export async function status() {
    console.log(chalk.bold('👻 Ghost Bridge Status'));
    
    const clients = getClientDefinitions();
    const extDir = getUserExtensionDir();
    const sourceExtDir = getExtensionPath();
    const serverConfig = getServerCommandConfig();

    console.log(chalk.bold.blue('\nMCP Client Configurations:'));
    let configuredCount = 0;

    for (const client of clients) {
        let mcpStatus = chalk.gray('Not Configured');
        let mcpDetails = '';
        const configPath = client.configPath;
        
        if (fs.existsSync(configPath)) {
            try {
                const config = await readClientConfiguration(client);
                if (config) {
                    mcpStatus = chalk.green('Configured');
                    const configuredCommand = config.command;
                    const configuredPath = config.args?.[0];
                    if (configuredCommand === serverConfig.command && configuredPath === serverConfig.args[0]) {
                        mcpDetails = chalk.dim('(Paths match)');
                    } else {
                        mcpDetails = chalk.yellow(
                          `(Path mismatch) \n      Configured: ${configuredCommand} ${configuredPath || ''}\n      Current:    ${serverConfig.command} ${serverConfig.args[0]}`
                        );
                    }
                    configuredCount++;
                }
            } catch (e) {
                mcpStatus = chalk.red('Error reading config');
            }
        } else {
            if (client.shouldCreate) {
                mcpStatus = chalk.yellow('Config file not found');
            } else {
                mcpStatus = chalk.gray('Not Installed');
            }
        }

        console.log(`  ${chalk.bold(client.name)}: ${mcpStatus} ${mcpDetails}`);
        console.log(`    Config File: ${chalk.dim(configPath)}`);
    }

    if (configuredCount === 0) {
        console.log(chalk.yellow('\n  No MCP clients currently have ghost-bridge configured. Run `ghost-bridge init`.'));
    }

    console.log(chalk.bold.blue('\nActive WebSocket Service:'));
    const activeService = await readActiveServiceInfo();
    if (!activeService || !activeService.pid || !activeService.port) {
        console.log(`  ${chalk.yellow('Not Running')}`);
        console.log(`  Port Info: ${chalk.dim(PORT_INFO_FILE)}`);
    } else {
        const running = isProcessRunning(activeService.pid);
        const activeCommand = running ? await getProcessCommand(activeService.pid) : '';
        const currentServerPath = path.resolve(serverConfig.args[0]);
        const activeServerPath = activeService.serverPath
            ? path.resolve(activeService.serverPath)
            : '';
        const statusText = running ? chalk.green('Running') : chalk.red('Stale port file');
        console.log(`  Status: ${statusText}`);
        console.log(`  Port: ${chalk.cyan(activeService.port)}`);
        console.log(`  PID: ${chalk.cyan(activeService.pid)}`);
        if (activeService.version) {
            console.log(`  Version: ${chalk.cyan(activeService.version)}`);
        } else {
            console.log(chalk.yellow('  ⚠ Active service does not expose version metadata; restart it after updating Ghost Bridge.'));
        }
        if (activeServerPath) {
            console.log(`  Server Path: ${chalk.dim(activeServerPath)}`);
            if (activeServerPath !== currentServerPath) {
                console.log(chalk.yellow(`  ⚠ Active service path differs from this CLI: ${currentServerPath}`));
            }
        } else if (activeCommand && !activeCommand.includes(currentServerPath)) {
            console.log(chalk.yellow(`  ⚠ Active service command may differ from this CLI:`));
            console.log(chalk.dim(`    ${activeCommand}`));
            console.log(chalk.dim(`    Current: ${serverConfig.command} ${currentServerPath}`));
        } else {
            console.log(chalk.yellow('  ⚠ Active service does not expose server path metadata; restart it after updating Ghost Bridge.'));
        }
    }

    // Check Extension
    let extStatus = chalk.red('Not Installed (Run init)');
    if (fs.existsSync(extDir)) {
        extStatus = chalk.green('Installed');
    }
    console.log(chalk.bold.blue('\nChrome Extension:'));
    console.log(`Extension: ${extStatus}`);
    console.log(`  Path: ${extDir}`);
    console.log(`  Source: ${sourceExtDir}`);
    if (fs.existsSync(extDir)) {
        const syncStatus = await getExtensionSyncStatus(sourceExtDir, extDir);
        if (syncStatus.ok) {
            console.log(`  Sync: ${chalk.green('Matches current package')}`);
            if (syncStatus.extraFile) {
                console.log(chalk.dim(`    Ignoring extra installed file: ${syncStatus.extraFile}`));
            }
        } else {
            console.log(`  Sync: ${chalk.yellow('Out of sync')}`);
            console.log(chalk.dim(`    ${syncStatus.reason}`));
            console.log(chalk.dim('    Run `ghost-bridge init` and reload the Chrome extension.'));
        }
    }

}
