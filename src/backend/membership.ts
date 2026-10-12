import { z } from 'zod';
import type { Event } from 'nostr-tools';
import type { Config } from './config.js';
import { buzz, buzzQuery, ownerKey, validSignedEvent } from './buzz.js';

const Pubkey = z.string().regex(/^[0-9a-f]{64}$/);
const Members = z.array(
  z.object({ pubkey: Pubkey, role: z.enum(['owner', 'admin', 'member', 'guest', 'bot']) }),
);
const Profile = z.object({ bot: z.boolean().optional() }).passthrough();

/** Fresh relay-backed authorization. No positive cache survives membership removal. */
export async function authorizeReviewRequester(config: Config, event: Event): Promise<boolean> {
  if (!validSignedEvent(event) || ![9, 40002].includes(event.kind) || !config.channelId)
    return false;
  const channels = event.tags.filter((t) => t[0] === 'h');
  if (channels.length !== 1 || channels[0][1] !== config.channelId) return false;
  if (
    Object.values(config.fighters ?? {}).includes(event.pubkey) ||
    event.tags.some((t) => t[0] === 'auth')
  )
    return false;

  const key = ownerKey();
  const members = Members.parse(
    await buzz(config, ['channels', 'members', '--channel', config.channelId], key),
  );
  const entries = members.filter((m) => m.pubkey === event.pubkey);
  if (entries.length !== 1 || entries[0].role === 'bot') return false;

  const profiles = await buzzQuery(config, { kinds: [0], authors: [event.pubkey], limit: 1 }, key);
  if (profiles.length > 1 || profiles.some((p) => p.kind !== 0 || p.pubkey !== event.pubkey))
    throw new Error('Buzz returned an ambiguous requester identity');
  // A member without optional kind-0 metadata is allowed by their channel role.
  const profile = profiles[0];
  if (!profile) return true;
  if (profile.tags.some((t) => t[0] === 'auth')) return false;
  const parsed = Profile.safeParse(JSON.parse(profile.content));
  if (!parsed.success) throw new Error('Buzz requester profile is malformed');
  return parsed.data.bot !== true;
}
