import iconv from 'iconv-lite';

type Encoding = 'utf8' | 'utf16le' | 'utf16be' | 'cp936';
export type TextFile = { text: string; encoding: Encoding; bom: Buffer };

/** 只接受可往返的文本；无 BOM 时先严格 UTF-8，再尝试 Windows 中文编码。 */
export function decodeText(bytes: Buffer): TextFile {
  let encoding: Encoding = 'utf8';
  let bomLength = 0;
  const prefix = bytes.subarray(0, 4).toString('hex');
  if (prefix === 'fffe0000' || prefix === '0000feff') throw new Error('暂不支持 UTF-32，未修改文件。');
  if (prefix.startsWith('efbbbf')) bomLength = 3;
  else if (prefix.startsWith('fffe')) { encoding = 'utf16le'; bomLength = 2; }
  else if (prefix.startsWith('feff')) { encoding = 'utf16be'; bomLength = 2; }
  const body = bytes.subarray(bomLength);
  let text: string;
  try {
    text = new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding === 'utf16le' ? 'utf-16le' : 'utf-16be', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    if (bomLength) throw new Error('文件内容与 BOM 编码不符，未修改文件。');
    encoding = 'cp936';
    text = iconv.decode(body, encoding);
  }
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text) || !iconv.encode(text, encoding).equals(body)) {
    throw new Error('无法无损解码或文件包含二进制内容，未修改文件。');
  }
  return { text, encoding, bom: bytes.subarray(0, bomLength) };
}

export function encodeText(file: TextFile, text: string): Buffer {
  const body = iconv.encode(text, file.encoding);
  if (iconv.decode(body, file.encoding, { stripBOM: false }) !== text) {
    throw new Error(`新内容无法用原编码 ${file.encoding} 无损保存，未修改文件。`);
  }
  return Buffer.concat([file.bom, body]);
}

export function preserveWriteEol(original: string, replacement: string): string {
  if (original === replacement) return replacement;
  const endings = new Set(original.match(/\r\n|\r|\n/g));
  if (endings.size > 1) throw new Error('文件使用混合行尾，请使用 edit 局部修改，未覆盖文件。');
  const eol = endings.values().next().value ?? '\n';
  return replacement.replace(/\r\n|\r|\n/g, eol);
}

/** 在 LF 视图匹配，但只替换原文对应区间，保留未修改部分的混合行尾。 */
export function applyEdits(text: string, edits: { oldText: string; newText: string }[], replaceAll = false): { text: string; count: number; preview: string } {
  const normalized = text.replace(/\r\n?/g, '\n');
  const crlf = [...text.matchAll(/\r\n/g)].map((match, index) => match.index - index);
  const defaultEol = text.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  const originalOffset = (offset: number) => {
    let low = 0;
    let high = crlf.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (crlf[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return offset + low;
  };
  const matches = edits.flatMap(({ oldText, newText }, index) => {
    const old = oldText.replace(/\r\n?/g, '\n');
    if (!old) throw new Error('oldText 必须是非空字符串。');
    const positions: number[] = [];
    for (let position = normalized.indexOf(old); position !== -1; position = normalized.indexOf(old, position + 1)) {
      positions.push(position);
    }
    if (positions.length === 0) {
      const needle = old.split('\n').find((line) => line.trim())?.trim();
      const lines = normalized.split('\n');
      const candidate = needle ? lines.findIndex((line) => line.trim() === needle || line.includes(needle)) : -1;
      const hint = candidate < 0 ? '' : `\n候选位置（仅提示，不自动模糊替换）：\n${lines.slice(Math.max(0, candidate - 1), candidate + 3).map((line, i) => `${Math.max(0, candidate - 1) + i + 1}: ${line.slice(0, 200)}`).join('\n')}`;
      throw new Error(`edits[${index}].oldText 未找到匹配（0 处），未做任何修改。${hint}`);
    }
    if (positions.length > 1 && !replaceAll) throw new Error(`edits[${index}].oldText 匹配到 ${positions.length} 处，必须唯一匹配或设置 replaceAll=true，未做任何修改。`);
    return positions.map((position) => {
      const start = originalOffset(position);
      const end = originalOffset(position + old.length);
      const eol = text.slice(start, end).match(/\r\n|\r|\n/)?.[0]
        ?? text.slice(end).match(/\r\n|\r|\n/)?.[0]
        ?? defaultEol;
      return { start, end, newText: newText.replace(/\r\n|\r|\n/g, eol) };
    });
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].start < matches[i - 1].end) throw new Error('edits 发生重叠，未做任何修改。');
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    parts.push(text.slice(cursor, match.start), match.newText);
    cursor = match.end;
  }
  const result = parts.join('') + text.slice(cursor);
  const lines = result.split(/\r\n|\r|\n/);
  const firstLine = text.slice(0, matches[0].start).split(/\r\n|\r|\n/).length;
  const startLine = Math.max(1, firstLine - 2);
  const preview = lines.slice(startLine - 1, firstLine + 5).map((line, i) => `${startLine + i}: ${line.slice(0, 300)}`).join('\n');
  return { text: result, count: matches.length, preview };
}
