'use strict';

/* =====================================================
   1. НАСТРОЙКИ
   ===================================================== */
const N = 8;          // поле 8 x 8
const TYPES = 6;      // 6 видов камушков
const BLAST = 2;      // радиус взрыва бомбы: 2 клетки = область 5 x 5
const COLORS = ['#ff2f7e', '#1f9bff', '#1fcf63', '#ffbb00', '#ff7a1a', '#8a45ff']; // цвета искр

// Настройки уровня: чем выше уровень, тем больше очков нужно набрать
const levelCfg = (l) => ({ moves: Math.max(14, 24 - l), goal: 400 + l * 250 });

/* =====================================================
   2. ВСПОМОГАТЕЛЬНОЕ: localStorage, звук, утилиты
   ===================================================== */
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } },
};

// Звуки «рисуем» через Web Audio API — без файлов
class Sound {
  constructor() { this.ctx = null; this.muted = store.get('gem-muted', false); }
  unlock() {
    try {
      this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) { console.warn('Звук недоступен', e); }
  }
  // Один тон: частота, длительность, тип волны, громкость, задержка
  tone(f, dur = 0.12, type = 'triangle', vol = 0.1, delay = 0) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t); o.stop(t + dur);
  }
  // Чем больше комбо, тем выше нота — приятно слушать цепочки
  pop(combo) {
    const notes = [523, 587, 659, 784, 880, 1047];
    const f = notes[Math.min(combo - 1, notes.length - 1)];
    this.tone(f); this.tone(f * 1.5, 0.1, 'sine', 0.06, 0.06);
  }
  swap() { this.tone(440, 0.06, 'sine', 0.08); }
  bad()  { this.tone(200, 0.15, 'sawtooth', 0.07); }
  make() { [659, 880, 1175].forEach((f, i) => this.tone(f, 0.1, 'square', 0.06, i * 0.07)); }
  boom() { [220, 160, 110, 70].forEach((f, i) => this.tone(f, 0.18, 'sawtooth', 0.12, i * 0.07)); }
  win()  { [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.12, i * 0.11)); }
  lose() { [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.25, 'sine', 0.1, i * 0.18)); }
}

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Math.floor(Math.random() * n);
const board = $('board');
const sound = new Sound();

/* =====================================================
   3. СОСТОЯНИЕ
   grid[y][x] — объект-плитка { x, y, t (вид), bomb, el }
   ===================================================== */
const st = {
  grid: [], score: 0, moves: 0, level: 1, goal: 0,
  busy: true,                 // true — пока идёт анимация или открыт экран, ходить нельзя
  sel: null, drag: null,
  best: store.get('gem-best', 0),
};

/* =====================================================
   4. СОЗДАНИЕ ПЛИТОК
   ===================================================== */
// Ставит плитку на клетку (x, y) через transform — так работает плавная анимация
function place(t, x, y) { t.el.style.transform = `translate(${x * 100}%, ${y * 100}%)`; }

// fromY — откуда плитка «падает» (для новых камушков это место над полем)
function makeTile(x, y, type, fromY = y) {
  const t = { x, y, t: type, bomb: false, el: document.createElement('div') };
  t.el.className = 'tile';
  t.el.innerHTML = `<div class="gem g${type}"></div>`;
  place(t, x, fromY);
  board.appendChild(t.el);
  if (fromY !== y) { void t.el.offsetWidth; place(t, x, y); }   // перерисовка, чтобы сработал переход
  return t;
}

function setType(t, type) {
  t.t = type;
  t.el.firstChild.className = `gem g${type}`;
}

/* =====================================================
   5. ПОИСК СОВПАДЕНИЙ
   ===================================================== */
// Возвращает список «рядов» — групп из 3 и более одинаковых камушков подряд
function findRuns() {
  const runs = [];
  for (let d = 0; d < 2; d++) {              // d = 0 — строки, d = 1 — столбцы
    for (let a = 0; a < N; a++) {
      let run = [];
      for (let b = 0; b <= N; b++) {
        const tile = b < N ? (d ? st.grid[b][a] : st.grid[a][b]) : null;
        if (tile && run.length && tile.t === run[0].t) run.push(tile);
        else { if (run.length >= 3) runs.push(run); run = tile ? [tile] : []; }
      }
    }
  }
  return runs;
}

// Взрыв бомб: добавляет в набор все камушки рядом, а бомбы в зоне взрываются цепочкой
function expand(kill) {
  const queue = [...kill].filter((t) => t.bomb);
  while (queue.length) {
    const b = queue.pop();
    for (let dy = -BLAST; dy <= BLAST; dy++) {
      for (let dx = -BLAST; dx <= BLAST; dx++) {
        const tile = st.grid[b.y + dy]?.[b.x + dx];
        if (tile && !kill.has(tile)) { kill.add(tile); if (tile.bomb) queue.push(tile); }
      }
    }
  }
}

