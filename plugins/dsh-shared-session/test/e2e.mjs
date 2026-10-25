#!/usr/bin/env node
// dsh-shared-session — end-to-end smoke test (no ZCode required).
// Boots the bundled relay, then exercises host/guest sessions, queueing,
// injection, the approval gate, streaming, reconnect, offline rejection,
// the hook bridge and the MCP server.
//
//   node test/e2e.mjs

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pluginRoot, relayApi, loadConfig, RelayStream } from '../lib/core.mjs';
import { HostSession } from '../lib/host-room.mjs';
import { GuestSession } from '../lib/guest-room.mjs';

const PLUGIN = pluginRoot();
const PORT = 8791 + Math.floor(Math.random() * 40);
const RELAY = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-e2e-'));
const tmpHome = path.join(tmpRoot, 'home');
const tmpWs = path.join(tmpRoot, 'ws');
fs.mkdirSync(tmpHome, { recursive: true });
fs.mkdirSync(tmpWs, { recursive: true });
process.env.SHARED_SESSION_HOME = tmpHome;

let relayChild = null;
const passed = [];
let n = 0;

function ok(name, cond, extra = '') {
  n++;
  if (!cond) throw new Error(`FAIL [#${n}] ${name} ${extra}`);
  passed.push(name);
}

async function waitFor(fn, ms = 9000, label = 'condition') {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(120);
  }
}

function readState(cwd) {
  return JSON.parse(fs.readFileSync(path.join(tmpHome, 'rooms', `${fsHash(cwd)}.json`), 'utf8'));
}
function fsHash(cwd) {
  return createHash('sha256').update(path.resolve(cwd).toLowerCase()).digest('hex').slice(0, 16);
}

