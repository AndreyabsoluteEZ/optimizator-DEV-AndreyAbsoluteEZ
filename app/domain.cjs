'use strict';

const { isIP } = require('node:net');
const path = require('node:path');

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const qosName = /^AbsoluteOptimizer-[0-9a-f]{32}$/;
const priorities = ['Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High', 'RealTime'];
const captureKeys = ['GameDVR_Enabled', 'AppCaptureEnabled'];

function normalizeHost(input) {
  const host = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (isIP(host)) return host;
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  if (
    name.length > 253 || /^[\d.]+$/.test(name) ||
    !name.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error('Введите IP-адрес или имя хоста без порта и https://.');
  }
  return name;
}

function summarize(samples) {
  const replies = samples.filter(Number.isFinite);
  const average = replies.length ? Math.round(replies.reduce((a, b) => a + b, 0) / replies.length) : null;
  const differences = samples.slice(1).flatMap((value, index) =>
    value === null || samples[index] === null ? [] : [Math.abs(value - samples[index])]
  );
  return {
    average,
    jitter: differences.length ? Math.round(differences.reduce((a, b) => a + b, 0) / differences.length) : null,
    loss: Math.round(100 * (1 - replies.length / samples.length))
  };
}

function validateExe(file) {
  if (
    typeof file !== 'string' || file.length > 2048 || !/^[A-Z]:\\/i.test(file) ||
    /[\x00-\x1f*?"<>|]/.test(file.slice(2)) || file.slice(2).includes(':') ||
    path.win32.extname(file).toLowerCase() !== '.exe'
  ) throw new Error('Выберите локальный файл .exe.');
  return path.win32.normalize(file);
}

function validateState(state) {
  if (!state || state.version !== 1) throw new Error('Файл восстановления имеет неизвестный формат.');
  if (state.profile) {
    const { plan, capture, complete } = state.profile;
    if (
      typeof complete !== 'boolean' || !Array.isArray(capture) ||
      capture.length !== captureKeys.length ||
      !captureKeys.every((key, index) => {
        const item = capture[index];
        return item?.name === key && (item.value === null ||
          (Number.isInteger(item.value) && item.value >= -2147483648 && item.value <= 2147483647));
      }) ||
      (plan !== null && (!guid.test(plan?.before) || !guid.test(plan?.target)))
    ) throw new Error('Файл восстановления игрового профиля повреждён.');
  }
  if (state.priority) {
    const { id, start, file, before, complete } = state.priority;
    if (
      !Number.isInteger(id) || id < 1 || typeof start !== 'string' || !/^\d{1,19}$/.test(start) ||
      !priorities.includes(before) || typeof complete !== 'boolean'
    ) throw new Error('Файл восстановления приоритета повреждён.');
    validateExe(file);
  }
  if (state.qos) {
    const { name, file, rate, complete } = state.qos;
    if (!qosName.test(name) || !Number.isInteger(rate) || rate < 1 || rate > 100 || typeof complete !== 'boolean') {
      throw new Error('Файл восстановления ограничения скорости повреждён.');
    }
    validateExe(file);
  }
  return state;
}

module.exports = { guid, normalizeHost, summarize, validateExe, validateState };