// Есть ли хоть один возможный ход? Пробуем поменять соседей местами
function hasMoves() {
  const g = st.grid;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (g[y][x].bomb) return true;
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= N || ny >= N) continue;
      [g[y][x], g[ny][nx]] = [g[ny][nx], g[y][x]];
      const ok = findRuns().length > 0;
      [g[y][x], g[ny][nx]] = [g[ny][nx], g[y][x]];
      if (ok) return true;
    }
  }
  return false;
}

/* =====================================================
   6. ОБМЕН, ВЗРЫВЫ И ПАДЕНИЕ
   ===================================================== */
function swapTiles(a, b) {
  const g = st.grid;
  [g[a.y][a.x], g[b.y][b.x]] = [b, a];
  [a.x, b.x] = [b.x, a.x];
  [a.y, b.y] = [b.y, a.y];
  place(a, a.x, a.y); place(b, b.x, b.y);
}

async function trySwap(a, b) {
  if (st.busy) return;
  st.busy = true; clearSel();
  swapTiles(a, b); sound.swap();
  await sleep(250);

  const bombs = [a, b].filter((t) => t.bomb);   // если двигали бомбу — она взрывается сама
  if (!findRuns().length && !bombs.length) {    // хода не получилось — камушки возвращаются
    sound.bad(); swapTiles(a, b);
    [a, b].forEach((t) => { t.el.classList.add('no'); setTimeout(() => t.el.classList.remove('no'), 300); });
    await sleep(280); st.busy = false; return;
  }

  st.moves--; updateHud();
  await resolve([a, b], bombs);

  if (st.score > st.best) { st.best = st.score; store.set('gem-best', st.best); updateHud(); }
  if (st.score >= st.goal) return win();
  if (st.moves <= 0) return lose();
  if (!hasMoves()) await shuffle();
  st.busy = false;
}

// Главный цикл: ищем совпадения → взрываем → роняем → повторяем, пока есть цепочки
async function resolve(swapped, forced = []) {
  let combo = 0;
  while (true) {
    const runs = findRuns();
    if (!runs.length && !forced.length) break;
    combo++;

    const kill = new Set(forced); forced = [];
    const spots = [];                                  // где появятся новые бомбочки
    runs.forEach((run) => {
      run.forEach((t) => kill.add(t));
      if (run.length >= 4) spots.push(run.find((t) => swapped.includes(t)) || run[run.length >> 1]);
    });
    const hadBomb = [...kill].some((t) => t.bomb);
    expand(kill);
    const keep = spots.filter((t) => !t.bomb);         // камушек, ставший бомбой, не лопается
    keep.forEach((t) => kill.delete(t));
    swapped = [];

    // Очки: за каждый камушек × номер комбо, за взрыв — бонус
    st.score += kill.size * 10 * combo + (hadBomb ? 100 : 0);
    sound.pop(combo);
    if (hadBomb) { sound.boom(); board.classList.add('wiggle'); setTimeout(() => board.classList.remove('wiggle'), 500); }
    if (combo > 1) toast(`Комбо ×${combo}!`); else if (hadBomb) toast('Бум!');

    kill.forEach((t) => { t.el.classList.add('pop'); burst(t); st.grid[t.y][t.x] = null; });
    keep.forEach((t) => {                              // делаем бомбочку
      t.bomb = true; t.el.classList.add('isbomb');
      t.el.insertAdjacentHTML('beforeend', '<i class="bm">💣</i>');
    });
    if (keep.length) { sound.make(); toast('Бомбочка!'); }

    updateHud(); bump('score');
    await sleep(270);
    kill.forEach((t) => t.el.remove());
    await gravity();
  }
}

// Камушки падают вниз, сверху появляются новые
async function gravity() {
  for (let x = 0; x < N; x++) {
    let write = N - 1;
    for (let y = N - 1; y >= 0; y--) {
      const t = st.grid[y][x];
      if (!t) continue;
      if (y !== write) { st.grid[write][x] = t; st.grid[y][x] = null; t.y = write; place(t, x, write); }
      write--;
    }
    for (let y = write; y >= 0; y--) st.grid[y][x] = makeTile(x, y, rnd(TYPES), y - write - 1);
  }
  await sleep(400);
}

// Если ходов не осталось — перемешиваем (бомбочки остаются на месте)
async function shuffle() {
  do { st.grid.flat().forEach((t) => { if (!t.bomb) setType(t, rnd(TYPES)); }); }
  while (findRuns().length || !hasMoves());
  board.classList.add('wiggle'); toast('Перемешали!');
  await sleep(600); board.classList.remove('wiggle');
}

/* =====================================================
   7. УРОВНИ, ПОБЕДА И ПОРАЖЕНИЕ
   ===================================================== */
