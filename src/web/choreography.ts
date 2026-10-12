import type { Atlas } from '../backend/assets.js';
import { boutWinner } from '../core/ending.js';
import { other, type CombatEvent, type Fighter, type Match } from '../core/types.js';

export const FLOOR = 548,
  SCALE = 1.18;
export type Point = { x: number; y: number };
export type Pose = Point & { frame: number; rotation: number; scale: number; alpha: number };
export type Impact = {
  at: number;
  point: Point;
  kind: 'hit' | 'block' | 'parry' | 'special' | 'finisher' | 'landing';
};
export type Cue = { at: number; kind: string };
export type Scene = {
  poses: Record<Fighter, Pose>;
  impacts: Impact[];
  cues: Cue[];
  shade: number;
  zoom: number;
  finisher: Fighter | null;
  charge: number;
  contact: Point | null;
};
export type Atlases = Record<Fighter, Atlas>;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const smooth = (n: number) => {
  n = clamp(n);
  return n * n * (3 - 2 * n);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const side = (a: Fighter) => (a === 'claude' ? 1 : -1);
const rest = (a: Fighter) => (a === 'claude' ? 345 : 855);
const anim = (atlas: Atlas, name: string, index = 0) => {
  const a = atlas.animations[name] ?? atlas.animations.idle;
  return a.frames[Math.min(index, a.frames.length - 1)];
};
export function frameAt(atlas: Atlas, name: string, time: number) {
  const a = atlas.animations[name] ?? atlas.animations.idle,
    total = a.durations.reduce((s, n) => s + n, 0);
  let t = a.loop ? time % total : Math.min(time, total - 1);
  for (let i = 0; i < a.frames.length; i++) {
    if (t < a.durations[i]) return a.frames[i];
    t -= a.durations[i];
  }
  return a.frames.at(-1)!;
}
export function worldPoint(atlas: Atlas, pose: Pose, agent: Fighter, point: Point): Point {
  const f = atlas.frames[pose.frame],
    mirror = side(agent) * (atlas.facing === 'left' ? -1 : 1),
    x = (point.x - f.pivotX) * SCALE * pose.scale * mirror,
    y = (point.y - f.pivotY) * SCALE * pose.scale,
    c = Math.cos(pose.rotation),
    s = Math.sin(pose.rotation);
  return { x: pose.x + x * c - y * s, y: pose.y + x * s + y * c };
}
export function socket(atlas: Atlas, frame: number, name: 'contact' | 'hurt'): Point {
  const f = atlas.frames[frame];
  return (
    f[name] ?? {
      x: f.pivotX + (name === 'contact' ? f.w * 0.43 * (atlas.facing === 'left' ? -1 : 1) : 0),
      y: f.h * 0.26,
    }
  );
}
export function eventDuration(e: CombatEvent | null) {
  if (e?.type === 'finisher') return 3600;
  if (e?.exchange) return 2600;
  if (e?.type === 'combo') return 1900;
  if (e?.type === 'special') return 2000;
  return 1450;
}
const offense = new Set(['attack', 'counter', 'combo', 'special', 'finisher']),
  defense = new Set(['block', 'parry']);
export function combatScene(
  atlases: Atlases,
  match: Pick<Match, 'status' | 'battle'>,
  event: CombatEvent | null,
  elapsed: number,
  idleTime: number,
  reduced = false,
): Scene {
  const poses = {} as Record<Fighter, Pose>;
  for (const a of ['claude', 'codex'] as const)
    poses[a] = {
      x: rest(a),
      y: FLOOR,
      frame: frameAt(
        atlases[a],
        match.status === 'scouting'
          ? 'scouting'
          : (event?.health[a] ?? 100) < 40
            ? 'fatigue'
            : 'idle',
        reduced ? 0 : idleTime,
      ),
      rotation: 0,
      scale: 1,
      alpha: 1,
    };
  const scene: Scene = {
    poses,
    impacts: [],
    cues: [],
    shade: 0,
    zoom: 1,
    finisher: null,
    charge: 0,
    contact: null,
  };
  if (!event) return scene;
  const ended =
    event.type === 'finish' ||
    (match.battle.knockout && event.seq > match.battle.knockout.seq && event.type !== 'finisher');
  if (ended) {
    const result = boutWinner(event, match.battle.knockout);
    for (const a of ['claude', 'codex'] as const)
      poses[a].frame =
        result.winner === 'draw'
          ? anim(atlases[a], 'victory', 1)
          : result.winner === a
            ? anim(atlases[a], 'victory')
            : anim(atlases[a], 'defeat', 1);
    scene.cues = [{ at: 0, kind: result.winner === 'draw' ? 'ending-draw' : 'ending-victory' }];
    return scene;
  }
  const agent = event.agent;
  if (!agent) return scene;
  if (!offense.has(event.type) && !defense.has(event.type)) {
    const name = (
      {
        recoil: 'recoil',
        correction: 'recoil',
        fatigue: 'fatigue',
        'special-discovered': 'victory',
      } as Record<string, string>
    )[event.type];
    if (name && elapsed < 1100)
      poses[agent].frame = frameAt(atlases[agent], name, reduced ? 0 : elapsed);
    if (name) scene.cues = [{ at: 0, kind: event.type }];
    return scene;
  }
  const guarded = defense.has(event.type),
    attacker = guarded ? other(agent) : agent,
    defender = other(attacker),
    a = atlases[attacker],
    d = atlases[defender],
    finisher = event.type === 'finisher',
    special = event.type === 'special';
  const primary = finisher ? 1120 : special ? 650 : 340,
    last = event.type === 'combo' ? 900 : primary,
    hold = finisher ? 155 : 105;
  const strike = finisher
    ? anim(a, a.animations.finisher ? 'finisher' : 'attack', 1)
    : anim(a, event.type === 'counter' ? 'kick' : 'attack', 1);
  const targetFrame = anim(d, guarded ? 'block' : 'hit'),
    targetSocket = socket(d, targetFrame, guarded ? 'contact' : 'hurt'),
    strikeSocket = socket(a, strike, 'contact');
  const attackPose: Pose = { ...poses[attacker], frame: strike },
    targetPose: Pose = {
      ...poses[defender],
      frame: targetFrame,
      x: rest(defender) + side(defender) * 115,
    };
  const hitPoint = worldPoint(d, targetPose, defender, targetSocket),
    fist = worldPoint(a, attackPose, attacker, strikeSocket);
  attackPose.x += hitPoint.x - fist.x;
  // Keep both feet at or above the floor while aligning the actual cel sockets.
  const difference = hitPoint.y - fist.y;
  if (difference < 0) attackPose.y += difference;
  else targetPose.y -= difference;
  const contact = worldPoint(a, attackPose, attacker, strikeSocket);
  scene.contact = contact;
  const start = finisher ? 780 : special ? 350 : 100,
    approach = smooth((elapsed - start) / (primary - start));
  const retreat = smooth((elapsed - (last + hold + 240)) / (finisher ? 900 : 340));
  for (const who of [attacker, defender]) {
    const target = who === attacker ? attackPose : targetPose;
    poses[who].x = lerp(rest(who), target.x, approach);
    poses[who].y = lerp(FLOOR, target.y, approach);
    if (!finisher) {
      poses[who].x = lerp(poses[who].x, rest(who), retreat);
      poses[who].y = lerp(poses[who].y, FLOOR, retreat);
    }
  }
  const impactTimes = event.type === 'combo' ? [340, 620, 900] : [primary];
  scene.impacts = impactTimes.map((at) => ({
    at,
    point: contact,
    kind: finisher
      ? 'finisher'
      : special
        ? 'special'
        : guarded
          ? (event.type as 'block' | 'parry')
          : 'hit',
  }));
  scene.cues = [
    { at: finisher ? 0 : Math.max(0, start - 30), kind: finisher ? `charge-${agent}` : 'swing' },
    ...impactTimes.map((at) => ({
      at,
      kind: finisher ? `finisher-${agent}` : guarded ? event.type : special ? 'special' : 'impact',
    })),
  ];
  const recent = impactTimes.filter((t) => elapsed >= t).at(-1),
    holding = recent !== undefined && elapsed < recent + hold + 145;
  const anticipation = finisher || special ? anim(a, 'special', 0) : anim(a, 'attack');
  if (elapsed < primary) poses[attacker].frame = anticipation;
  else if (holding) poses[attacker].frame = strike;
  else if (elapsed < last + hold + 240) poses[attacker].frame = anim(a, 'attack');
  if (guarded) {
    poses[defender].frame = anim(d, 'block');
    if (event.type === 'parry' && elapsed > primary + hold && elapsed < primary + hold + 260) {
      poses[defender].frame = anim(d, 'parry');
      poses[attacker].frame = anim(a, 'recoil');
    }
  } else if (holding) poses[defender].frame = targetFrame;
  if (!guarded && !finisher && elapsed > last + hold) {
    const recoil = Math.sin(clamp((elapsed - last - hold) / 340) * Math.PI) * 34;
    poses[defender].x -= side(defender) * recoil;
  }
  if (special && elapsed > primary + hold && elapsed < 1500) {
    const jump = Math.sin(clamp((elapsed - primary - hold) / 650) * Math.PI);
    poses[attacker].frame = anim(a, 'special', 1);
    poses[attacker].y -= jump * 72;
    poses[defender].frame = targetFrame;
    poses[defender].y -= jump * 120;
  }
  if (finisher) {
    scene.finisher = agent;
    scene.shade = 0.6 * smooth(elapsed / 250) * (1 - smooth((elapsed - 2500) / 600));
    scene.zoom = 1 + 0.065 * smooth(elapsed / 600) * (1 - smooth((elapsed - 2500) / 600));
    scene.charge = clamp(elapsed / primary) * (1 - smooth((elapsed - primary) / 400));
    if (elapsed > primary + hold) {
      const flight = clamp((elapsed - primary - hold) / 960),
        ease = smooth(flight);
      poses[defender].frame = targetFrame;
      poses[defender].x = lerp(targetPose.x, rest(defender) - side(defender) * 65, ease);
      poses[defender].y = FLOOR - Math.sin(flight * Math.PI) * (agent === 'codex' ? 290 : 160);
      poses[defender].rotation = -side(defender) * Math.sin(flight * Math.PI) * 0.65;
      poses[attacker].frame = agent === 'codex' ? anim(a, 'special', 1) : strike;
      poses[attacker].y = FLOOR - Math.sin(flight * Math.PI) * (agent === 'codex' ? 130 : 12);
      if (flight >= 1) {
        poses[defender].frame = anim(d, 'defeat', 1);
        poses[attacker].frame = anim(a, 'victory');
        poses[attacker].x = lerp(attackPose.x, rest(attacker), smooth((elapsed - 2500) / 550));
      }
    }
    scene.impacts.push({
      at: primary + hold + 960,
      point: { x: rest(defender) - side(defender) * 65, y: FLOOR - 4 },
      kind: 'landing',
    });
    scene.cues.push({ at: primary + hold + 960, kind: 'landing' });
  }
  if (reduced) {
    for (const who of [attacker, defender])
      Object.assign(poses[who], { x: rest(who), y: FLOOR, rotation: 0 });
    poses[attacker].frame = anim(a, finisher ? 'victory' : 'attack');
    poses[defender].frame = anim(d, finisher ? 'defeat' : 'block', finisher ? 1 : 0);
    scene.impacts = [];
    scene.shade = 0;
    scene.zoom = 1;
    scene.charge = 0;
    scene.cues = [
      { at: 0, kind: finisher ? 'ending-victory' : guarded ? event.type : 'soft-impact' },
    ];
  }
  return scene;
}
