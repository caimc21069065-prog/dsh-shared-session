#!/usr/bin/env node
// dsh-shared-session — live terminal watcher (headless-friendly; NFR-4).
// Pretty-prints the room stream. Useful to tail a session from another
// terminal or to verify a relay without starting ZCode.
//
//   node scripts/watch.mjs <invite-link-or-code> [--since N]
//   node scripts/watch.mjs --room <roomId> --token <memberToken> --relay <url> [--since N]

import { RelayStream, parseJoinTarget, loadConfig } from '../lib/core.mjs';
import { formatEvent } from '../lib/render.mjs';

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

async function main() {
  const cfg = loadConfig();
  let relayUrl = argValue('--relay');
  let roomId = argValue('--room');
  let token = argValue('--token');
  const since = Number(argValue('--since') || 0) || 0;

  if (!roomId || !token) {
    const target = parseJoinTarget(args.find(a => !a.startsWith('--')) || '');
    if (!target) {
      console.error('Usage: node watch.mjs <invite-link-or-code> [--since N]');
      process.exit(1);
    }
    relayUrl = target.relayUrl || cfg.relayUrl;
    roomId = target.roomId;
    token = target.inviteToken; // read-only viewer access
  }

  console.error(`[watch] room ${roomId} @ ${relayUrl} (Ctrl+C to stop)`);
  const stream = new RelayStream({
    relayUrl,
    roomId,
    token,
    since,
    onEvent: ev => {
      const line = formatEvent(ev, { maxLines: 12 });
      if (line) console.log(`#${ev.seq} ${line}`);
    },
    onStatus: s => {
      if (s !== 'connected') console.error(`[watch] ${s}…`);
    }
  });
  await stream.start();
}

main().catch(err => {
  console.error(`[watch] ${err.message}`);
  process.exit(1);
});