function startLevel(l) {
  const c = levelCfg(l);
  Object.assign(st, { level: l, moves: c.moves, goal: c.goal, score: 0, grid: [], sel: null });
  board.innerHTML = '';
  for (let y = 0; y < N; y++) {
    const row = [];
    for (let x = 0; x < N; x++) {
      let type;                                         // выбираем вид так, чтобы не было готовых троек
      do { type = rnd(TYPES); } while (
        (x > 1 && row[x - 1].t === type && row[x - 2].t === type) ||
        (y > 1 && st.grid[y - 1][x].t === type && st.grid[y - 2][x].t === type));
      row.push(makeTile(x, y, type, y - N));            // новые камушки «падают» на поле
    }
    st.grid.push(row);
  }
  if (!hasMoves()) shuffle();
  updateHud();
  $('overlay').classList.add('hidden');
  st.busy = false;
}

function win() {
  st.busy = true; sound.win();
  for (let i = 0; i < 12; i++) setTimeout(() => burst({ x: rnd(N), y: rnd(N), t: rnd(TYPES) }), i * 120);
  showOverlay('Ура! Победа!', `Уровень ${st.level} пройден. Очки: ${st.score}`, 'Дальше', () => startLevel(st.level + 1));
}

function lose() {
  st.busy = true; sound.lose();
  showOverlay('Ходы закончились', `Не хватило ${st.goal - st.score} очков. Попробуем ещё?`, 'Ещё раз', () => startLevel(st.level));
}

let overlayAction = null;
function showOverlay(title, text, btn, action) {
  $('ovTitle').textContent = title; $('ovText').textContent = text; $('ovBtn').textContent = btn;
  overlayAction = action;
  $('overlay').classList.remove('hidden');
  $('ovBtn').focus();
}

/* =====================================================
   8. ИНТЕРФЕЙС И ЭФФЕКТЫ
   ===================================================== */
function updateHud() {
  $('level').textContent = st.level;
  $('moves').textContent = st.moves;
  $('score').textContent = st.score;
  $('best').textContent = st.best;
  $('bar').style.width = `${Math.min(100, (st.score / st.goal) * 100)}%`;
  $('goalTxt').textContent = `Цель: ${st.goal}`;
}

function bump(id) {
  const el = $(id); el.classList.add('pop');
  setTimeout(() => el.classList.remove('pop'), 160);
}

function toast(text) {
  const el = $('toast'); el.textContent = text;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
}

// Разлетающиеся цветные искорки из центра клетки
function burst(t) {
  for (let i = 0; i < 7; i++) {
    const s = document.createElement('i');
    s.className = 'spark';
    s.style.left = `${((t.x + 0.5) / N) * 100}%`;
    s.style.top = `${((t.y + 0.5) / N) * 100}%`;
    s.style.background = COLORS[t.t];
    const a = Math.random() * Math.PI * 2, r = 30 + Math.random() * 40;
    s.style.setProperty('--dx', `${Math.cos(a) * r}px`);
    s.style.setProperty('--dy', `${Math.sin(a) * r}px`);
    board.appendChild(s);
    setTimeout(() => s.remove(), 650);
  }
}

/* =====================================================
   9. УПРАВЛЕНИЕ: касание/клик и перетаскивание
   ===================================================== */
const adjacent = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;

function clearSel() { st.sel?.el.classList.remove('sel'); st.sel = null; }
function select(t) { clearSel(); st.sel = t; t.el.classList.add('sel'); }

board.addEventListener('pointerdown', (e) => {
  if (st.busy) return;
  const el = e.target.closest('.tile');
  const t = el && st.grid.flat().find((c) => c.el === el);
  if (!t) return;
  sound.unlock();
  if (st.sel && st.sel !== t && adjacent(st.sel, t)) return trySwap(st.sel, t);  // второй клик по соседу
  select(t);
  st.drag = { x: e.clientX, y: e.clientY, t };                                   // начало перетаскивания
});

board.addEventListener('pointermove', (e) => {
  const d = st.drag;
  if (!d || st.busy) return;
  const dx = e.clientX - d.x, dy = e.clientY - d.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < (board.clientWidth / N) * 0.45) return;  // слишком короткий жест
  st.drag = null;
  const horiz = Math.abs(dx) > Math.abs(dy);
  const other = st.grid[d.t.y + (horiz ? 0 : Math.sign(dy))]?.[d.t.x + (horiz ? Math.sign(dx) : 0)];
  if (other) trySwap(d.t, other);
});

addEventListener('pointerup', () => { st.drag = null; });

$('ovBtn').addEventListener('click', () => { sound.unlock(); overlayAction?.(); });
$('btnSound').addEventListener('click', () => {
  sound.muted = !sound.muted;
  store.set('gem-muted', sound.muted);
  $('btnSound').classList.toggle('off', sound.muted);
});

/* =====================================================
   10. СТАРТ
   ===================================================== */
$('btnSound').classList.toggle('off', sound.muted);
startLevel(1);
st.busy = true;
showOverlay('Радужные камушки', 'Поменяй два соседних камушка. Три в ряд лопаются, четыре дарят бомбочку 💣', 'Играть', () => { $('overlay').classList.add('hidden'); st.busy = false; });