async function main() {
  // -- 0. relay boot ---------------------------------------------------------
  relayChild = spawn(process.execPath, [path.join(PLUGIN, 'relay', 'server.mjs'), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  relayChild.stderr.on('data', () => {});
  const api = relayApi(RELAY);
  await waitFor(async () => (await api.health().catch(() => null))?.ok, 8000, 'relay health');
  ok('relay boots + health', true);

  const cfg = {
    ...loadConfig(),
    relayUrl: RELAY,
    autoStartRelay: false,
    guestWriteApproval: 'relay',
    approvalTimeoutMs: 4000,
    toolResultMaxLines: 5
  };

  // -- 1. host share ----------------------------------------------------------
  const transcript = path.join(tmpWs, 'transcript.jsonl');
  fs.writeFileSync(transcript, '');
  const host = await HostSession.share({ cwd: tmpWs, cfg, includeHistory: false, transcriptPath: transcript });
  ok('host share returns ids', Boolean(host.roomId && host.link && host.code && host.hostUrl));
  const st = readState(tmpWs);
  ok('state saved with control secret', Boolean(st.controlPort && st.controlSecret && st.roomToken));

  // -- 2. guest join ----------------------------------------------------------
  const guest = await GuestSession.join({ cwd: path.join(tmpRoot, 'guest-ws'), cfg, linkOrCode: host.link });
  ok('guest joins with member token', Boolean(guest.memberId && guest.memberToken));
  const info = await api.roomInfo(host.roomId, host.hostToken);
  ok('room info lists 2 members', info.ok && info.data.members.length === 2);
  ok('viewer link parseable', guest.viewerLink.includes('/r/'));

  // viewer page
  const viewerRes = await fetch(`${RELAY}/r/${host.roomId}/${host.inviteToken}`);
  const viewerHtml = await viewerRes.text();
  ok('viewer page served', viewerRes.ok && viewerHtml.includes('__ROOM_ID__') === false && viewerHtml.includes(host.roomId));

  // -- 3. guest prompt -> host queue -> stop injection -------------------------
  await guest.sendPrompt('把这个函数加上单元测试');
  await waitFor(() => host.queue.length === 1, 6000, 'guest message queued on host');
  const stopResult = host.handleStop();
  ok('stop injects guest message', stopResult.inject === true);
  ok('injection carries [Guest]: prefix', stopResult.reason.includes(`[${guest.displayName}]: 把这个函数加上单元测试`));
  ok('injection carries marker', stopResult.reason.includes('<!--ss-inject:'));

  // echo of injection keeps guest turn active; normal prompt clears it
  host.handleUserPromptSubmit({ prompt: stopResult.reason, transcript_path: transcript });
  ok('echo marks guest turn active', host.activeGuestTurn === true);

  // -- 4. approval gate --------------------------------------------------------
  const ro = await host.handlePreToolUse({ tool_name: 'Read', tool_input: { file_path: 'src/x.ts' } });
  ok('guest read-only tool allowed', ro.decision === 'allow');

  const p1 = host.handlePreToolUse({ tool_name: 'Bash', tool_input: { command: 'rm -rf build/' } });
  const approvalEv = await waitFor(
    () => host.log.find(e => e.type === 'control/approval' && e.payload.mode === 'relay'),
    6000,
    'approval request broadcast'
  );
  ok('approval request broadcast', Boolean(approvalEv.payload.requestId));
  ok('approval summary has full command', approvalEv.payload.summary.includes('rm -rf build/'));
  await waitFor(
    () => guest.eventsSince(0).some(e => e.type === 'control/approval' && e.payload.requestId === approvalEv.payload.requestId),
    6000,
    'guest sees approval request'
  );
  await host.postApprovalResult(approvalEv.payload.requestId, 'deny');
  const d1 = await p1;
  ok('deny -> hook decision deny', d1.decision === 'deny', JSON.stringify(d1));
  await waitFor(
    () => guest.eventsSince(0).some(e => e.type === 'tool/result' && e.payload.ok === false),
    6000,
    'guest sees denial result'
  );
  await waitFor(
    () => guest.eventsSince(0).some(e => e.type === 'control/approval-result' && e.payload.decision === 'deny'),
    6000,
    'guest sees decision'
  );

  const p2 = host.handlePreToolUse({ tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const ev2 = await waitFor(
    () => host.log.find(e => e.type === 'control/approval' && e.payload.mode === 'relay' && e.payload.summary.includes('npm test')),
    6000,
    'second approval request'
  );
  await host.postApprovalResult(ev2.payload.requestId, 'allow-always');
  ok('allow-always -> allow', (await p2).decision === 'allow', JSON.stringify(await Promise.resolve(p2).catch(() => 'resolved')));
  const before = host.log.filter(e => e.type === 'control/approval').length;
  const p3 = host.handlePreToolUse({ tool_name: 'Bash', tool_input: { command: 'npm run lint' } });
  ok('always-allowed skips approval', (await p3).decision === 'allow' && host.log.filter(e => e.type === 'control/approval').length === before);

  // timeout -> deny
  host.alwaysAllowed.clear();
  const p4 = host.handlePreToolUse({ tool_name: 'Write', tool_input: { file_path: 'x', content: 'y' } });
  const d4 = await p4;
  ok('approval timeout -> deny', d4.decision === 'deny', JSON.stringify(d4));

  // ask mode
  host.cfg.guestWriteApproval = 'ask';
  const d5 = await host.handlePreToolUse({ tool_name: 'Write', tool_input: { file_path: 'x', content: 'y' } });
  ok('ask mode -> native ask', d5.decision === 'ask');
  host.cfg.guestWriteApproval = 'relay';

  // -- 5. host turns ------------------------------------------------------------
  host.handleStop(); // queue empty -> turn ends
  ok('turn ends, guest flag cleared', host.activeGuestTurn === false);
  host.handleUserPromptSubmit({ prompt: 'host own prompt' });
  await waitFor(() => guest.eventsSince(0).some(e => e.type === 'chat/user' && e.payload.text === 'host own prompt'), 6000, 'host chat/user');
  ok('host own prompt broadcast', true);
  const dHost = await host.handlePreToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  ok('host own turn needs no approval', dHost.decision === 'allow');

  host.handlePostToolUse({ tool_name: 'Bash', tool_response: 'file1\nfile2\nfile3\nfile4\nfile5\nfile6\nfile7' });
  const tr = await waitFor(() => guest.eventsSince(0).filter(e => e.type === 'tool/result' && e.payload.ok).slice(-1)[0], 6000, 'tool result');
  ok('tool result truncated to config lines', tr.payload.preview.split('\n').length === 6, tr.payload.preview);

  // -- 6. transcript tail streaming ----------------------------------------------
  const line1 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm deeply' }] } });
  const line2 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello from host model' }] } });
  fs.appendFileSync(transcript, line1 + '\n');
  fs.appendFileSync(transcript, line2 + '\n');
  await waitFor(() => guest.eventsSince(0).some(e => e.type === 'assistant/delta' && e.payload.text === 'Hello from host model'), 9000, 'assistant text tail');
  ok('transcript tail streams text', true);
  ok('transcript tail streams thinking', guest.eventsSince(0).some(e => e.type === 'assistant/delta' && e.payload.reasoning === 'hmm deeply'));

  // -- 7. reconnect gap fill --------------------------------------------------------
  const lastSeqBefore = guest.lastSeq();
  guest.stream.stop();
  host.post('chat/side', { text: 'while guest away 1' });
  host.post('chat/side', { text: 'while guest away 2' });
  const gapStream = new RelayStream({
    relayUrl: RELAY,
    roomId: host.roomId,
    token: guest.memberToken,
    since: lastSeqBefore,
    onEvent: ev => guest._onRoomEvent(ev)
  });
  gapStream.start();
  guest.stream = gapStream;
  await waitFor(() => guest.eventsSince(lastSeqBefore).filter(e => e.type === 'chat/side').length >= 2, 8000, 'gap fill');
  ok('reconnect fills gap by seq', true);

  // -- 8. offline rejection (FR-7.3) -------------------------------------------------
  const hostStream = host.stream;
  hostStream.stop();
  host.stream = new RelayStream({
    relayUrl: RELAY,
    roomId: host.roomId,
    token: host.hostToken,
    since: host.stream.lastSeq,
    onEvent: ev => host._onRoomEvent(ev)
  });
  await sleep(600); // let relay notice the disconnect
  let offlineErr = null;
  try {
    await guest.sendPrompt('anyone there?');
  } catch (e) {
    offlineErr = e;
  }
  ok('guest prompt rejected while host offline', offlineErr && /offline/i.test(offlineErr.message), offlineErr?.message);
  host.stream.start();

  // -- 9. side chat --------------------------------------------------------------------
  await guest.sendSideChat('psst, nice work');
  await waitFor(() => host.sideLog.some(e => e.payload.text === 'psst, nice work'), 6000, 'side chat');
  ok('side chat reaches host human log', true);

  // -- 10. hook bridge -----------------------------------------------------------------
  await guest.sendPrompt('hook injection test');
  await waitFor(() => host.queue.length >= 1, 6000, 'queue for hook test');
  const hookOut = await runProcess(process.execPath, [path.join(PLUGIN, 'hooks', 'hook.mjs'), 'stop'], {
    cwd: tmpWs,
    input: JSON.stringify({ cwd: tmpWs, session_id: 't', hook_event_name: 'Stop' })
  });
  const hookJson = JSON.parse(hookOut.stdout.trim());
  ok('hook stop returns block JSON', hookJson.decision === 'block' && hookJson.reason.includes('hook injection test'));
  host.handleStop();

  const hookAllow = await runProcess(process.execPath, [path.join(PLUGIN, 'hooks', 'hook.mjs'), 'preToolUse'], {
    cwd: tmpWs,
    input: JSON.stringify({ cwd: tmpWs, tool_name: 'Bash', tool_input: { command: 'echo hi' }, hook_event_name: 'PreToolUse' })
  });
  ok('hook preToolUse host-turn silent allow', hookAllow.stdout.trim() === '');

  // -- 10b. rate limits: hosts exempt (burst), guests throttled (§11) -------------------
  for (let i = 0; i < 70; i++) host.post('assistant/delta', { text: `burst ${i}` });
  await waitFor(
    () =>
      guest.eventsSince(0).filter(e => e.type === 'assistant/delta' && /^burst /.test(e.payload?.text || '')).length >=
      70,
    12000,
    'host burst not throttled'
  );
  ok('host broadcast burst not rate-limited', true);
  let guestLimited = false;
  for (let i = 0; i < 70; i++) {
    const r = await guest.api.postEvent(guest.roomId, {
      token: guest.memberToken,
      type: 'chat/side',
      payload: { text: `spam ${i}` }
    });
    if (r.status === 429) {
      guestLimited = true;
      break;
    }
  }
  ok('guest chat rate-limited', guestLimited);

  // -- 11. history backfill ---------------------------------------------------------------
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'earlier user question' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'earlier assistant answer' }] } }),
      ''
    ].join('\n')
  );
  const host2 = await HostSession.share({ cwd: path.join(tmpRoot, 'ws2'), cfg, includeHistory: true, transcriptPath: transcript });
  const guest2 = await GuestSession.join({ cwd: path.join(tmpRoot, 'g2'), cfg, linkOrCode: host2.link });
  await waitFor(
    () =>
      guest2.eventsSince(0).some(e => e.type === 'chat/user' && e.payload.text === 'earlier user question') &&
      guest2.eventsSince(0).some(e => e.type === 'assistant/delta' && e.payload.text === 'earlier assistant answer'),
    8000,
    'history backfill'
  );
  ok('history backfill shares past turns', true);
  const hist = guest2.eventsSince(0);
  const seqU = hist.find(e => e.type === 'chat/user' && e.payload.text === 'earlier user question')?.seq;
  const seqA = hist.find(e => e.type === 'assistant/delta' && e.payload.text === 'earlier assistant answer')?.seq;
  ok('serialized posts keep event order', seqU != null && seqA != null && seqU < seqA, `${seqU} vs ${seqA}`);

  // -- 12. close room ------------------------------------------------------------------------
  await host2.stopSharing();
  await waitFor(() => guest2.eventsSince(0).some(e => e.type === 'room/closed'), 6000, 'room/closed event');
  ok('stop-share closes room for guests', true);
  let closedErr = null;
  try {
    await GuestSession.join({ cwd: path.join(tmpRoot, 'g3'), cfg, linkOrCode: host2.link });
  } catch (e) {
    closedErr = e;
  }
  ok('join after close rejected', closedErr && /closed/i.test(closedErr.message), closedErr?.message);
  await waitFor(() => guest2.stream.closed === true, 6000, 'guest stream stops after close');
  ok('guest stream stops on room close (no reconnect loop)', true);
  const badViewer = await fetch(`${RELAY}/r/${host2.roomId}/not-a-real-token`);
  ok('viewer page rejects bad invite token', badViewer.status === 404);

  // -- 13. MCP server smoke ------------------------------------------------------------------
  const mcp = await mcpSmoke();
  ok('MCP initialize + tools/list', mcp.toolNames.includes('ss_share') && mcp.toolNames.includes('ss_approve'));
  ok('MCP ss_share creates/resumes room', /Invite link/.test(mcp.shareText), mcp.shareText.slice(0, 400));
  ok('MCP ss_room reports members', /members/i.test(mcp.roomText), mcp.roomText.slice(0, 400));

  console.log(`\n${passed.length}/${n} checks passed:`);
  for (const p of passed) console.log(`  ✓ ${p}`);
  console.log(`\nArtifacts in ${tmpRoot}`);
}

