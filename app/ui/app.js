'use strict';

const api = window.optimizer;
const byId = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
let current = { platform: false, profile: 'off' };
let page = 'overview';
let pending = false;
let testing = false;
let refreshing = false;
let pickedFile = null;
let latest = null;
let baseline = null;
let toastTimer;
let metricsTimer;

function filename(file) {
  return file?.split(/[\\/]/).at(-1);
}

function toast(message, error = false) {
  const element = byId('toast');
  clearTimeout(toastTimer);
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, error ? 7000 : 4000);
}

function status(element, mode, text) {
  element.classList.toggle('active', mode === 'active');
  element.classList.toggle('pending', mode === 'pending');
  element.lastElementChild.textContent = text;
}

function renderState() {
  const { platform, profile, planChanged, priority, qos, stateError } = current;
  const cannotChange = !platform || pending || Boolean(stateError);
  const profileText = {
    off: 'Стандартный режим', active: 'Игровой профиль активен', pending: 'Требуется восстановление'
  };
  const profileAction = {
    off: 'Включить профиль', active: 'Вернуть настройки', pending: 'Восстановить настройки'
  };

  all('[data-profile-status]').forEach(element => status(element, profile, profileText[profile]));
  all('[data-profile-action]').forEach(button => {
    button.disabled = cannotChange;
    button.lastElementChild.textContent = profileAction[profile];
  });
  byId('plan-state').textContent = profile === 'active'
    ? (planChanged ? 'Переключена' : 'Исходная схема')
    : 'По доступности';
  byId('capture-state').textContent = profile === 'active' ? 'Отключена' : 'В профиле';

  const gameList = byId('game-list');
  byId('refresh-games').disabled = !platform || pending || refreshing || Boolean(priority);
  gameList.disabled = cannotChange || refreshing || Boolean(priority) || gameList.options.length < 2;
  byId('priority-action').disabled = cannotChange || refreshing || (!priority && !gameList.value);
  byId('priority-action').textContent = priority ? 'Вернуть приоритет' : 'Повысить приоритет';
  byId('priority-note').textContent = priority
    ? `${filename(priority.file)}. ${priority.complete ? 'Уровень «Выше среднего» до закрытия игры.' : 'Доступно восстановление.'}`
    : 'Изменение действует до закрытия процесса. Приоритет можно вернуть раньше.';

  status(byId('qos-status'), qos?.complete ? 'active' : qos ? 'pending' : 'off',
    qos?.complete ? `До ${qos.rate} Мбит/с` : qos ? 'Требуется проверка' : 'Выключен');
  byId('choose-background').disabled = cannotChange || Boolean(qos);
  const file = qos?.file || pickedFile;
  byId('choose-background').lastElementChild.textContent = filename(file) || 'Выбрать .exe';
  byId('choose-background').title = file || '';
  byId('qos-rate').disabled = cannotChange || Boolean(qos);
  if (qos) byId('qos-rate').value = qos.rate;
  byId('qos-action').disabled = cannotChange || (!qos && !pickedFile);
  byId('qos-action').textContent = qos ? 'Снять лимит' : 'Применить лимит';

  byId('ping-start').disabled = !platform || testing;
  byId('host').disabled = !platform || testing;
  all('[data-settings]').forEach(button => { button.disabled = !platform; });

  const notice = byId('startup-message');
  notice.textContent = stateError || (!platform ? 'Для системных настроек и теста пинга запустите приложение в Windows.' : '');
  notice.hidden = !notice.textContent;
}

