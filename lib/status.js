import chalk from 'chalk';
import fs from 'fs-extra';
import { getClientConfigPaths, getServerPath, getUserExtensionDir } from './utils.js';

export async function status() {
    console.log(chalk.bold('👻 Ghost Bridge Status'));
    
    const clientConfigs = getClientConfigPaths();
    const extDir = getUserExtensionDir();
    const serverPath = getServerPath();

    console.log(chalk.bold.blue('\nMCP Client Configurations:'));
    let configuredCount = 0;

    for (const client of clientConfigs) {
        let mcpStatus = chalk.gray('Not Configured');
        let mcpDetails = '';
        const configPath = client.path;
        
        if (fs.existsSync(configPath)) {
            try {
                const config = await fs.readJson(configPath);
                if (config.mcpServers && config.mcpServers['ghost-bridge']) {
                    mcpStatus = chalk.green('Configured');
                    const cfg = config.mcpServers['ghost-bridge'];
                    const configuredPath = cfg.args[0];
                    if (configuredPath === serverPath) {
                        mcpDetails = chalk.dim('(Paths match)');
                    } else {
                        mcpDetails = chalk.yellow(`(Path mismatch) \n      Configured: ${configuredPath}\n      Current:    ${serverPath}`);
                    }
                    configuredCount++;
                }
            } catch (e) {
                mcpStatus = chalk.red('Error reading config');
            }
        } else {
            if (client.name === 'Claude Code') {
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

    // Check Extension
    let extStatus = chalk.red('Not Installed (Run init)');
    if (fs.existsSync(extDir)) {
        extStatus = chalk.green('Installed');
    }
    console.log(`Extension: ${extStatus}`);
    console.log(`  Path: ${extDir}`);

}