async function runProcess(cmd, args, { cwd, input, env }) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', d => (stdout += d));
    c.stderr.on('data', d => (stderr += d));
    c.on('error', reject);
    c.on('close', code => resolve({ code, stdout, stderr }));
    c.stdin.end(input ?? '');
  });
}

async function mcpSmoke() {
  const res = await runProcess(process.execPath, [path.join(PLUGIN, 'mcp', 'server.mjs')], {
    cwd: tmpWs,
    env: { SHARED_SESSION_RELAY_URL: RELAY, SHARED_SESSION_AUTO_START_RELAY: '0' },
    input:
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) +
      '\n' +
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
      '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) +
      '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ss_share', arguments: {} } }) +
      '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ss_room', arguments: {} } }) +
      '\n'
  });
  if (res.code !== 0 && !res.stdout) throw new Error(`MCP server exited ${res.code}: ${res.stderr}`);
  const msgs = res.stdout
    .trim()
    .split('\n')
    .map(l => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const byId = Object.fromEntries(msgs.filter(m => m.id != null).map(m => [m.id, m]));
  const toolNames = (byId[2]?.result?.tools || []).map(t => t.name);
  const txt = r => r?.result?.content?.[0]?.text || JSON.stringify(r?.error || r);
  const shareText = txt(byId[3]);
  const roomText = txt(byId[4]);
  return { toolNames, shareText, roomText };
}

main()
  .then(() => {
    relayChild?.kill();
    console.log('\nE2E SMOKE TEST: ALL PASS');
    process.exit(0);
  })
  .catch(err => {
    relayChild?.kill();
    console.error(`\nE2E SMOKE TEST FAILED after ${passed.length} passing checks:\n${err.stack || err}`);
    process.exit(1);
  });
