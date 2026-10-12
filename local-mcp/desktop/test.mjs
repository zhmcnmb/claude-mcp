import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.resolve(here, '../temp/desktop-tests');
await mkdir(testRoot, { recursive: true });
const testDir = await mkdtemp(path.join(testRoot, 'run-'));
const executable = process.argv[2];
const env = { ...process.env, CLAUDE_LOCAL_TEST_DIR: testDir };
delete env.ELECTRON_RUN_AS_NODE;
try {
  for (let run = 0; run < 2; run++) {
    env.CLAUDE_LOCAL_TEST_EXIT = run === 0 ? 'dialog' : 'tray';
    const child = spawn(executable || createRequire(import.meta.url)('electron'), [...(executable ? [] : [here]), '--self-test', '--disable-gpu'], { env, stdio: 'inherit' });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error('桌面自检超时')); }, 60000);
      child.on('error', (error) => { clearTimeout(timeout); reject(error); });
      child.on('exit', (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`桌面自检退出码：${code}`)); });
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(testDir, 'result.json'), 'utf8')), { passed: true, exit: env.CLAUDE_LOCAL_TEST_EXIT });
    const saved = JSON.parse(await readFile(path.join(testDir, 'settings.json'), 'utf8'));
    await assert.rejects(fetch(saved.url, { signal: AbortSignal.timeout(2000) }), '关闭应用必须停止服务');
  }
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch (error) { console.error(`自检现场保留：${testDir}`); throw error; }
