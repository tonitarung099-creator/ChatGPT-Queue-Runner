import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const extensions = path.join(root, 'extensions');
const sharedFiles = ['core.js', 'content.js', 'background.js', 'popup.js', 'popup.html', 'popup.css', 'interruption-bypass.js', 'README.md'];

await fs.mkdir(extensions, { recursive: true });
for (let runner = 1; runner <= 10; runner += 1) {
  const number = String(runner).padStart(2, '0');
  const target = path.join(extensions, `chat-queue-runner-${number}`);
  await fs.mkdir(target, { recursive: true });
  for (const name of sharedFiles) await fs.copyFile(path.join(src, name), path.join(target, name));
  const manifest = {
    manifest_version: 3,
    name: `Chat Queue Runner ${number}`,
    version: '0.2.0',
    description: 'Menjalankan antrean prompt ChatGPT dengan cancellation, recovery, outcome tracking, dan proteksi anti-duplikat.',
    permissions: ['storage', 'activeTab', 'tabs'],
    host_permissions: ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'http://127.0.0.1/*'],
    action: { default_title: `Chat Queue Runner ${number}`, default_popup: 'popup.html' },
    background: { service_worker: 'background.js' },
    content_scripts: [{
      matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
      js: ['core.js', 'interruption-bypass.js', 'content.js'],
      run_at: 'document_idle'
    }]
  };
  await fs.writeFile(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log('Generated Runner 01-10 from src/.');
