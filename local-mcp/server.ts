#!/usr/bin/env node
import { startServer } from './service.ts';

const args = process.argv.slice(2);
let workspace = process.cwd();
let port = 8765;
let host = '127.0.0.1';
let shellPath: string | undefined;
let rgPath: string | undefined;
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) port = Number(args[++i]);
  else if (args[i] === '--host' && args[i + 1]) host = args[++i];
  else if (args[i] === '--shell' && args[i + 1]) shellPath = args[++i];
  else if (args[i] === '--rg' && args[i + 1]) rgPath = args[++i];
  else if (!args[i].startsWith('-')) workspace = args[i];
}
startServer({ workspace, port, host, shellPath, rgPath, onLog: console.log }).then((service) => {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    service.stop().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}).catch((error) => {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
});
