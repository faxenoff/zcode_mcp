import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionLedger,
  descendants,
  findOrphanAppServers,
  parseEtime,
  parsePsOutput,
  parseWindowsProcessJson,
  planReap,
  sessionMarker,
  sumMemory,
} from "../dist/processes.js";

const T = 1_791_900_000_000; // fixed epoch ms
const A = "sess_aaaaaaaa-1111-4111-8111-111111111111";
const B = "sess_bbbbbbbb-2222-4222-8222-222222222222";

// Shape of PS_WINDOWS output (Get-CimInstance Win32_Process → ConvertTo-Json), as seen on ZCode 3.14.5.
const WIN_JSON = JSON.stringify([
  { p: 100, pp: 1, n: "node.exe", c: "node D:\\github\\zcode_mcp\\dist\\index.js", m: 50e6, t: T - 600_000 },
  {
    p: 200, pp: 100, n: "node.exe",
    c: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\u\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs app-server',
    m: 900e6, t: T - 590_000,
  },
  {
    p: 300, pp: 200, n: "bash.exe",
    c: `"C:\\Program Files\\Git\\bin\\bash.exe" -c -l ". /c/Users/u/.zcode/cli/exec/bash-startup/${A}/embedded-search-startup-461ea188f10e7cc3.sh\ncd D:/w && make"`,
    m: 7e6, t: T - 100_000,
  },
  { p: 301, pp: 300, n: "bash.exe", c: "bash.exe -c make", m: 9e6, t: T - 99_000 },
  {
    p: 400, pp: 200, n: "node.exe",
    c: '"C:\\Program Files\\nodejs\\node.exe" ...\\zcode.cjs __zcode-plugin-host C:\\Users\\u\\.zcode\\cli\\plugins\\cache\\node-repl-host\\0.6.0\\dist\\mcp\\server.js',
    m: 120e6, t: T - 100_500,
  },
  { p: 401, pp: 400, n: "conhost.exe", c: "\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4", m: 8e6, t: T - 100_400 },
  { p: 500, pp: 200, n: "code-daemon-mcp.exe", c: "D:\\github\\code-daemon\\dist\\code-daemon-mcp.exe --stdio", m: 30e6, t: T - 100_200 },
  { p: 4, pp: 0, n: "System", c: null, m: 0, t: null },
]);

test("parseWindowsProcessJson: rows, nulls and a single bare object", () => {
  const all = parseWindowsProcessJson(WIN_JSON);
  assert.equal(all.length, 8);
  const sys = all.find((p) => p.pid === 4);
  assert.equal(sys.cmd, "");
  assert.equal(sys.createdMs, null);
  assert.equal(all.find((p) => p.pid === 500).createdMs, T - 100_200);
  const one = parseWindowsProcessJson(JSON.stringify({ p: 7, pp: 1, n: "x.exe", c: "x", m: 1, t: T }));
  assert.deepEqual(one.map((p) => p.pid), [7]);
  assert.deepEqual(parseWindowsProcessJson("  "), []);
});

test("parseEtime / parsePsOutput (Linux procps and macOS formats)", () => {
  assert.equal(parseEtime("05"), NaN);
  assert.equal(parseEtime("01:05"), 65);
  assert.equal(parseEtime("02:01:05"), 7265);
  assert.equal(parseEtime("3-02:01:05"), 3 * 86400 + 7265);
  const out = [
    "    1     0  1200 10-00:00:00 /sbin/init",
    "  200   100 900000    09:50 /usr/bin/node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs app-server",
    "  300   200  7000    01:40 /bin/bash -c -l . /Users/u/.zcode/cli/exec/bash-startup/" + A + "/s.sh",
    "garbage line",
  ].join("\n");
  const ps = parsePsOutput(out, T);
  assert.equal(ps.length, 3);
  const bash = ps.find((p) => p.pid === 300);
  assert.equal(bash.ppid, 200);
  assert.equal(bash.name, "bash");
  assert.equal(bash.createdMs, T - 100_000);
  assert.equal(bash.memBytes, 7000 * 1024);
  assert.equal(sessionMarker(bash.cmd), A);
});

