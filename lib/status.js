import chalk from 'chalk';
import fs from 'fs-extra';
import { getClaudeConfigPath, getServerPath, getUserExtensionDir } from './utils.js';

export async function status() {
    console.log(chalk.bold('👻 Ghost Bridge Status'));
    
    const configPath = getClaudeConfigPath();
    const extDir = getUserExtensionDir();
    const serverPath = getServerPath();

    // Check MCP Config
    let mcpStatus = chalk.red('Not Configured');
    let mcpDetails = '';
    
    if (fs.existsSync(configPath)) {
        try {
            const config = await fs.readJson(configPath);
            if (config.mcpServers && config.mcpServers['ghost-bridge']) {
                mcpStatus = chalk.green('Configured');
                const cfg = config.mcpServers['ghost-bridge'];
                // Check if path matches current installation
                const configuredPath = cfg.args[0];
                if (configuredPath === serverPath) {
                    mcpDetails = chalk.dim('(Paths match)');
                } else {
                    mcpDetails = chalk.yellow(`(Path mismatch)\n  Configured: ${configuredPath}\n  Current:    ${serverPath}`);
                }
            }
        } catch (e) {
            mcpStatus = chalk.red('Error reading config');
        }
    } else {
        mcpStatus = chalk.yellow('Config file not found');
    }

    console.log(`MCP Configuration: ${mcpStatus} ${mcpDetails}`);
    console.log(`  Config File: ${configPath}`);

    // Check Extension
    let extStatus = chalk.red('Not Installed (Run init)');
    if (fs.existsSync(extDir)) {
        extStatus = chalk.green('Installed');
    }
    console.log(`Extension: ${extStatus}`);
    console.log(`  Path: ${extDir}`);

}
