import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { safePath } from './repository.js';
const Socket = z.object({ x: z.number().finite(), y: z.number().finite() });
export const Atlas = z.object({
  version: z.literal(1),
  name: z.string(),
  image: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  facing: z.enum(['left', 'right']),
  license: z.string(),
  frames: z.array(
    z.object({
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
      w: z.number().int().positive(),
      h: z.number().int().positive(),
      pivotX: z.number(),
      pivotY: z.number(),
      contact: Socket.optional(),
      hurt: Socket.optional(),
    }),
  ),
  animations: z.record(
    z.string(),
    z.object({
      frames: z.array(z.number().int().nonnegative()).min(1),
      durations: z.array(z.number().positive()).min(1),
      loop: z.boolean(),
    }),
  ),
});
export type Atlas = z.infer<typeof Atlas>;
export async function validateAssets(directory: string) {
  const results = [];
  for (const agent of ['claude', 'codex']) {
    const atlas = Atlas.parse(JSON.parse(await readFile(join(directory, `${agent}.json`), 'utf8')));
    const png = await readFile(safePath(directory, atlas.image));
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
      throw new Error(`${agent}: PNG required`);
    const w = png.readUInt32BE(16),
      h = png.readUInt32BE(20);
    if (w !== atlas.width || h !== atlas.height)
      throw new Error(`${agent}: image dimensions differ from manifest`);
    if (![4, 6].includes(png[25])) throw new Error(`${agent}: PNG must contain alpha`);
    for (const f of atlas.frames)
      if (
        f.x + f.w > w ||
        f.y + f.h > h ||
        f.pivotX < 0 ||
        f.pivotX > f.w ||
        f.pivotY < 0 ||
        f.pivotY > f.h
      )
        throw new Error(`${agent}: frame bounds/pivot invalid`);
    for (const f of atlas.frames)
      for (const point of [f.contact, f.hurt])
        if (point && (point.x < 0 || point.x > f.w || point.y < 0 || point.y > f.h))
          throw new Error(`${agent}: contact/hurt socket outside its frame`);
    for (const name of [
      'idle',
      'fatigue',
      'attack',
      'hit',
      'block',
      'parry',
      'recoil',
      'special',
      'victory',
      'defeat',
    ]) {
      const a = atlas.animations[name];
      if (
        !a ||
        a.frames.length !== a.durations.length ||
        a.frames.some((n) => n >= atlas.frames.length)
      )
        throw new Error(`${agent}: invalid ${name} animation`);
    }
    results.push({
      fighter: agent,
      frames: atlas.frames.length,
      animations: Object.keys(atlas.animations),
      dimensions: [w, h],
      valid: true,
    });
  }
  return results;
}
