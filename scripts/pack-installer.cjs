'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const app = path.join(dist, 'AbsoluteOptimizer-win-x64');
const output = path.join(dist, 'AbsoluteOptimizer-Setup-x64.exe');

async function payloadFiles(directory, relative = '') {
  const files = [];
  const directories = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^[a-z0-9._-]+$/i.test(entry.name)) {
      throw new Error('Недопустимое имя файла сборки: ' + entry.name);
    }
    const name = path.win32.join(relative, entry.name);
    if (entry.isDirectory()) {
      const nested = await payloadFiles(path.join(directory, entry.name), name);
      files.push(...nested.files);
      directories.push(...nested.directories, name);
    } else if (entry.isFile()) {
      files.push(name);
    } else {
      throw new Error('Ожидался обычный файл: ' + name);
    }
  }
  return { files, directories };
}

function macro(name, command, entries) {
  return [
    '!macro ' + name,
    ...entries.map(entry => `  ${command} "$INSTDIR\\${entry}"`),
    '!macroend',
    ''
  ].join('\n');
}

async function build() {
  const { files, directories } = await payloadFiles(app);
  if (!files.includes('AbsoluteOptimizer.exe') || !files.includes('resources\\app\\app\\main.cjs')) {
    throw new Error('Нужна папка приложения из npm run pack:win.');
  }

  const staging = await fs.mkdtemp(path.join(dist, '.installer-'));
  try {
    const manifest = path.join(staging, 'payload.nsh');
    const executable = path.join(staging, path.basename(output));
    await fs.writeFile(manifest,
      macro('RemovePayloadFiles', 'Delete', files) +
      macro('RemovePayloadDirectories', 'RMDir', directories));

    const prefix = process.platform === 'win32' ? '/' : '-';
    const defines = {
      APP_DIR: app,
      APP_ICON: path.join(root, 'app', 'ui', 'icon.ico'),
      APP_VERSION: version,
      INSTALLER_PATH: executable,
      PAYLOAD_MANIFEST: manifest
    };
    const result = spawnSync(process.env.MAKENSIS || 'makensis', [
      prefix + 'V2',
      prefix + 'INPUTCHARSET', 'UTF8',
      ...Object.entries(defines).map(([key, value]) => prefix + 'D' + key + '=' + value),
      path.join(__dirname, 'windows', 'installer.nsi')
    ], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Установщик NSIS не собран.');

    await fs.rename(executable, output);
    console.log(output);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

build().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