test("descendants: whole subtree, ignores pid-reuse impostors", () => {
  const all = parseWindowsProcessJson(WIN_JSON);
  assert.deepEqual(descendants(all, 200).map((p) => p.pid).sort(), [300, 301, 400, 401, 500]);
  // a "child" created long before its parent is a reused ppid, not a child
  all.push({ pid: 900, ppid: 200, name: "old.exe", cmd: "", createdMs: T - 9_000_000, memBytes: 1 });
  assert.ok(!descendants(all, 200).some((p) => p.pid === 900));
  assert.equal(sumMemory(descendants(all, 400)), 8e6);
});

test("sessionMarker: only the bash-startup path counts, not ids mentioned in a command", () => {
  assert.equal(sessionMarker(`. /c/x/.zcode/cli/exec/bash-startup/${A}/a.sh`), A);
  assert.equal(sessionMarker(`C:\\Users\\u\\.zcode\\cli\\exec\\bash-startup\\${B}\\a.sh`), B);
  assert.equal(sessionMarker(`echo ${A}`), null);
});

function ledgerWith(spans) {
  const l = new SessionLedger();
  for (const [id, start, end] of spans) {
    l.open(id, start);
    if (end !== null) l.close(id, end);
  }
  return l;
}

const kills = (plan) => plan.filter((d) => d.kill).map((d) => d.proc.pid).sort();

test("planReap: everything of a closed session goes, conhost of the app-server stays", () => {
  const all = parseWindowsProcessJson(WIN_JSON);
  all.push({ pid: 600, ppid: 200, name: "conhost.exe", cmd: "conhost.exe 0x4", createdMs: T - 590_000, memBytes: 1 });
  const ledger = ledgerWith([[A, T - 101_000, T - 50_000]]);
  assert.deepEqual(kills(planReap(all, 200, ledger, { now: T })), [300, 400, 500]);
});

test("planReap: nothing of a still-open session is touched", () => {
  const all = parseWindowsProcessJson(WIN_JSON);
  const ledger = ledgerWith([[A, T - 101_000, null]]);
  assert.deepEqual(kills(planReap(all, 200, ledger, { now: T })), []);
});

test("planReap: concurrent sessions — shared creation window keeps the child until both are closed", () => {
  const all = parseWindowsProcessJson(WIN_JSON);
  // B opened while A was open; plugin host (400) and code-daemon (500) were created in both windows.
  let ledger = ledgerWith([[A, T - 101_000, T - 50_000], [B, T - 100_800, null]]);
  let plan = planReap(all, 200, ledger, { now: T });
  // the shell names A explicitly, so it goes even though B is open
  assert.deepEqual(kills(plan), [300]);
  assert.match(plan.find((d) => d.proc.pid === 400).reason, /owner still open: sess_bbbb/);
  ledger = ledgerWith([[A, T - 101_000, T - 50_000], [B, T - 100_800, T - 10_000]]);
  assert.deepEqual(kills(planReap(all, 200, ledger, { now: T })), [300, 400, 500]);
});

test("planReap: a shell of an unknown (sub-agent) session falls back to its creation window", () => {
  const all = parseWindowsProcessJson(WIN_JSON);
  const child = "sess_cccccccc-3333-4333-8333-333333333333";
  all.push({
    pid: 700, ppid: 200, name: "bash.exe",
    cmd: `bash -c ". /c/u/.zcode/cli/exec/bash-startup/${child}/s.sh"`, createdMs: T - 20_000, memBytes: 1,
  });
  const ledger = ledgerWith([[A, T - 101_000, null]]);
  const d = planReap(all, 200, ledger, { now: T }).find((x) => x.proc.pid === 700);
  assert.deepEqual(d.owners, [A]);
  assert.equal(d.kill, false);
});

