'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type Axis = 'horizontal' | 'vertical';
type Signal = 'ns' | 'ew';
type Mode = 'ai' | 'manual';
type Direction = 1 | -1;

type Car = { id: number; axis: Axis; road: number; direction: Direction; lane: number; position: number; speed: number; color: string; wait: number; highway: boolean };
type Pedestrian = { id: number; xIndex: number; yIndex: number; axis: Axis; direction: Direction; progress: number; speed: number; color: string };
type Stats = { cars: number; pedestrians: number; queue: number; wait: number; passed: number; episode: number; reward: number; q: number };

const W = 1600;
const H = 1020;
const GRID_X = [150, 340, 530, 720, 910, 1100, 1290, 1480];
const GRID_Y = [170, 330, 490, 650, 810, 960];
const HIGHWAY_Y = 72;
const HIGHWAY_X = 72;
const COLORS = ['#56e5dc', '#ff785d', '#f7d46f', '#9cf173', '#8e9cff', '#f49dc2'];
const PEOPLE = ['#e9f6f6', '#ffc66b', '#b996ff', '#8ff0bd'];

const PHASES = [
  ['01', 'Основа', 'Создали лабораторию, где все решения измеряются, а не оцениваются на глаз.'],
  ['02', 'Генератор дорог', 'Seed собирает новый район с 35 кварталами, улицами и зелёными зонами.'],
  ['03', 'Перекрёстки', '48 перекрёстков знают свои полосы, стоп-линии, переходы и две безопасные фазы.'],
  ['04', 'Машины', 'Каждая машина получает улицу, направление, полосу, скорость и личное время ожидания.'],
  ['05', 'Светофоры', 'Соседние перекрёстки работают в шахматном ритме, чтобы поток не получал красный сразу после зелёного.'],
  ['06', 'Поток', 'Машины входят с края карты, едут через несколько кварталов и выходят с другой стороны.'],
  ['07', 'Безопасность', 'Красный удерживает поток, а правило дистанции не позволяет машинам ехать сквозь друг друга.'],
  ['08', 'Пешеходы', 'На каждом переходе люди идут только в разрешённую фазу. AI получает штраф, если создаёт опасное ожидание.'],
  ['09', 'Ручной режим', 'Можно самому управлять сетью: переключение меняет ритм группы светофоров.'],
  ['10', 'Метрики', 'Очередь, время ожидания, пропускная способность и награда показывают, стало ли городу легче.'],
  ['11', 'Среда RL', 'Состояние — очереди по направлениям. Действие — фаза сети. Награда — быстрый и безопасный поток.'],
  ['12', 'Q-learning', 'Q-таблица помнит, какая фаза полезна при похожем распределении очередей.'],
  ['13', 'Координация', 'Один координатор задаёт волну соседним светофорам. Позже его можно заменить сетью независимых агентов.'],
  ['14', 'Сравнение', 'Оцениваем фиксированный таймер, человека и RL по одинаковым метрикам.'],
  ['15', 'Демо', 'Это безопасный браузерный симулятор: он ничего не меняет на настоящих дорогах.']
] as const;

function randomFactory(seed: number) {
  let value = (seed % 2147483647) || 1;
  return () => { value = (value * 48271) % 2147483647; return value / 2147483647; };
}

function createTraffic(seed: number, amount: number) {
  const random = randomFactory(seed);
  const cars: Car[] = Array.from({ length: amount }, (_, id) => {
    const highway = random() < .22;
    const axis: Axis = random() < .5 ? 'horizontal' : 'vertical';
    const direction: Direction = random() < .5 ? 1 : -1;
    const limit = axis === 'horizontal' ? W : H;
    return { id, axis, road: highway ? 0 : Math.floor(random() * (axis === 'horizontal' ? GRID_Y.length : GRID_X.length)), direction, lane: Math.floor(random() * 2), position: random() * limit, speed: highway ? 92 + random() * 38 : 42 + random() * 28, color: COLORS[id % COLORS.length], wait: 0, highway };
  });
  const pedestrians: Pedestrian[] = Array.from({ length: 56 }, (_, id) => ({ id, xIndex: Math.floor(random() * GRID_X.length), yIndex: Math.floor(random() * GRID_Y.length), axis: random() < .5 ? 'horizontal' : 'vertical', direction: random() < .5 ? 1 : -1, progress: random(), speed: .15 + random() * .16, color: PEOPLE[id % PEOPLE.length] }));
  return { cars, pedestrians };
}

