// Note: shebang is added by esbuild banner during build
import { Command } from 'commander';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';

// ESM fix for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read package.json
const packageJsonParams = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
);

const program = new Command();

program
  .name('ghost-bridge')
  .description(packageJsonParams.description)
  .version(packageJsonParams.version);

program
  .command('init')
  .description('Initialize Ghost Bridge: Configure Claude MCP and setup extension')
  .option('--dry-run', 'Show what would be done without making changes')
  .action(async (options) => {
    try {
      const { init } = await import('../lib/init.js');
      await init(options);
    } catch (error) {
      console.error(chalk.red('Error initializing Ghost Bridge:'), error);
      process.exit(1);
    }
  });

program
  .command('extension')
  .description('Show the path to the Chrome extension')
  .option('--open', 'Open the extension directory in Finder/Explorer')
  .action(async (options) => {
    try {
      const { showExtension } = await import('../lib/extension.js');
      await showExtension(options);
    } catch (error) {
      console.error(chalk.red('Error showing extension info:'), error);
      process.exit(1);
    }
  });

program
  .command('start')
  .description('Start the Ghost Bridge MCP server directly')
  .action(async () => {
    try {
      // Import the server module (which should start automatically or export a starter)
      // Since existing server.js starts on high level, we might need to adjust it or just import it.
      // For now, let's assume importing it runs it, as per current server.js implementation.
      console.log(chalk.blue('Starting Ghost Bridge Server...'));
      
      // Determine path to server.js (src/server.js after refactor, currently might be in root or src)
      // We will handle the move to src/server.js in a later step, so for now we point to where it will be.
      // Or we can dynamically find it.
      const serverPath = path.join(__dirname, '../src/server.js');
      if (fs.existsSync(serverPath)) {
          await import(serverPath);
      } else {
           // Fallback for before refactor complete (if testing mid-way), though we plan to move it soon.
           const rootServerPath = path.join(__dirname, '../server.js');
           if (fs.existsSync(rootServerPath)) {
               await import(rootServerPath);
           } else {
               throw new Error('Could not find server.js');
           }
      }
    } catch (error) {
      console.error(chalk.red('Error starting server:'), error);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Check Ghost Bridge configuration status')
  .action(async () => {
      try {
        const { status } = await import('../lib/status.js');
        await status();
      } catch (error) {
        console.error(chalk.red('Error checking status:'), error);
      }
  });

program.parse();
