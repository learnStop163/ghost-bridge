import chalk from 'chalk';
import { exec } from 'child_process';
import os from 'os';
import { getUserExtensionDir } from './utils.js';
import fs from 'fs-extra';

function openFolder(path) {
    const platform = os.platform();
    let command = '';
    if (platform === 'darwin') command = `open "${path}"`;
    else if (platform === 'win32') command = `start "" "${path}"`;
    else command = `xdg-open "${path}"`;

    exec(command, (err) => {
        if (err) console.error('Failed to open folder:', err);
    });
}

export async function showExtension(options) {
    const extDir = getUserExtensionDir();
    
    // Check if it exists
    if (!fs.existsSync(extDir)) {
        console.log(chalk.yellow(`Extension directory not found at: ${extDir}`));
        console.log(chalk.white('Have you run `ghost-bridge init` yet?'));
        return;
    }

    console.log(chalk.bold('Chrome Extension Location:'));
    console.log(chalk.cyan(extDir));
    console.log('');
    console.log('To install in Chrome:');
    console.log('1. Go to chrome://extensions');
    console.log('2. Enable Developer Mode');
    console.log('3. Click "Load unpacked" and select the directory above.');

    if (options.open) {
        console.log(chalk.dim('Opening folder...'));
        openFolder(extDir);
    }
}