function navigate(name) {
  if (page === name) return;
  byId(page).hidden = true;
  byId(name).hidden = false;
  all('[data-page]').forEach(button => {
    if (button.dataset.page === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  page = name;
  window.scrollTo(0, 0);
  byId(name + '-title').focus({ preventScroll: true });
  drawCharts();
}

async function change(action, message) {
  if (pending || !api) return;
  pending = true;
  renderState();
  try {
    current = await action();
    toast(message);
  } catch (error) {
    toast(error.message, true);
    try { current = await api.state(); } catch {}
  } finally {
    pending = false;
    renderState();
  }
}

async function refreshGames() {
  refreshing = true;
  renderState();
  const list = byId('game-list');
  const previous = list.value;
  try {
    const entries = await api.games();
    list.replaceChildren(new Option(entries.length ? 'Выберите игру' : 'Открытые окна игр не найдены', ''));
    for (const item of entries) list.add(new Option(`${item.name} · ${filename(item.file)}`, item.id));
    if (entries.some(item => item.id === previous)) list.value = previous;
  } catch (error) {
    toast(error.message, true);
  } finally {
    refreshing = false;
    renderState();
  }
}

function paintChart(canvas, result) {
  const { width, height } = canvas.getBoundingClientRect();
  if (width < 1 || height < 1) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const values = result?.samples || Array(12).fill(null);
  const measured = values.filter(Number.isFinite);
  const max = Math.max(10, Math.ceil(Math.max(0, ...measured) / 10) * 10);
  const left = result ? 37 : 2, right = width - 9, top = 10, bottom = height - 15;
  const x = i => left + (right - left) * i / (values.length - 1);
  const y = value => bottom - (bottom - top) * value / max;

  ctx.font = '10px Golos, Segoe UI, sans-serif';
  ctx.fillStyle = '#959e98';
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#303738';
  ctx.setLineDash([3, 4]);
  for (let index = 0; index <= 4; index++) {
    const value = max * index / 4;
    ctx.beginPath();
    ctx.moveTo(left, y(value));
    ctx.lineTo(right, y(value));
    ctx.stroke();
    if (result) ctx.fillText(number.format(value), 1, y(value) + 3);
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = measured.length ? '#394441' : '#23292a';
  for (let index = 0; index < values.length; index++) {
    ctx.beginPath();
    ctx.moveTo(x(index), top);
    ctx.lineTo(x(index), bottom);
    ctx.stroke();
  }
  if (!result || !measured.length) return;

  const fill = ctx.createLinearGradient(0, top, 0, bottom);
  fill.addColorStop(0, '#c8fb6540');
  fill.addColorStop(1, '#c8fb6500');
  ctx.fillStyle = fill;
  ctx.strokeStyle = '#c8fb65';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let last = -1;
  let first = -1;
  for (let index = 0; index <= values.length; index++) {
    if (index === values.length || values[index] === null) {
      if (last !== -1) {
        ctx.stroke();
        ctx.lineTo(x(last), bottom);
        ctx.lineTo(x(first), bottom);
        ctx.closePath();
        ctx.fill();
        first = last = -1;
      }
    } else {
      if (last === -1) {
        first = index;
        ctx.beginPath();
        ctx.moveTo(x(index), y(values[index]));
      } else {
        ctx.lineTo(x(index), y(values[index]));
      }
      last = index;
    }
  }
  ctx.fillStyle = '#c8fb65';
  values.forEach((value, index) => {
    if (value === null) return;
    ctx.beginPath();
    ctx.arc(x(index), y(value), 2.5, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawCharts() {
  paintChart(byId('overview-chart'), latest);
  paintChart(byId('network-chart'), latest);
}

function renderPing() {
  const empty = latest?.samples.every(sample => sample === null);
  const value = (n, unit) => n === null || n === undefined ? '—' : `${n} ${unit}`;
  byId('network-average').textContent = value(latest?.average, 'мс');
  byId('network-jitter').textContent = value(latest?.jitter, 'мс');
  byId('network-loss').textContent = value(latest?.loss, '%');
  byId('ping-value').textContent = latest?.average ?? '—';
  byId('ping-caption').textContent = latest?.host || 'По последнему замеру';
  byId('overview-target').textContent = latest ? `${latest.host} · ${latest.samples.length} запросов` : '12 измерений до выбранного хоста';

  const detail = latest ? `${latest.host} · ${latest.address} · ${new Date(latest.at).toLocaleTimeString('ru-RU')}` : '';
  byId('ping-details').textContent = empty
    ? `${detail}. Ответов ICMP нет. Проверьте адрес или выберите другой хост.`
    : detail || 'Каждый тест отправляет 12 запросов на один IP-адрес.';

  for (const section of ['overview', 'network']) {
    const caption = byId(section + '-empty');
    caption.hidden = Boolean(latest && !empty);
    if (empty) caption.textContent = 'Хост не ответил на ICMP';
    byId(section + '-chart').setAttribute('aria-label', latest
      ? `График задержки до ${latest.host}. Средний пинг ${value(latest.average, 'мс')}, потери ${latest.loss}%.`
      : 'График задержки. Замеров пока нет.');
  }

  const comparison = byId('baseline-text');
  byId('baseline-area').hidden = !latest;
  byId('baseline-button').disabled = !latest || empty || latest === baseline;
  if (!baseline) comparison.textContent = 'Сохраните замер, чтобы сравнить результаты после изменений.';
  else if (latest === baseline) comparison.textContent = `Сохранён замер «до» · ${baseline.average} мс. Запустите повторный тест.`;
  else if (latest.address !== baseline.address) comparison.textContent = `Для сравнения выберите исходный IP-адрес ${baseline.address}.`;
  else {
    const delta = empty ? 'нет ответа' : `${latest.average - baseline.average > 0 ? '+' : ''}${latest.average - baseline.average} мс`;
    comparison.textContent = `До · ${baseline.average} мс, потери ${baseline.loss}%. После · ${value(latest.average, 'мс')}, потери ${latest.loss}%. Разница · ${delta}.`;
  }
  drawCharts();
}

async function runPing(event) {
  event.preventDefault();
  if (testing || !api) return;
  testing = true;
  byId('ping-start').lastElementChild.textContent = 'Измерение…';
  renderState();
  try {
    latest = await api.ping(byId('host').value);
    renderPing();
    toast('Тест сети завершён.');
  } catch (error) {
    toast(error.message, true);
  } finally {
    testing = false;
    byId('ping-start').lastElementChild.textContent = 'Запустить тест';
    renderState();
  }
}

async function refreshMetrics() {
  if (!api || document.hidden || page !== 'overview') return;
  try {
    const { cpu, used, total } = await api.metrics();
    const ram = Math.round(100 * used / total);
    byId('cpu-value').textContent = cpu;
    byId('ram-value').textContent = ram;
    byId('cpu-meter').style.width = `${cpu}%`;
    byId('ram-meter').style.width = `${ram}%`;
    const gb = bytes => number.format(bytes / 1073741824);
    byId('ram-caption').textContent = `${gb(used)} из ${gb(total)} ГБ`;
  } catch {}
}

all('[data-page]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page)));
all('[data-go]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.go)));
all('[data-window]').forEach(button => button.addEventListener('click', () => api?.window(button.dataset.window)));
all('[data-settings]').forEach(button => button.addEventListener('click', () => {
  api.settings(button.dataset.settings).catch(error => toast(error.message, true));
}));
all('[data-profile-action]').forEach(button => button.addEventListener('click', () => {
  const enable = current.profile === 'off';
  change(() => api.profile(enable), enable ? 'Игровой профиль включён.' : 'Параметры игрового профиля восстановлены.');
}));

byId('refresh-games').addEventListener('click', refreshGames);
byId('game-list').addEventListener('change', renderState);
byId('priority-action').addEventListener('click', async () => {
  const enable = !current.priority;
  await change(() => api.priority(enable, byId('game-list').value), enable ? 'Приоритет повышен.' : 'Приоритет восстановлен.');
  if (!current.priority) await refreshGames();
});

byId('ping-form').addEventListener('submit', runPing);
byId('baseline-button').addEventListener('click', () => {
  baseline = latest;
  renderPing();
});
byId('choose-background').addEventListener('click', async () => {
  try {
    pickedFile = await api.chooseBackground();
    renderState();
  } catch (error) {
    toast(error.message, true);
  }
});
byId('qos-action').addEventListener('click', () => {
  const enable = !current.qos;
  const input = byId('qos-rate');
  if (enable && (!input.reportValidity() || !Number.isInteger(input.valueAsNumber))) {
    toast('Введите целое число от 1 до 100 Мбит/с.', true);
    return;
  }
  change(() => api.qos(enable, input.valueAsNumber), enable ? 'Правило QoS применено.' : 'Лимит снят.');
});

function refreshWhenVisible() {
  clearInterval(metricsTimer);
  if (document.hidden) return;
  refreshMetrics();
  metricsTimer = setInterval(refreshMetrics, 2000);
}
const observer = new ResizeObserver(drawCharts);
all('canvas').forEach(canvas => observer.observe(canvas));
document.fonts.ready.then(drawCharts);
document.addEventListener('visibilitychange', refreshWhenVisible);
renderState();
if (api) {
  api.state().then(state => {
    current = state;
    if (state.platform) byId('os-label').textContent = state.os;
    byId('version-label').textContent = 'Версия ' + state.version;
    renderState();
    refreshWhenVisible();
  }).catch(error => toast(error.message, true));
  api.onBusy(() => toast('Дождитесь завершения изменения, чтобы закрыть приложение.'));
}
