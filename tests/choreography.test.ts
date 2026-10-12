import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Atlas } from '../src/backend/assets.js';
import {
  combatScene,
  worldPoint,
  socket,
  eventDuration,
  type Atlases,
} from '../src/web/choreography.js';
import { syncFinisher, boutWinner } from '../src/core/ending.js';
import { demoMatch } from '../src/core/demo.js';
import { newMatch, finish, applyFatigue } from '../src/core/battle.js';
import { CombatEvent, other, type Fighter } from '../src/core/types.js';
const atlases = Object.fromEntries(
  ['claude', 'codex'].map((a) => [
    a,
    Atlas.parse(JSON.parse(readFileSync(`assets/${a}.json`, 'utf8'))),
  ]),
) as Atlases;
const sample = demoMatch();
function event(type: CombatEvent['type'], agent: Fighter) {
  return { ...sample.events.find((e) => e.type === 'attack')!, type, agent, exchange: undefined };
}
for (const agent of ['claude', 'codex'] as const)
  for (const type of [
    'attack',
    'counter',
    'combo',
    'special',
    'block',
    'parry',
    'finisher',
  ] as const)
    test(`${agent} ${type} reaches physical contact before hit pause and keeps both sprites above the floor`, () => {
      const e = event(type, agent),
        time = type === 'finisher' ? 1120 : type === 'special' ? 650 : 340;
      const scene = combatScene(
          atlases,
          { status: 'reviewing', battle: { ...sample.battle, knockout: null } },
          e,
          time,
          0,
        ),
        guarded = type === 'block' || type === 'parry',
        attacker = guarded ? other(agent) : agent,
        defender = other(attacker);
      const fist = worldPoint(
        atlases[attacker],
        scene.poses[attacker],
        attacker,
        socket(atlases[attacker], scene.poses[attacker].frame, 'contact'),
      );
      const target = worldPoint(
        atlases[defender],
        scene.poses[defender],
        defender,
        socket(atlases[defender], scene.poses[defender].frame, guarded ? 'contact' : 'hurt'),
      );
      assert.ok(
        Math.hypot(fist.x - target.x, fist.y - target.y) < 0.001,
        JSON.stringify({ fist, target }),
      );
      assert.ok(
        Math.hypot(fist.x - scene.impacts[0].point.x, fist.y - scene.impacts[0].point.y) < 0.001,
      );
      assert.ok(scene.poses.claude.y <= 548 && scene.poses.codex.y <= 548);
      const held = combatScene(atlases, sample, e, time + 75, 0);
      assert.deepEqual(held.poses, scene.poses, 'limbs and travel freeze during contact');
      assert.ok(
        scene.cues.some((c) => c.at === time && /impact|special|block|parry|finisher/.test(c.kind)),
        'sound shares the contact timestamp',
      );
    });
test('combo has three actual contacts; special and finisher complete before playback advances', () => {
  const e = event('combo', 'claude');
  const s = combatScene(atlases, sample, e, 620, 0);
  assert.equal(s.impacts.length, 3);
  assert.ok(s.impacts.at(-1)!.at + 300 < eventDuration(e));
  for (const who of ['claude', 'codex'] as const) {
    const e = event('finisher', who),
      s = combatScene(atlases, sample, e, 3500, 0);
    assert.equal(s.poses[other(who)].frame, 15);
    assert.equal(s.poses[who].frame, 13);
    assert.ok(eventDuration(e) > 3500);
  }
});
test('reduced motion removes flight, zoom, shake impacts and animated charge without losing ending poses', () => {
  const s = combatScene(atlases, sample, event('finisher', 'codex'), 1600, 1000, true);
  assert.equal(s.zoom, 1);
  assert.equal(s.charge, 0);
  assert.equal(s.impacts.length, 0);
  assert.equal(s.poses.codex.y, 548);
  assert.equal(s.poses.claude.y, 548);
  assert.equal(s.poses.claude.rotation, 0);
  assert.equal(s.poses.claude.frame, 15);
  assert.equal(s.poses.codex.frame, 13);
});
test('each winner gets one evidence-linked finisher without changing measured health, scores, findings or usage', () => {
  for (const who of ['claude', 'codex'] as const) {
    const m = demoMatch(),
      ending = m.events.at(-1)!;
    ending.scores = { [who]: 20, [other(who)]: 10 } as any;
    const before = JSON.stringify({ battle: m.battle, findings: m.findings, usage: m.usage }),
      count = m.events.filter((e) => e.type === 'finisher').length;
    syncFinisher(m);
    const f = m.events.at(-2)!;
    assert.equal(count, 1);
    assert.equal(f.type, 'finisher');
    assert.equal(f.agent, who);
    assert.equal(f.finisher!.move, who === 'claude' ? 'CONTEXT COLLAPSE' : 'FORCE PUSH: ORBITAL');
    assert.deepEqual(f.delta, { claude: 0, codex: 0 });
    assert.deepEqual(f.health, ending.health);
    assert.ok(f.sourceIds.length);
    CombatEvent.parse(f);
    assert.equal(
      JSON.stringify({ battle: m.battle, findings: m.findings, usage: m.usage }),
      before,
    );
    assert.equal(syncFinisher(m), false);
    assert.equal(m.events.filter((e) => e.type === 'finisher').length, 1);
  }
});
test('exact ties remain draws and old replays upgrade deterministically', () => {
  const m = demoMatch();
  m.events = m.events.filter((e) => e.type !== 'finisher');
  m.events.forEach((e, i) => (e.seq = i + 1));
  assert.ok(syncFinisher(m));
  assert.equal(syncFinisher(m), false);
  const tie = newMatch('tie', 'Clean review');
  finish(tie, 10);
  assert.deepEqual(
    tie.events.map((e) => e.type),
    ['finish'],
  );
  assert.equal(boutWinner(tie.events[0], null).winner, 'draw');
  m.events.at(-1)!.scores = { claude: 8, codex: 8 };
  assert.ok(syncFinisher(m));
  assert.ok(!m.events.some((e) => e.type === 'finisher'));
});
test('late fatigue stays ahead of the single finisher and the final standings', () => {
  const m = demoMatch(),
    r = { ...m.usage[0], id: 'late', turnSeq: 2, turnId: 'late' };
  m.usage.push(r);
  applyFatigue(m, r.id, Date.now());
  assert.deepEqual(
    m.events.slice(-3).map((e) => e.type),
    ['fatigue', 'finisher', 'finish'],
  );
  assert.equal(m.events.filter((e) => e.type === 'finisher').length, 1);
  assert.deepEqual(m.events.at(-2)!.health, m.events.at(-1)!.health);
  assert.equal(new Set(m.events.map((e) => e.id)).size, m.events.length);
});
test('finisher protocol rejects synthetic damage or a winner without evidence', () => {
  const valid = demoMatch().events.find((e) => e.type === 'finisher')!;
  assert.throws(() => CombatEvent.parse({ ...valid, delta: { claude: 0, codex: -60 } }));
  assert.throws(() => CombatEvent.parse({ ...valid, sourceIds: [], usageIds: [] }));
  assert.throws(() => CombatEvent.parse({ ...valid, agent: null }));
});