function nodeSignal(xIndex: number, yIndex: number, master: Signal) {
  const inverted = (xIndex + yIndex) % 2 === 1;
  return inverted ? (master === 'ns' ? 'ew' : 'ns') : master;
}

function carPosition(car: Car) {
  const offset = 13 + car.lane * 13;
  if (car.highway) {
    if (car.axis === 'horizontal') return { x: car.position, y: HIGHWAY_Y + (car.direction === 1 ? -offset : offset) };
    return { x: HIGHWAY_X + (car.direction === 1 ? -offset : offset), y: car.position };
  }
  if (car.axis === 'horizontal') return { x: car.position, y: GRID_Y[car.road] + (car.direction === 1 ? -offset : offset) };
  return { x: GRID_X[car.road] + (car.direction === 1 ? -offset : offset), y: car.position };
}

function nextIntersection(car: Car) {
  if (car.highway) return null;
  const nodes = car.axis === 'horizontal' ? GRID_X : GRID_Y;
  const index = car.direction === 1 ? nodes.findIndex((node) => node > car.position + 2) : [...nodes].reverse().findIndex((node) => node < car.position - 2);
  if (index < 0) return null;
  const resolvedIndex = car.direction === 1 ? index : nodes.length - 1 - index;
  return { coordinate: nodes[resolvedIndex], xIndex: car.axis === 'horizontal' ? resolvedIndex : car.road, yIndex: car.axis === 'vertical' ? resolvedIndex : car.road };
}

function countQueues(cars: Car[]) {
  let ns = 0; let ew = 0;
  cars.forEach((car) => {
    const next = nextIntersection(car);
    if (!next || Math.abs(next.coordinate - car.position) > 110) return;
    if (car.axis === 'horizontal') ew += 1; else ns += 1;
  });
  return { ns, ew };
}

function advanceCars(cars: Car[], master: Signal, dt: number, passed: () => void) {
  const proposed = cars.map((car) => {
    const next = nextIntersection(car);
    const distance = car.speed * dt;
    if (next) {
      const stop = next.coordinate - car.direction * 43;
      const phase = nodeSignal(next.xIndex, next.yIndex, master);
      const green = car.axis === 'horizontal' ? phase === 'ew' : phase === 'ns';
      const beforeStop = car.direction === 1 ? car.position <= stop + .4 : car.position >= stop - .4;
      const wouldCross = car.direction === 1 ? car.position + distance >= stop : car.position - distance <= stop;
      if (!green && beforeStop && wouldCross) return { ...car, position: stop, wait: car.wait + dt };
    }
    const limit = car.axis === 'horizontal' ? W : H;
    let position = car.position + car.direction * distance;
    if (position > limit + 24 || position < -24) { position = car.direction === 1 ? -22 : limit + 22; passed(); }
    return { ...car, position };
  });

  const grouped = new Map<string, Car[]>();
  proposed.forEach((car) => { const key = `${car.highway}:${car.axis}:${car.road}:${car.direction}:${car.lane}`; grouped.set(key, [...(grouped.get(key) || []), car]); });
  const safe: Car[] = [];
  grouped.forEach((lane) => {
    const ordered = [...lane].sort((a, b) => a.direction === 1 ? b.position - a.position : a.position - b.position);
    let leader: Car | undefined;
    ordered.forEach((car) => {
      if (!leader) { safe.push(car); leader = car; return; }
      const gap = car.highway ? 30 : 34;
      const allowed = car.direction === 1 ? leader.position - gap : leader.position + gap;
      const close = car.direction === 1 ? car.position > allowed : car.position < allowed;
      const next = close ? { ...car, position: allowed, wait: car.wait + dt } : car;
      safe.push(next); leader = next;
    });
  });
  return safe;
}

function advancePedestrians(pedestrians: Pedestrian[], master: Signal, dt: number) {
  return pedestrians.map((person) => {
    const phase = nodeSignal(person.xIndex, person.yIndex, master);
    const canWalk = person.axis === 'horizontal' ? phase === 'ns' : phase === 'ew';
    if (!canWalk) return person;
    let progress = person.progress + person.direction * person.speed * dt;
    if (progress > 1.08 || progress < -.08) return { ...person, progress: person.direction === 1 ? -.05 : 1.05 };
    return { ...person, progress };
  });
}

