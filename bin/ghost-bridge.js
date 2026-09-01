// Note: shebang is added by esbuild banner during build
import { Command } from 'commander';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
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
  .description('Initialize Ghost Bridge: Configure supported MCP clients and setup extension')
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

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readPortInfoFile() {
  const portInfoFile =
    process.env.GHOST_BRIDGE_PORT_INFO || path.join(os.tmpdir(), 'ghost-bridge-port.json');
  if (!fs.existsSync(portInfoFile)) return null;
  try {
    const info = JSON.parse(fs.readFileSync(portInfoFile, 'utf-8'));
    return info && info.pid ? { file: portInfoFile, ...info } : null;
  } catch {
    return null;
  }
}

function removePortInfoFile(entry) {
  try {
    const current = JSON.parse(fs.readFileSync(entry.file, 'utf-8'));
    if (current.pid === entry.pid) fs.unlinkSync(entry.file);
  } catch {}
}

program
  .command('stop')
  .description('Stop the resident ghost-bridge daemon')
  .action(async () => {
    try {
      const entry = readPortInfoFile();
      if (!entry) {
        console.log(chalk.yellow('未发现运行中的 ghost-bridge 常驻服务'));
        return;
      }

      if (!isProcessAlive(entry.pid)) {
        removePortInfoFile(entry);
        console.log(chalk.yellow(`端口信息已过期（PID ${entry.pid} 不存在），已清理`));
        return;
      }

      console.log(chalk.blue(`正在停止 ghost-bridge 常驻服务 (PID: ${entry.pid})...`));
      process.kill(entry.pid, 'SIGTERM');

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && isProcessAlive(entry.pid)) {
        await sleepMs(200);
      }
      if (isProcessAlive(entry.pid)) {
        console.error(chalk.red('服务未能在预期时间内退出，请手动检查该进程'));
        process.exit(1);
      }

      removePortInfoFile(entry);
      console.log(chalk.green('✅ ghost-bridge 常驻服务已停止'));
      console.log(
        chalk.dim('注意：若仍有活跃的 MCP 会话，会话会在下次重连时自动重新拉起服务；如需彻底停止，请先关闭使用中的会话。')
      );
    } catch (error) {
      console.error(chalk.red('Error stopping ghost-bridge:'), error);
      process.exit(1);
    }
  });

program.parse();
