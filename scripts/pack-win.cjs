'use strict';

const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const { extract } = require('@electron-internal/extract-zip');
const { NtExecutable, NtExecutableResource, Resource, Data } = require('resedit');
const metadata = require('../package.json');

const root = path.resolve(__dirname, '..');
const distribution = path.join(root, 'dist');
const destination = path.join(distribution, 'AbsoluteOptimizer-win-x64');
const electronVersion = metadata.devDependencies.electron;
const archiveName = `electron-v${electronVersion}-win32-x64.zip`;
const expectedSha256 = '2ba6223afa9121f42831fefe92c434334907540165294fc56697449d12e7cfe9';

async function download(archive) {
  const url = `https://github.com/electron/electron/releases/download/v${electronVersion}/${archiveName}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error(`Не удалось скачать Electron (HTTP ${response.status}).`);
  await pipeline(response.body, createWriteStream(archive));
}

async function verify(archive) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== expectedSha256) throw new Error('Контрольная сумма архива Electron не совпадает.');
}

async function brand(directory) {
  const original = path.join(directory, 'electron.exe');
  const executable = NtExecutable.from(await fs.readFile(original));
  const resources = NtExecutableResource.from(executable);
  const iconFile = Data.IconFile.from(await fs.readFile(path.join(root, 'app', 'ui', 'icon.ico')));
  for (const icon of Resource.IconGroupEntry.fromEntries(resources.entries)) {
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, icon.id, icon.lang, iconFile.icons.map(item => item.data));
  }

  for (const version of Resource.VersionInfo.fromEntries(resources.entries)) {
    for (const language of version.getAllLanguagesForStringValues()) {
      version.setFileVersion(metadata.version, language.lang);
      version.setProductVersion(metadata.version, language.lang);
      version.setStringValues(language, {
        FileDescription: metadata.productName,
        ProductName: metadata.productName,
        InternalName: 'AbsoluteOptimizer',
        OriginalFilename: 'AbsoluteOptimizer.exe'
      });
    }
    version.outputToResourceEntries(resources.entries);
  }

  resources.outputResource(executable);
  await fs.writeFile(path.join(directory, 'AbsoluteOptimizer.exe'), Buffer.from(executable.generate()));
  await fs.unlink(original);
  await fs.rename(path.join(directory, 'electron_wer.dll'), path.join(directory, 'AbsoluteOptimizer_wer.dll'));
}

async function build() {
  await fs.mkdir(distribution, { recursive: true });
  if (await fs.stat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
    throw new Error(`Перед повторной сборкой переместите папку ${destination}.`);
  }
  const staging = await fs.mkdtemp(path.join(distribution, '.build-'));
  try {
    const input = process.argv[2] ? path.resolve(process.argv[2]) : path.join(staging, archiveName);
    if (!process.argv[2]) await download(input);
    await verify(input);

    const application = path.join(staging, 'app');
    await extract(input, { dir: application });
    await brand(application);
    const resources = path.join(application, 'resources');
    const destinationApp = path.join(resources, 'app');
    await fs.rm(path.join(resources, 'default_app.asar'));
    await fs.mkdir(destinationApp);
    await fs.copyFile(path.join(root, 'package.json'), path.join(destinationApp, 'package.json'));
    await fs.cp(path.join(root, 'app'), path.join(destinationApp, 'app'), { recursive: true });
    await fs.copyFile(path.join(root, 'README.md'), path.join(application, 'README.md'));
    await fs.rename(application, destination);
    console.log(destination);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

build().catch(error => { console.error(error.message); process.exitCode = 1; });
