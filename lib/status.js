import chalk from 'chalk';
import fs from 'fs-extra';
import { getUserExtensionDir, getServerCommandConfig } from './utils.js';
import { getClientDefinitions, readClientConfiguration } from './clients.js';

export async function status() {
    console.log(chalk.bold('👻 Ghost Bridge Status'));
    
    const clients = getClientDefinitions();
    const extDir = getUserExtensionDir();
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

    // Check Extension
    let extStatus = chalk.red('Not Installed (Run init)');
    if (fs.existsSync(extDir)) {
        extStatus = chalk.green('Installed');
    }
    console.log(`Extension: ${extStatus}`);
    console.log(`  Path: ${extDir}`);

}
