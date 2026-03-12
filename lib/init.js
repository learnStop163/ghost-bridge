import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import { exec } from 'child_process';
import os from 'os';
import { getClientConfigPaths, getServerPath, getUserExtensionDir, getExtensionPath } from './utils.js';

function openFolder(folderPath) {
  const platform = os.platform();
  let command = '';
  if (platform === 'darwin') command = `open "${folderPath}"`;
  else if (platform === 'win32') command = `start "" "${folderPath}"`;
  else command = `xdg-open "${folderPath}"`;

  exec(command, (err) => {
    if (err) console.error(chalk.dim('Failed to open folder:', err.message));
  });
}

export async function init(options) {
  console.log(chalk.bold('👻 Ghost Bridge Initialization'));

  const clientConfigs = getClientConfigPaths();
  const serverPath = getServerPath();
  const isDryRun = options.dryRun;

  // 1. Configure MCP Clients
  console.log(chalk.dim('Checking MCP Client configurations...'));
  
  let configuredCount = 0;

  for (const client of clientConfigs) {
    const configPath = client.path;
    
    if (isDryRun) {
      console.log(chalk.yellow(`[Dry Run] Would check ${client.name} config at: ${configPath}`));
      if (fs.existsSync(configPath) || client.name === 'Claude Code') {
        console.log(chalk.yellow(`[Dry Run] Would add MCP server logic for ${client.name}`));
      }
      continue;
    }

    // For Claude Code (default), we aggressively create the config if missing.
    // For others, we only inject if the config folder/file actually exists to avoid cluttering.
    const exists = fs.existsSync(configPath);
    if (!exists && client.name !== 'Claude Code') {
        continue; // Skip if this client isn't installed
    }

    if (!exists) {
        console.log(chalk.yellow(`Configuration file not found for ${client.name} at ${configPath}, creating...`));
        await fs.ensureDir(path.dirname(configPath));
        await fs.writeJson(configPath, { mcpServers: {} }, { spaces: 2 });
    }

    try {
        const config = await fs.readJson(configPath);
        config.mcpServers = config.mcpServers || {};
        
        config.mcpServers['ghost-bridge'] = {
            command: 'node',
            args: [serverPath]
        };

        await fs.writeJson(configPath, config, { spaces: 2 });
        console.log(chalk.green(`✅ MCP Server configured for ${chalk.bold(client.name)} in ${configPath}`));
        configuredCount++;
    } catch (err) {
        console.error(chalk.red(`Failed to update config for ${client.name}: ${err.message}`));
    }
  }
  
  if (configuredCount === 0 && !isDryRun) {
    console.log(chalk.yellow('⚠️ No supported MCP clients found to configure automatically.'));
  }

  // 2. Setup Extension directory (Copy to ~/.ghost-bridge/extension)
  const sourceExt = getExtensionPath();
  const targetExt = getUserExtensionDir();

  console.log(chalk.dim(`Setting up extension in ${targetExt}...`));

  if (isDryRun) {
      console.log(chalk.yellow(`[Dry Run] Would copy extension from ${sourceExt} to ${targetExt}`));
  } else {
      try {
          await fs.ensureDir(targetExt);
          await fs.copy(sourceExt, targetExt, { overwrite: true });
          console.log(chalk.green(`✅ Extension files copied to ${targetExt}`));
      } catch (err) {
          console.error(chalk.red(`Failed to copy extension files: ${err.message}`));
      }
  }

  console.log('\n' + chalk.bold.blue('🎉 Setup Complete!'));
  console.log(chalk.white('Next steps:'));
  console.log(`1. Open Chrome and go to ${chalk.bold('chrome://extensions')}`);
  console.log('2. Enable "Developer mode" (top right)');
  console.log('3. Click "Load unpacked"');
  console.log(`4. Select the folder: ${chalk.bold(targetExt)}`);
  
  if (!isDryRun) {
      // Create a small marker file to indicate it's managed by CLI
      await fs.outputFile(path.join(targetExt, '.ghost-bridge-managed'), 'This folder is managed by ghost-bridge CLI. Do not edit manually.');
      
      // Auto-open the extension folder so user can easily find it
      console.log(chalk.dim('\n📂 Opening extension folder...'));
      openFolder(targetExt);
  }
}
