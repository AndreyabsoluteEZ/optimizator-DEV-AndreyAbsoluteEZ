'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { lookup } = require('node:dns/promises');
const { guid, normalizeHost, summarize, validateExe } = require('./domain.cjs');

const run = promisify(execFile);
const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const powershell = path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const modules = path.join(path.dirname(powershell), 'Modules');
const highPerformance = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const captureRegistry = `
$keys = @(
  @{ Path = 'HKCU:\\System\\GameConfigStore'; Name = 'GameDVR_Enabled' },
  @{ Path = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR'; Name = 'AppCaptureEnabled' }
)
function Read-Capture($key) {
  if (-not (Test-Path -LiteralPath $key.Path)) { return $null }
  $item = Get-Item -LiteralPath $key.Path
  if ($item.GetValueNames() -notcontains $key.Name) { return $null }
  if ($item.GetValueKind($key.Name) -ne 'DWord') {
    throw ('Unsupported registry value: ' + $key.Name)
  }
  return [int]$item.GetValue($key.Name)
}
`;

function encoded(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function payload(value) {
  const data = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  return `$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json\n`;
}

async function shell(script, { timeout = 15000 } = {}) {
  const prepared = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    try { ${script} }
    catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
  `;
  const { stdout } = await run(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(prepared)
  ], {
    windowsHide: true, timeout, maxBuffer: 1024 * 1024,
    env: { ...process.env, PSModulePath: modules }
  });
  return stdout.trim();
}

async function json(script, options) {
  return JSON.parse(await shell(script, options));
}

async function runPower(...args) {
  const { stdout } = await run(path.join(system, 'powercfg.exe'), args, { windowsHide: true, timeout: 10000 });
  return stdout;
}

async function activePlan() {
  const line = await runPower('/getactivescheme');
  const id = line.match(/[0-9a-f-]{36}/i)?.[0]?.toLowerCase();
  if (!guid.test(id)) throw new Error('Windows не вернула активную схему питания.');
  return id;
}

async function getProfile() {
  const [before, plans, capture] = await Promise.all([
    activePlan(),
    runPower('/list'),
    json(`${captureRegistry}
      $items = @(foreach ($key in $keys) { @{ name = $key.Name; value = (Read-Capture $key) } })
      ConvertTo-Json -InputObject $items -Compress
    `)
  ]);
  return { plan: plans.toLowerCase().includes(highPerformance) && before !== highPerformance
    ? { before, target: highPerformance } : null, capture, complete: false };
}

async function applyProfile(snapshot) {
  if (snapshot.plan) {
    if (await activePlan() !== snapshot.plan.before) {
      const error = new Error('Схема питания изменилась. Повторите включение профиля.');
      error.unchanged = true;
      throw error;
    }
    await runPower('/setactive', snapshot.plan.target);
  }
  await shell(`${payload(snapshot.capture)}${captureRegistry}
    for ($i = 0; $i -lt $keys.Count; $i++) {
      if ((Read-Capture $keys[$i]) -ne $data[$i].value) { throw 'Game capture settings changed.' }
    }
    foreach ($key in $keys) {
      if (-not (Test-Path -LiteralPath $key.Path)) { New-Item -Path $key.Path -Force | Out-Null }
      New-ItemProperty -LiteralPath $key.Path -Name $key.Name -PropertyType DWord -Value 0 -Force | Out-Null
    }
  `);
}

async function restoreProfile(snapshot) {
  const results = await Promise.allSettled([
    (async () => {
      if (snapshot.plan && await activePlan() === snapshot.plan.target) {
        await runPower('/setactive', snapshot.plan.before);
      }
    })(),
    shell(`${payload(snapshot.capture)}${captureRegistry}
      for ($i = 0; $i -lt $keys.Count; $i++) {
        $key = $keys[$i]
        $current = Read-Capture $key
        if ($null -eq $current -or $current -ne 0) { continue }
        if ($null -eq $data[$i].value) {
          Remove-ItemProperty -LiteralPath $key.Path -Name $key.Name
        } else {
          Set-ItemProperty -LiteralPath $key.Path -Name $key.Name -Value ([int]$data[$i].value)
        }
      }
    `)
  ]);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

const processIdentity = `
$game = Get-Process -Id ([int]$data.id) -ErrorAction SilentlyContinue
if ($null -eq $game) { return }
try {
  if ($game.StartTime.ToUniversalTime().Ticks.ToString() -ne $data.start -or $game.Path -ne $data.file) { return }
} catch {
  if ($game.HasExited) { return }
  throw
}
`;

async function listGames() {
  const games = await json(`
    $items = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Id -ne ${process.pid} } | ForEach-Object {
      try {
        if ($_.Path) {
          @{ id = $_.Id; start = $_.StartTime.ToUniversalTime().Ticks.ToString(); file = $_.Path;
             name = $_.MainWindowTitle; before = $_.PriorityClass.ToString() }
        }
      } catch {}
    })
    ConvertTo-Json -InputObject $items -Compress
  `);
  return games.filter(game => {
    try {
      validateExe(game.file);
      return !!game.name;
    } catch { return false; }
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

async function setPriority(data, restore = false) {
  const result = await shell(`${payload(data)}${processIdentity}
    try {
      $current = $game.PriorityClass.ToString()
      if (${restore ? '$current -eq \'AboveNormal\'' : '$current -eq $data.before'}) {
        $game.PriorityClass = ${restore ? '[System.Diagnostics.ProcessPriorityClass]$data.before' : "'AboveNormal'"}
        Write-Output 'changed'
      }
    } catch {
      if (-not $game.HasExited) { throw }
    }
  `);
  if (!restore && result !== 'changed') {
    const error = new Error('Игра закрылась или её приоритет изменился. Обновите список.');
    error.unchanged = true;
    throw error;
  }
}

async function priorityStillSet(data) {
  try {
    return await shell(`${payload(data)}${processIdentity}\n$game.PriorityClass.ToString()`) === 'AboveNormal';
  } catch {
    return true;
  }
}

async function ping(input) {
  const host = normalizeHost(input);
  let address;
  try {
    ({ address } = await lookup(host));
  } catch {
    throw new Error('Хост не найден. Проверьте его имя и подключение.');
  }
  const samples = await json(`${payload({ address })}
    $client = New-Object System.Net.NetworkInformation.Ping
    try {
      $samples = @(for ($i = 0; $i -lt 12; $i++) {
        $reply = $client.Send([System.Net.IPAddress]::Parse($data.address), 850)
        if ($reply.Status -eq [System.Net.NetworkInformation.IPStatus]::Success) { $reply.RoundtripTime }
        else { $null }
        if ($i -lt 11) { Start-Sleep -Milliseconds 220 }
      })
      ConvertTo-Json -InputObject $samples -Compress
    } finally { $client.Dispose() }
  `, { timeout: 22000 });
  if (!Array.isArray(samples) || samples.length !== 12 ||
      samples.some(sample => sample !== null && !Number.isFinite(sample))) {
    throw new Error('Windows вернула неполный результат теста.');
  }
  return { host, address, samples, ...summarize(samples), at: new Date().toISOString() };
}

function qosLookup() {
  return `@(Get-NetQosPolicy -PolicyStore ActiveStore -ErrorAction Stop | Where-Object { $_.Name -eq $data.name })`;
}

async function qosStatus(data) {
  try {
    const found = await shell(`${payload(data)}\nif ((${qosLookup()}).Count) { 'active' } else { 'absent' }`);
    return found === 'active' || found === 'absent' ? found : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function hasQos() {
  return await shell("if (Get-Command New-NetQosPolicy -ErrorAction SilentlyContinue) { 'yes' }") === 'yes';
}

async function changeQos(data, restore = false) {
  const action = restore ? `
    foreach ($policy in ${qosLookup()}) {
      Remove-NetQosPolicy -Name $policy.Name -PolicyStore ActiveStore -Confirm:$false
    }
    if ((${qosLookup()}).Count -ne 0) { exit 4 }
  ` : `
    if ((${qosLookup()}).Count -ne 0) { exit 3 }
    New-NetQosPolicy -Name $data.name -AppPathNameMatchCondition $data.file -ThrottleRateActionBitsPerSecond ([uint64]$data.rate * 1000000) -NetworkProfile All -PolicyStore ActiveStore | Out-Null
    if ((${qosLookup()}).Count -ne 1) { exit 4 }
  `;
  const script = encoded(`
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $env:PSModulePath = Join-Path $PSHOME 'Modules'
    ${payload(data)}
    try { ${action}; exit 0 } catch { exit 2 }
  `);
  const launcher = `
    try {
      $process = Start-Process -FilePath (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe') -ArgumentList '-NoProfile -NoLogo -NonInteractive -EncodedCommand ${script}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru
      Write-Output $process.ExitCode
    } catch {
      $errorCode = $_.Exception
      while ($null -ne $errorCode) {
        if ($errorCode -is [System.ComponentModel.Win32Exception] -and $errorCode.NativeErrorCode -eq 1223) {
          Write-Output 'cancelled'
          return
        }
        $errorCode = $errorCode.InnerException
      }
      throw
    }
  `;
  const result = await shell(launcher, { timeout: 0 });
  if (result === 'cancelled') {
    const error = new Error('Запрос прав администратора отменён.');
    error.cancelled = true;
    throw error;
  }
  if (result !== '0') throw new Error('Windows не подтвердила изменение QoS. Проверьте правило через кнопку отмены.');
}

module.exports = {
  getProfile, applyProfile, restoreProfile, listGames, setPriority, priorityStillSet, ping, qosStatus, hasQos, changeQos
};
