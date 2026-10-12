import { useEffect, useRef } from 'react';
import { other, type CombatEvent, type Fighter, type Match } from '../core/types.js';
import type { Atlas } from '../backend/assets.js';
import { combatScene, FLOOR, SCALE, type Pose, type Impact } from './choreography.js';

const image = (url: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = url;
  });
type FighterAsset = { manifest: Atlas; image: HTMLImageElement };
type Assets = { stage: HTMLImageElement; claude: FighterAsset; codex: FighterAsset };
type Props = {
  match: Match;
  event: CombatEvent | null;
  paused: boolean;
  reduced: boolean;
  speed: number;
  onHit: () => void;
  onCue: (kind: string) => void;
};
const direction = (a: Fighter) => (a === 'claude' ? 1 : -1);
function sprite(
  ctx: CanvasRenderingContext2D,
  asset: FighterAsset,
  who: Fighter,
  pose: Pose,
  glow = 0,
) {
  const f = asset.manifest.frames[pose.frame];
  ctx.save();
  ctx.translate(pose.x, pose.y);
  ctx.rotate(pose.rotation);
  ctx.scale(direction(who) * (asset.manifest.facing === 'left' ? -1 : 1) * pose.scale, pose.scale);
  ctx.globalAlpha = pose.alpha;
  if (glow) {
    ctx.shadowColor = '#fff0c9';
    ctx.shadowBlur = glow;
  }
  ctx.drawImage(
    asset.image,
    f.x,
    f.y,
    f.w,
    f.h,
    -f.pivotX * SCALE,
    -f.pivotY * SCALE,
    f.w * SCALE,
    f.h * SCALE,
  );
  ctx.restore();
}
function impact(
  ctx: CanvasRenderingContext2D,
  hit: Impact,
  age: number,
  seed: number,
  agent: Fighter | null,
) {
  const large = hit.kind === 'finisher',
    duration = large ? 550 : hit.kind === 'landing' ? 420 : 300;
  if (age < 0 || age > duration) return;
  const t = age / duration,
    color =
      hit.kind === 'block' || hit.kind === 'parry' || agent === 'codex' ? '#91eaff' : '#ffcb73',
    radius = (large ? 26 : 8) + Math.pow(t, 0.55) * (large ? 180 : 72);
  ctx.save();
  ctx.translate(hit.point.x, hit.point.y);
  ctx.globalAlpha = (1 - t) * 0.95;
  ctx.strokeStyle = color;
  ctx.fillStyle = '#fff9e7';
  ctx.shadowColor = color;
  ctx.shadowBlur = large ? 25 : 12;
  if (hit.kind === 'landing') {
    ctx.scale(1, 0.22);
  }
  if (hit.kind === 'block' || hit.kind === 'parry') {
    ctx.lineWidth = 6 * (1 - t) + 1;
    ctx.beginPath();
    ctx.arc(0, 0, 30 + t * 65, -Math.PI * 0.8, Math.PI * 0.8);
    ctx.stroke();
    if (hit.kind === 'parry') {
      ctx.rotate(-0.65);
      ctx.fillRect(-70 * t, -3, 140 * t, 6);
    }
  } else {
    ctx.lineWidth = (large ? 9 : 5) * (1 - t) + 1;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();
    const rays = large ? 20 : 12;
    for (let i = 0; i < rays; i++) {
      const angle = (i * Math.PI * 2) / rays + seed * 0.73,
        length = (i % 3 === 0 ? 1.6 : 1) * (large ? 68 : 29) * (1 - t);
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * radius * 0.5, Math.sin(angle) * radius * 0.5);
      ctx.lineTo(Math.cos(angle) * (radius + length), Math.sin(angle) * (radius + length));
      ctx.stroke();
    }
    if (age < 100) {
      ctx.beginPath();
      for (let i = 0; i < 16; i++) {
        const angle = (i * Math.PI) / 8,
          r = i % 2 ? 10 : large ? 66 : 30;
        const x = Math.cos(angle) * r,
          y = Math.sin(angle) * r;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}
function charge(
  ctx: CanvasRenderingContext2D,
  agent: Fighter,
  pose: Pose,
  amount: number,
  time: number,
) {
  if (amount <= 0) return;
  const sign = direction(agent),
    color = agent === 'claude' ? '#ffc16b' : '#74e4ff';
  ctx.save();
  ctx.globalAlpha = amount * 0.75;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 20;
  if (agent === 'claude') {
    ctx.translate(pose.x + sign * 50, pose.y - 150);
    for (let ring = 0; ring < 3; ring++) {
      ctx.rotate(((ring % 2 ? -1 : 1) * time) / 1700);
      ctx.lineWidth = 2 + ring;
      ctx.beginPath();
      ctx.ellipse(
        0,
        0,
        25 + amount * 60 + ring * 19,
        17 + amount * 33 + ring * 12,
        ring * 0.7,
        0,
        Math.PI * 1.6,
      );
      ctx.stroke();
    }
    for (let i = 0; i < 10; i++) {
      const angle = (i * Math.PI) / 5 + time / 350,
        rad = 40 + (1 - amount) * 100;
      ctx.fillRect(Math.cos(angle) * rad, Math.sin(angle) * rad, 4, 10);
    }
  } else {
    for (const x of [-40, 40]) {
      ctx.beginPath();
      ctx.moveTo(pose.x + x - 9, pose.y - 18);
      ctx.lineTo(pose.x + x, FLOOR + 5);
      ctx.lineTo(pose.x + x + 9, pose.y - 18 - amount * 65);
      ctx.closePath();
      ctx.fill();
    }
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(
      pose.x,
      Math.min(FLOOR, pose.y + 5),
      65 + amount * 45,
      12 + amount * 10,
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  }
  ctx.restore();
}
export function ArenaCanvas({ match, event, paused, reduced, speed, onHit, onCue }: Props) {
  const ref = useRef<HTMLCanvasElement>(null),
    props = useRef({ match, event, paused, reduced, speed, onCue });
  props.current = { match, event, paused, reduced, speed, onCue };
  useEffect(() => {
    let cancelled = false,
      raf = 0,
      assets: Assets | null = null,
      time = 0,
      previous = performance.now(),
      epoch = 0,
      lastId = '',
      cues = new Set<string>();
    Promise.all([
      image('/assets/stage.png'),
      ...(['claude', 'codex'] as const).map(async (a) => {
        const manifest: Atlas = await fetch(`/assets/${a}.json`).then((r) => r.json());
        return { manifest, image: await image(`/assets/${manifest.image}`) };
      }),
    ])
      .then(([stage, claude, codex]) => {
        if (!cancelled)
          assets = {
            stage: stage as HTMLImageElement,
            claude: claude as FighterAsset,
            codex: codex as FighterAsset,
          };
      })
      .catch(() => {});
    const draw = (now: number) => {
      if (cancelled) return;
      raf = requestAnimationFrame(draw);
      const dt = Math.min(80, Math.max(0, now - previous));
      previous = now;
      const p = props.current,
        e = p.event;
      if (!p.paused) time += dt * p.speed;
      const id = e ? `${e.id}:${e.type}:${e.agent}` : '';
      if (id !== lastId) {
        lastId = id;
        cues = new Set();
        epoch =
          time -
          (p.paused ? (e?.type === 'finisher' ? 1170 : e?.type === 'special' ? 700 : 390) : 0);
      }
      const elapsed = Math.max(0, time - epoch),
        canvas = ref.current;
      if (!canvas || !assets) return;
      const rect = canvas.getBoundingClientRect(),
        ratio = Math.min(2, devicePixelRatio || 1),
        width = Math.round(rect.width * ratio),
        height = Math.round(rect.height * ratio);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(width / 1200, 0, 0, height / 640, 0, 0);
      ctx.clearRect(0, 0, 1200, 640);
      const atlases = { claude: assets.claude.manifest, codex: assets.codex.manifest },
        scene = combatScene(atlases, p.match, e, elapsed, time, p.reduced);
      for (const cue of scene.cues) {
        const key = `${cue.at}:${cue.kind}`;
        if (elapsed >= cue.at && !cues.has(key)) {
          cues.add(key);
          if (!p.paused) p.onCue(cue.kind);
        }
      }
      const hit = scene.impacts.findLast((h) => elapsed >= h.at && elapsed < h.at + 140),
        shake =
          hit && !p.reduced
            ? Math.sin((elapsed - hit.at) * 0.15) *
              (hit.kind === 'finisher' ? 9 : 4) *
              (1 - (elapsed - hit.at) / 140)
            : 0;
      canvas.dataset.action = e?.type ?? 'idle';
      canvas.dataset.animationMs = String(Math.round(elapsed));
      canvas.dataset.impact = hit?.kind ?? '';
      if (scene.contact) {
        canvas.dataset.contactX = scene.contact.x.toFixed(1);
        canvas.dataset.contactY = scene.contact.y.toFixed(1);
      } else {
        delete canvas.dataset.contactX;
        delete canvas.dataset.contactY;
      }
      ctx.save();
      ctx.translate(600 + shake, 345);
      ctx.scale(scene.zoom, scene.zoom);
      ctx.translate(-600, -345);
      ctx.drawImage(assets.stage, 0, 0, 1200, 640);
      const shade = ctx.createLinearGradient(0, 0, 0, 640);
      shade.addColorStop(0, 'rgba(5,8,15,.3)');
      shade.addColorStop(0.65, 'rgba(5,8,15,0)');
      shade.addColorStop(1, 'rgba(5,8,15,.5)');
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, 1200, 640);
      if (scene.shade) {
        ctx.fillStyle = `rgba(3,5,15,${scene.shade})`;
        ctx.fillRect(0, 0, 1200, 640);
      }
      if (scene.finisher && !p.reduced)
        charge(ctx, scene.finisher, scene.poses[scene.finisher], scene.charge, elapsed);
      const order: Fighter[] = e?.agent ? [other(e.agent), e.agent] : ['claude', 'codex'];
      for (const who of order) {
        const pose = scene.poses[who],
          health = e?.health[who] ?? 100;
        ctx.fillStyle = `rgba(0,0,0,${0.5 * Math.max(0.3, 1 - (FLOOR - pose.y) / 450)})`;
        ctx.beginPath();
        ctx.ellipse(
          pose.x,
          FLOOR - 3,
          90 * Math.max(0.5, 1 - (FLOOR - pose.y) / 600),
          14,
          0,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        if (
          e?.type === 'finisher' &&
          who === e.agent &&
          !p.reduced &&
          elapsed > 780 &&
          elapsed < 1120
        ) {
          for (let n = 3; n > 0; n--)
            sprite(ctx, assets[who], who, {
              ...pose,
              x: pose.x - direction(who) * n * 35,
              alpha: 0.07 * (4 - n),
            });
        }
        sprite(ctx, assets[who], who, pose, hit && !p.reduced ? 18 : 0);
        if (health < 40 && !p.reduced) {
          ctx.strokeStyle = `rgba(255,73,68,${0.15 + 0.1 * Math.sin(time / 300)})`;
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.ellipse(pose.x, FLOOR, 104, 17, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      if (!p.reduced)
        for (const h of scene.impacts)
          impact(ctx, h, elapsed - h.at, e?.seq ?? 0, e?.agent ?? null);
      ctx.restore();
      if (p.match.status === 'scouting') {
        ctx.fillStyle = 'rgba(5,10,18,.65)';
        ctx.fillRect(0, 250, 1200, 110);
        ctx.font = 'bold 32px Impact, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffd891';
        ctx.fillText('SCOUTING THE OPPONENT', 600, 314);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <canvas
      ref={ref}
      className="arena-canvas"
      role="img"
      aria-label="Claude and Codex fighting in the Merge Gate arena. Combat comes from review evidence."
      onClick={onHit}
    />
  );
}
