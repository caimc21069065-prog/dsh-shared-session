#!/usr/bin/env node
// dsh-shared-session — hook runner (Claude Code-compatible hook contract).
// Bridges ZCode hook events into the per-workspace room client via a
// localhost control server. Fails open (exit 0) whenever the plugin is
// inactive so normal work is never disturbed.

import fs from 'node:fs';
import path from 'node:path';
import { httpJson, loadState, stateHome } from '../lib/core.mjs';

const eventName = process.argv[2] || '';

function flushAndExit(code) {
  // process.exit can truncate pending async stdout/stderr writes (pipes)
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Locate the host room client for this session. Primary key is the workspace
// cwd; if the MCP server was spawned with a different cwd (host-dependent),
// fall back to matching the hook's transcript_path against persisted host
// state — transcript files are unique per session.
function findHostState(payload) {
  const primary = loadState(payload?.cwd || process.cwd());
  if (primary?.role === 'host' && primary.controlPort && primary.controlSecret) return primary;
  const tp = payload?.transcript_path;
  if (!tp) return null;
  const dir = path.join(stateHome(), 'rooms');
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const st = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (
        st.role === 'host' &&
        st.controlPort &&
        st.controlSecret &&
        st.transcriptPath &&
        path.resolve(st.transcriptPath) === path.resolve(tp)
      ) {
        return st;
      }
    } catch {
      /* skip unreadable state files */
    }
  }
  return null;
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      return flushAndExit(0);
    }
  }
  const state = findHostState(payload);
  if (!state) return flushAndExit(0); // plugin inactive for this workspace

  let r;
  try {
    r = await httpJson(`http://127.0.0.1:${state.controlPort}/hook/${eventName}`, {
      method: 'POST',
      body: { payload, secret: state.controlSecret },
      // stay under the 590s hook timeout so the approval gate always resolves
      timeoutMs: eventName === 'preToolUse' ? 580000 : 12000
    });
  } catch {
    // Control server unreachable = no live host client = no guest turn to
    // gate and nobody to broadcast to. Failing open here is safe (guest
    // prompts are rejected by the relay while the host client is down).
    return flushAndExit(0);
  }
  if (!r.ok) return flushAndExit(0);

  const data = r.data || {};
  if (eventName === 'preToolUse' && (data.decision === 'deny' || data.decision === 'ask')) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: data.decision,
          permissionDecisionReason:
            data.decision === 'deny'
              ? data.reason || 'Denied by shared-session policy'
              : 'Requested by a shared-session guest — host approval required'
        }
      }) + '\n',
      () => flushAndExit(0)
    );
    return;
  }
  if (eventName === 'stop' && data.inject && data.reason) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: data.reason }) + '\n', () => flushAndExit(0));
    return;
  }
  flushAndExit(0);
}

main().catch(() => flushAndExit(0));