test("planReap: unattributed children go only when no session is open, and not while young", () => {
  const all = [
    { pid: 200, ppid: 100, name: "node.exe", cmd: "zcode.cjs app-server", createdMs: T - 600_000, memBytes: 1 },
    { pid: 800, ppid: 200, name: "code-daemon-mcp.exe", cmd: "x --stdio", createdMs: T - 300_000, memBytes: 1 },
    { pid: 801, ppid: 200, name: "code-daemon-mcp.exe", cmd: "x --stdio", createdMs: T - 2_000, memBytes: 1 },
  ];
  assert.deepEqual(kills(planReap(all, 200, new SessionLedger(), { now: T })), [800]);
  const open = ledgerWith([[A, T - 1_000, null]]);
  assert.deepEqual(kills(planReap(all, 200, open, { now: T })), []);
});

test("SessionLedger: windows, residency, activity and pruning", () => {
  const l = new SessionLedger(1_000);
  l.open(A, 100);
  l.open(A, 150); // re-open while open is a no-op
  assert.ok(l.isResident(A));
  assert.equal(l.lastActivity(A), 150);
  l.close(A, 200);
  assert.ok(!l.isResident(A));
  assert.equal(l.lastActivity(A), undefined);
  l.touch(A, 300); // touching a closed session does not resurrect it
  assert.ok(!l.isResident(A));
  l.open(A, 400);
  assert.deepEqual(l.ownersAt(300, 0), []);
  assert.deepEqual(l.ownersAt(300, 150), [A]);
  assert.deepEqual(l.ownersAt(10_000, 0), [A]); // open window has no end
  l.close(A, 500);
  l.prune(2_000);
  assert.ok(!l.knows(A));
});

test("findOrphanAppServers: parent gone or pid reused; live parents are left alone", () => {
  const all = [
    { pid: 10, ppid: 5, name: "ZCode.exe", cmd: "ZCode.exe", createdMs: T - 1e6, memBytes: 1 },
    { pid: 11, ppid: 10, name: "node.exe", cmd: "node zcode.cjs app-server", createdMs: T - 9e5, memBytes: 1 },
    { pid: 21, ppid: 20, name: "node.exe", cmd: '"node" C:\\ZCode\\glm\\zcode.cjs app-server', createdMs: T - 9e5, memBytes: 1 },
    { pid: 31, ppid: 30, name: "node.exe", cmd: "node zcode.cjs app-server", createdMs: T - 9e5, memBytes: 1 },
    { pid: 30, ppid: 1, name: "chrome.exe", cmd: "chrome", createdMs: T - 1e3, memBytes: 1 },
    { pid: 41, ppid: 1, name: "node", cmd: "node /x/zcode-entry.cjs app-server", createdMs: T - 9e5, memBytes: 1 },
    { pid: 51, ppid: 50, name: "node.exe", cmd: "node zcode.cjs __zcode-plugin-host x", createdMs: T, memBytes: 1 },
  ];
  assert.deepEqual(findOrphanAppServers(all, -1).map((p) => p.pid).sort(), [21, 31, 41]);
  assert.deepEqual(findOrphanAppServers(all, 21).map((p) => p.pid).sort(), [31, 41]);
});

test("planReap never selects the app-server itself, whatever the ledger says", () => {
  const all = parseWindowsProcessJson(WIN_JSON);
  all.push({ pid: 200, ppid: 200, name: "node.exe", cmd: "zcode.cjs app-server", createdMs: T - 590_000, memBytes: 1 });
  const plan = planReap(all, 200, new SessionLedger(), { now: T });
  assert.ok(!plan.some((d) => d.proc.pid === 200));
  assert.ok(plan.every((d) => d.proc.ppid === 200), "only direct children are candidates");
});
