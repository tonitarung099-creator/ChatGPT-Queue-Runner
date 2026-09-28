import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensions = path.join(root, 'extensions');
const identical = ['core.js', 'content.js', 'background.js', 'popup.js', 'popup.html', 'popup.css', 'interruption-bypass.js', 'README.md'];
const hashes = new Map();

for (let runner = 1; runner <= 10; runner += 1) {
  const number = String(runner).padStart(2, '0');
  const dir = path.join(extensions, `chat-queue-runner-${number}`);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.name !== `Chat Queue Runner ${number}`) throw new Error(`Nama manifest Runner ${number} salah`);
  if (manifest.version !== '0.2.0') throw new Error(`Versi Runner ${number} bukan 0.2.0`);
  if (manifest.content_scripts?.[0]?.js?.join(',') !== 'core.js,interruption-bypass.js,content.js') throw new Error(`Urutan content script Runner ${number} salah`);

  for (const file of identical) {
    const data = await fs.readFile(path.join(dir, file));
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (!hashes.has(file)) hashes.set(file, hash);
    else if (hashes.get(file) !== hash) throw new Error(`${file} drift pada Runner ${number}`);
  }
  const content = await fs.readFile(path.join(dir, 'content.js'), 'utf8');
  if (content.includes('Document.prototype.querySelectorAll =')) throw new Error(`Monkey patch masih ada di Runner ${number}`);
  if (!content.includes('journal intent BEFORE click')) throw new Error(`Journal send tidak ditemukan Runner ${number}`);
  if (!content.includes('data-cqr-owner')) throw new Error(`Lease lintas runner tidak ditemukan Runner ${number}`);
}
console.log('10 paket konsisten dan lolos validasi statis distribusi.');
