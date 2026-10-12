#!/usr/bin/env node
import { startServer } from './service.ts';

const args = process.argv.slice(2);
let workspace = process.cwd();
let port = 8765;
let host = '127.0.0.1';
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) port = Number(args[++i]);
  else if (args[i] === '--host' && args[i + 1]) host = args[++i];
  else if (!args[i].startsWith('-')) workspace = args[i];
}
startServer({ workspace, port, host, onLog: console.log }).catch((error) => {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
});
