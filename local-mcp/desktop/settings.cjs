const path = require('node:path');
const { isIP } = require('node:net');
const { stat } = require('node:fs/promises');

async function validateSettings(input) {
  if (!input || typeof input.workspace !== 'string' || !input.workspace.trim()) throw new Error('请选择工作区文件夹。');
  if (typeof input.url !== 'string') throw new Error('请填写服务 URL。');
  let url;
  try { url = new URL(input.url); } catch { throw new Error('URL 格式无效，例如 http://127.0.0.1:8765/sse。'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash) throw new Error('请使用 HTTP 地址，不要包含账号、查询参数或锚点。');
  // 四个工具具有本机文件与命令权限，桌面配置仅允许绑定回环地址。
  if (host !== 'localhost' && host !== '::1' && !(isIP(host) === 4 && host.startsWith('127.'))) throw new Error('服务地址必须是本机地址：127.0.0.1、localhost 或 [::1]。');
  if (url.pathname === '/messages') throw new Error('/messages 用于协议消息，请换一个服务路径。');
  const workspace = path.resolve(input.workspace);
  let info;
  try { info = await stat(workspace); } catch { throw new Error(`工作区不存在或无法访问：${workspace}`); }
  if (!info.isDirectory()) throw new Error('工作区必须是文件夹。');
  const port = Number(url.port || 80);
  if (port < 1 || port > 65535) throw new Error('端口必须在 1–65535 之间。');
  return { workspace, url: url.href, host, port, endpoint: url.pathname };
}

module.exports = { validateSettings };