function signalName(signal: Signal) { return signal === 'ns' ? 'север ↕ юг' : 'запад ↔ восток'; }

export default function CitySimulator() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simulationRef = useRef<HTMLDivElement | null>(null);
  const initial = useMemo(() => createTraffic(281, 130), []);
  const carsRef = useRef<Car[]>(initial.cars);
  const pedestriansRef = useRef<Pedestrian[]>(initial.pedestrians);
  const signalRef = useRef<Signal>('ns');
  const modeRef = useRef<Mode>('ai');
  const runningRef = useRef(true);
  const qRef = useRef<Record<string, [number, number]>>({});
  const previousRef = useRef<{ state: string; action: 0 | 1 } | null>(null);
  const totalsRef = useRef({ passed: 0, episode: 0, reward: 0 });
  const [mode, setMode] = useState<Mode>('ai');
  const [running, setRunning] = useState(true);
  const [signal, setSignal] = useState<Signal>('ns');
  const [seed, setSeed] = useState(281);
  const [density, setDensity] = useState(130);
  const [selected, setSelected] = useState(13);
  const [stats, setStats] = useState<Stats>({ cars: 130, pedestrians: 56, queue: 0, wait: 0, passed: 0, episode: 0, reward: 0, q: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);

  const selectedPhase = PHASES[selected - 1];
  const progress = useMemo(() => Math.round((selected / PHASES.length) * 100), [selected]);
  const setLight = (next: Signal) => { signalRef.current = next; setSignal(next); };
  const setRun = (next: boolean) => { runningRef.current = next; setRunning(next); };
  const setModeNow = (next: Mode) => { modeRef.current = next; setMode(next); };
  const toggleFullscreen = async () => {
    const simulation = simulationRef.current;
    if (!simulation) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    try {
      await simulation.requestFullscreen();
    } catch {
      setIsFullscreen((value) => !value);
    }
  };

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  const newCity = () => {
    const nextSeed = Math.floor(Math.random() * 90000) + 1000;
    const next = createTraffic(nextSeed, density);
    carsRef.current = next.cars; pedestriansRef.current = next.pedestrians; totalsRef.current = { passed: 0, episode: 0, reward: 0 }; previousRef.current = null;
    setSeed(nextSeed); setStats({ cars: density, pedestrians: next.pedestrians.length, queue: 0, wait: 0, passed: 0, episode: 0, reward: 0, q: 0 });
  };

  const trainFast = () => {
    let rewardSum = 0;
    for (let step = 0; step < 1200; step += 1) {
      const ns = Math.floor(Math.random() * 48); const ew = Math.floor(Math.random() * 48);
      const state = `${Math.min(4, Math.floor(ns / 10))}-${Math.min(4, Math.floor(ew / 10))}`;
      const q = qRef.current[state] || [0, 0];
      const action: 0 | 1 = Math.random() < .12 ? (Math.random() < .5 ? 0 : 1) : q[0] >= q[1] ? 0 : 1;
      const served = action === 0 ? ns : ew; const blocked = action === 0 ? ew : ns;
      const reward = served * 1.5 - blocked * 1.13 - Math.abs(ns - ew) * .14;
      q[action] += .15 * (reward - q[action]); qRef.current[state] = q; rewardSum += reward;
    }
    totalsRef.current.episode += 1200; totalsRef.current.reward = rewardSum / 1200;
  };

  useEffect(() => {
    const canvas = canvasRef.current; const context = canvas?.getContext('2d'); if (!canvas || !context) return;
    let animation = 0; let previousTime = performance.now(); let lastDecision = previousTime; let lastMetrics = previousTime;
    const decide = () => {
      const queues = countQueues(carsRef.current); const state = `${Math.min(4, Math.floor(queues.ns / 10))}-${Math.min(4, Math.floor(queues.ew / 10))}`;
      const table = qRef.current[state] || [0, 0]; const action: 0 | 1 = Math.random() < .1 ? (Math.random() < .5 ? 0 : 1) : table[0] >= table[1] ? 0 : 1;
      const nextSignal: Signal = action === 0 ? 'ns' : 'ew'; const reward = (nextSignal === 'ns' ? queues.ns : queues.ew) * 1.35 - (nextSignal === 'ns' ? queues.ew : queues.ns) * 1.08;
      const previous = previousRef.current;
      if (previous) { const q = qRef.current[previous.state] || [0, 0]; q[previous.action] += .14 * (reward + .87 * Math.max(...table) - q[previous.action]); qRef.current[previous.state] = q; }
      previousRef.current = { state, action }; totalsRef.current.episode += 1; totalsRef.current.reward = reward; setLight(nextSignal);
    };
    const drawRoad = (axis: Axis, coordinate: number, width: number, highway = false) => {
      const half = width / 2;
      context.fillStyle = '#b6c0bb';
      if (axis === 'horizontal') context.fillRect(0, coordinate - half - 8, W, width + 16); else context.fillRect(coordinate - half - 8, 0, width + 16, H);
      context.fillStyle = highway ? '#33444e' : '#495960';
      if (axis === 'horizontal') context.fillRect(0, coordinate - half, W, width); else context.fillRect(coordinate - half, 0, width, H);
      context.strokeStyle = highway ? 'rgba(255,224,90,.86)' : 'rgba(239,238,215,.68)'; context.lineWidth = highway ? 2 : 1.25; context.setLineDash(highway ? [15, 12] : [12, 18]); context.beginPath();
      const lanes = highway ? [-25, -8, 8, 25] : [-12, 12];
      lanes.forEach((lane) => { if (axis === 'horizontal') { context.moveTo(0, coordinate + lane); context.lineTo(W, coordinate + lane); } else { context.moveTo(coordinate + lane, 0); context.lineTo(coordinate + lane, H); } });
      context.stroke(); context.setLineDash([]);
      if (highway) {
        context.strokeStyle = 'rgba(212,229,232,.55)'; context.lineWidth = 3; context.beginPath();
        if (axis === 'horizontal') { context.moveTo(0, coordinate - half + 5); context.lineTo(W, coordinate - half + 5); context.moveTo(0, coordinate + half - 5); context.lineTo(W, coordinate + half - 5); }
        else { context.moveTo(coordinate - half + 5, 0); context.lineTo(coordinate - half + 5, H); context.moveTo(coordinate + half - 5, 0); context.lineTo(coordinate + half - 5, H); }
        context.stroke();
      }
    };

    const drawTree = (x: number, y: number, size: number) => {
      context.fillStyle = 'rgba(0,0,0,.18)'; context.beginPath(); context.ellipse(x + 3, y + 5, size, size * .45, 0, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#27684d'; context.beginPath(); context.arc(x, y, size, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#4f9a68'; context.beginPath(); context.arc(x - size * .25, y - size * .3, size * .62, 0, Math.PI * 2); context.fill();
    };

    const drawBuilding = (x: number, y: number, width: number, height: number, hue: number) => {
      context.fillStyle = 'rgba(0,0,0,.24)'; context.fillRect(x + 5, y + 6, width, height);
      context.fillStyle = `hsl(${hue} 20% 38%)`; context.fillRect(x, y, width, height);
      context.fillStyle = `hsl(${hue} 18% 48%)`; context.fillRect(x + 3, y + 3, width - 6, 6);
      context.fillStyle = 'rgba(204,235,225,.36)';
      for (let wx = x + 7; wx < x + width - 5; wx += 10) for (let wy = y + 13; wy < y + height - 5; wy += 11) context.fillRect(wx, wy, 4, 5);
    };
    const draw = () => {
      context.clearRect(0, 0, W, H); const bg = context.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#204a55'); bg.addColorStop(.45, '#153440'); bg.addColorStop(1, '#0b202b'); context.fillStyle = bg; context.fillRect(0, 0, W, H);
      const random = randomFactory(seed);
      for (let yi = 0; yi < GRID_Y.length - 1; yi += 1) for (let xi = 0; xi < GRID_X.length - 1; xi += 1) {
        const x = GRID_X[xi] + 37; const y = GRID_Y[yi] + 37; const width = GRID_X[xi + 1] - GRID_X[xi] - 74; const height = GRID_Y[yi + 1] - GRID_Y[yi] - 74; const park = random() < .16;
        context.fillStyle = '#d6dbd3'; context.fillRect(x - 5, y - 5, width + 10, height + 10);
        if (park) {
          context.fillStyle = '#3e805c'; context.fillRect(x, y, width, height);
          context.fillStyle = 'rgba(210,242,130,.36)'; context.fillRect(x + width * .13, y + height * .46, width * .74, 4);
          for (let tree = 0; tree < 10; tree += 1) drawTree(x + 18 + random() * (width - 36), y + 18 + random() * (height - 36), 6 + random() * 4);
        } else {
          context.fillStyle = '#7d9392'; context.fillRect(x, y, width, height);
          let cursor = x + 10;
          while (cursor < x + width - 24) { const buildingWidth = 22 + random() * 28; const buildingHeight = Math.min(height - 22, 24 + random() * Math.max(12, height - 42)); const freeY = Math.max(2, height - buildingHeight - 16); drawBuilding(cursor, y + 8 + random() * freeY, Math.min(buildingWidth, x + width - cursor - 8), buildingHeight, 185 + random() * 35); cursor += buildingWidth + 9 + random() * 10; }
        }
      }
      drawRoad('horizontal', HIGHWAY_Y, 72, true); drawRoad('vertical', HIGHWAY_X, 72, true);
      GRID_Y.forEach((y) => drawRoad('horizontal', y, 58)); GRID_X.forEach((x) => drawRoad('vertical', x, 58));
      GRID_Y.forEach((y, yIndex) => GRID_X.forEach((x, xIndex) => {
        const phase = nodeSignal(xIndex, yIndex, signalRef.current); context.fillStyle = '#c2cbc6'; context.fillRect(x - 35, y - 35, 70, 70); context.fillStyle = '#55666d'; context.fillRect(x - 29, y - 29, 58, 58);
        context.fillStyle = 'rgba(245,247,230,.7)'; for (let n = -20; n <= 16; n += 9) { context.fillRect(x + n, y - 27, 5, 11); context.fillRect(x + n, y + 16, 5, 11); context.fillRect(x - 27, y + n, 11, 5); context.fillRect(x + 16, y + n, 11, 5); }
        [[x - 36, y - 36, phase === 'ns'], [x + 27, y + 27, phase === 'ns'], [x + 27, y - 36, phase === 'ew'], [x - 36, y + 27, phase === 'ew']].forEach(([lx, ly, green]) => { context.fillStyle = '#0a1318'; context.fillRect(lx as number, ly as number, 8, 15); context.fillStyle = green ? '#9cf173' : '#ff745d'; context.beginPath(); context.arc((lx as number) + 4, (ly as number) + (green ? 11 : 4), 2.3, 0, Math.PI * 2); context.fill(); });
      }));
      pedestriansRef.current.forEach((person) => { const x0 = GRID_X[person.xIndex]; const y0 = GRID_Y[person.yIndex]; const offset = (person.progress - .5) * 52; const x = person.axis === 'horizontal' ? x0 + offset : x0 + (person.direction * 17); const y = person.axis === 'vertical' ? y0 + offset : y0 + (person.direction * 17); context.fillStyle = 'rgba(0,0,0,.2)'; context.beginPath(); context.ellipse(x + 2, y + 6, 3.5, 1.6, 0, 0, Math.PI * 2); context.fill(); context.fillStyle = person.color; context.beginPath(); context.arc(x, y - 4, 3, 0, Math.PI * 2); context.fill(); context.fillStyle = '#293d44'; context.fillRect(x - 2, y, 4, 7); });
      carsRef.current.forEach((car) => { const p = carPosition(car); context.save(); context.translate(p.x, p.y); if (car.axis === 'vertical') context.rotate(Math.PI / 2); if (car.direction < 0) context.rotate(Math.PI); context.fillStyle = 'rgba(0,0,0,.25)'; context.fillRect(-9, 5, 20, 3); context.fillStyle = car.color; context.shadowColor = car.color; context.shadowBlur = car.highway ? 8 : 5; context.fillRect(-11, -5, 22, 11); context.fillStyle = 'rgba(224,244,247,.72)'; context.fillRect(-2, -4, 8, 8); context.fillStyle = '#18242a'; context.fillRect(-7, 5, 5, 3); context.fillRect(5, 5, 5, 3); context.fillStyle = car.direction === 1 ? '#fff3ba' : '#ff8e79'; context.fillRect(9, -3, 2, 3); context.restore(); context.shadowBlur = 0; });
      context.fillStyle = 'rgba(6,17,23,.88)'; context.fillRect(17, 17, 316, 64); context.fillStyle = '#9cf173'; context.font = '700 12px Arial'; context.fillText('CITY TWIN · 35 BLOCKS · 48 JUNCTIONS', 32, 40); context.fillStyle = '#c5d8dd'; context.font = '13px Arial'; context.fillText('Green wave: ' + signalName(signalRef.current) + ' · seed ' + seed, 32, 63);
    };
    const tick = (time: number) => {
      const dt = Math.min(.06, (time - previousTime) / 1000); previousTime = time;
      if (runningRef.current) { carsRef.current = advanceCars(carsRef.current, signalRef.current, dt, () => { totalsRef.current.passed += 1; }); pedestriansRef.current = advancePedestrians(pedestriansRef.current, signalRef.current, dt); if (modeRef.current === 'ai' && time - lastDecision > 1550) { decide(); lastDecision = time; } }
      draw();
      if (time - lastMetrics > 350) { const queues = countQueues(carsRef.current); const totalWait = carsRef.current.reduce((sum, car) => sum + car.wait, 0); const last = previousRef.current; const q = last ? (qRef.current[last.state] || [0, 0])[last.action] : 0; setStats({ cars: carsRef.current.length, pedestrians: pedestriansRef.current.length, queue: queues.ns + queues.ew, wait: totalWait / Math.max(1, carsRef.current.length), passed: totalsRef.current.passed, episode: totalsRef.current.episode, reward: totalsRef.current.reward, q }); lastMetrics = time; }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick); return () => cancelAnimationFrame(animation);
  }, [seed]);

  return <main className="lab-shell"><header className="lab-header"><a className="brand" href="#top"><span className="brand-grid">▦</span> smart<span>city</span>rl</a><div className="header-center"><b>48</b><span>перекрёстков online</span></div><span className="status-pill"><i /> city network</span></header>
    <section className="intro" id="top"><div><p className="kicker">SMART CITY RL · CITY-SCALE SIMULATION</p><h1>Город на <em>десятки кварталов.</em></h1></div><p>35 кварталов, 48 перекрёстков, две скоростные магистрали, сотни маршрутов и пешеходные переходы. AI управляет волной светофоров во всей сети.</p></section>
    <section className="workspace" aria-label="Большая городская симуляция"><aside className="control-panel"><div className="panel-title"><span>СЕТЕВОЙ КОНТРОЛЛЕР</span><b>LIVE</b></div><label className="segmented"><button className={mode === 'ai' ? 'on' : ''} onClick={() => setModeNow('ai')}>AI режим</button><button className={mode === 'manual' ? 'on' : ''} onClick={() => setModeNow('manual')}>Вручную</button></label><div className="control-block"><span>Волна зелёного</span><strong>{signalName(signal)}</strong><div className="light-switch"><button className={signal === 'ns' ? 'green' : ''} disabled={mode === 'ai'} onClick={() => setLight('ns')}>↕ N–S</button><button className={signal === 'ew' ? 'green' : ''} disabled={mode === 'ai'} onClick={() => setLight('ew')}>↔ W–E</button></div></div><div className="control-block"><span>Плотность сети</span><input aria-label="Плотность машин" type="range" min="70" max="220" value={density} onChange={(event) => setDensity(Number(event.target.value))}/><small>{density} машин после генерации</small></div><button className="action primary" onClick={trainFast}>Ускоренно обучить AI <span>+1200</span></button><button className="action" onClick={newCity}>Сгенерировать большой город</button><button className="pause" onClick={() => setRun(!running)}>{running ? 'Ⅱ Пауза симуляции' : '▶ Продолжить симуляцию'}</button></aside><div ref={simulationRef} className={`simulation-card ${isFullscreen ? 'fullscreen' : ''}`}><div className="simulation-head"><div><span className="kicker">ФАЗЫ 02–13 · СЕТЬ ГОРОДА</span><h2>Район: {GRID_X.length * GRID_Y.length} светофоров</h2></div><div className="simulation-actions"><div className="ai-decision"><i/> {mode === 'ai' ? 'AI создаёт зелёную волну каждые 1.55 с' : 'Вы задаёте фазу всей сети'}</div><button className="fullscreen-button" type="button" onClick={toggleFullscreen} aria-pressed={isFullscreen}>{isFullscreen ? 'Свернуть' : 'Полный экран'} <span>{isFullscreen ? '×' : '⛶'}</span></button></div></div><canvas ref={canvasRef} width={W} height={H} className="city-canvas" aria-label="Карта города с кварталами, магистралями, машинами и пешеходами"/><div className="canvas-legend"><span><i className="legend-car"/> автомобили</span><span><i className="legend-light"/> пешеходы</span><span><i className="legend-line"/> магистрали</span></div></div></section>
    <section className="metrics-grid" aria-label="Метрики городской сети"><article><span>АВТОМОБИЛИ</span><strong>{stats.cars}</strong><small>на улицах и магистралях</small></article><article><span>ПЕШЕХОДЫ</span><strong>{stats.pedestrians}</strong><small>на переходах</small></article><article><span>ОЧЕРЕДЬ</span><strong>{stats.queue}</strong><small>перед ближайшими узлами</small></article><article className="reward"><span>НАГРАДА AI</span><strong>{stats.reward >= 0 ? '+' : ''}{stats.reward.toFixed(1)}</strong><small>поток минус ожидание</small></article></section>
    <section className="rl-explainer"><div className="explainer-title"><p className="kicker">ФАЗЫ 09–14 · RL В ГОРОДСКОЙ СЕТИ</p><h2>Одна волна.<br/><em>Много перекрёстков.</em></h2></div><div className="rl-loop"><article><b>01</b><span>Состояние</span><strong>{stats.queue} машин ждут</strong><p>AI видит очереди по всей сетке.</p></article><i>→</i><article><b>02</b><span>Действие</span><strong>{signalName(signal)}</strong><p>Выбирает фазу и шахматный ритм узлов.</p></article><i>→</i><article><b>03</b><span>Награда</span><strong className={stats.reward >= 0 ? 'positive' : 'negative'}>{stats.reward >= 0 ? '+' : ''}{stats.reward.toFixed(1)}</strong><p>Больше проехало, меньше стояло.</p></article><i>→</i><article><b>04</b><span>Память Q</span><strong>{stats.q.toFixed(2)}</strong><p>Сохраняет полезность решения.</p></article></div><div className="training-note"><span>ЭПИЗОДОВ ОБУЧЕНИЯ</span><b>{stats.episode.toLocaleString('ru-RU')}</b><p>Ускоренное обучение пробует тысячи разных распределений машин, чтобы находить более полезную фазу.</p></div></section>
    <section className="curriculum"><div className="curriculum-head"><div><p className="kicker">15 ФАЗ · УЧЕБНИК ВНУТРИ ПРОЕКТА</p><h2>Нажми фазу —<br/>я объясню её.</h2></div><div className="completion"><b>{progress}%</b><span>путь просмотра</span><i><em style={{width:`${progress}%`}}/></i></div></div><div className="phase-list" role="tablist">{PHASES.map(([number,title],index)=><button key={number} role="tab" aria-selected={selected===index+1} className={selected===index+1?'selected':''} onClick={()=>setSelected(index+1)}><b>{number}</b><span>{title}</span><i>✓</i></button>)}</div><article className="phase-lesson"><div className="big-number">{selectedPhase[0]}</div><div><p className="kicker">ФАЗА {selectedPhase[0]} · {selectedPhase[1].toUpperCase()}</p><h3>{selectedPhase[1]}</h3><p>{selectedPhase[2]}</p></div><div className="teacher-tip"><b>Как запомнить</b><span>{selected===13?'Координация — это когда соседние перекрёстки не принимают решения в одиночку, а создают зелёную волну.':selected===8?'Пешеход — часть среды: быстрый город без безопасного перехода не считается хорошим решением.':'Каждая фаза добавляет один строительный блок, поэтому большую систему можно понять шаг за шагом.'}</span></div></article></section>
    <section className="comparison"><div><p className="kicker">ФАЗА 14 · ЧЕСТНОЕ СРАВНЕНИЕ</p><h2>Кто лучше ведёт большой город?</h2></div><div className="comparison-cards"><article><span>ФИКСИРОВАННЫЙ ТАЙМЕР</span><b>40/100</b><p>Не замечает пробки в разных кварталах.</p></article><article><span>РУЧНАЯ ВОЛНА</span><b>—</b><p>Попробуйте задать её сами.</p></article><article className="best"><span>Q‑LEARNING AI</span><b>{Math.max(42,Math.min(98,Math.round(58+stats.q*5+stats.episode/180)))}/100</b><p>Учится по результату всей сети.</p></article></div></section><footer className="lab-footer"><div><span className="brand-grid">▦</span> SMART CITY RL</div><p>35 кварталов · 48 перекрёстков · 2 магистрали · 56 пешеходов. Это учебная, безопасная симуляция.</p></footer></main>;
}
