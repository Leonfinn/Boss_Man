// A tiny Postgres wire-protocol server in a worker thread, for leader-freeze.test.ts (BOS-432). It runs on its own event
// loop, so it keeps answering while the test blocks the main thread: exactly what a frozen server sees from a live
// database. It answers just what the leader sends: startup, `set ...`, `select 1` and pg_try_advisory_lock.
//
// Messages from the test: { mode: "normal" | "hang" | "trap" | "kill" }.
//   hang: hold back every `select 1` reply until the mode is "normal" again.
//   trap: on the next `select 1`, set flag[0] = 1 (Atomics.notify) and answer
//   300 ms later (by then the test has frozen its thread).  kill: close every connection.
import { createServer } from "node:net";
import { parentPort, workerData } from "node:worker_threads";

const flag = new Int32Array(workerData.flag);
let mode = "normal";
const sockets = new Set();
// Replies held back in "hang" mode; sent when the mode goes back to "normal".
const held = [];

const msg = (type, body) => {
  const b = Buffer.alloc(5 + body.length);
  b.write(type, 0, "latin1");
  b.writeInt32BE(4 + body.length, 1);
  body.copy(b, 5);
  return b;
};
const int16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const cstr = (s) => Buffer.from(`${s}\0`, "utf8");
const ready = () => msg("Z", Buffer.from("I"));
const complete = (tag) => msg("C", cstr(tag));
const rowDesc = (name, oid) => msg("T", Buffer.concat([int16(1), cstr(name), int32(0), int16(0), int32(oid), int16(oid === 16 ? 1 : 4), int32(-1), int16(0)]));
const dataRow = (v) => msg("D", Buffer.concat([int16(1), int32(Buffer.byteLength(v)), Buffer.from(v)]));
const result = (sql) => {
  if (/^set /i.test(sql)) return [complete("SET")];
  if (/pg_try_advisory_lock/i.test(sql)) return [rowDesc("ok", 16), dataRow("t"), complete("SELECT 1")];
  return [rowDesc("?column?", 23), dataRow("1"), complete("SELECT 1")];
};

const server = createServer((sock) => {
  sockets.add(sock);
  sock.on("close", () => sockets.delete(sock));
  sock.on("error", () => {});
  let buf = Buffer.alloc(0);
  let started = false;
  let extSql = "";
  const answer = (sql, parts) => {
    if (sql.trim() === "select 1" && mode === "hang") return void held.push(() => sock.write(Buffer.concat(parts)));
    if (sql.trim() === "select 1" && mode === "trap") {
      mode = "normal";
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
      setTimeout(() => sock.write(Buffer.concat(parts)), 300);
      return;
    }
    sock.write(Buffer.concat(parts));
  };
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (!started) {
        if (buf.length < 8) return;
        const len = buf.readInt32BE(0);
        if (buf.length < len) return;
        buf = buf.subarray(len);
        started = true;
        sock.write(Buffer.concat([msg("R", int32(0)), msg("K", Buffer.concat([int32(1), int32(2)])), ready()]));
        continue;
      }
      if (buf.length < 5) return;
      const type = String.fromCharCode(buf[0]);
      const len = buf.readInt32BE(1);
      if (buf.length < 1 + len) return;
      const body = buf.subarray(5, 1 + len);
      buf = buf.subarray(1 + len);
      if (type === "Q") {
        const sql = body.subarray(0, body.indexOf(0)).toString();
        answer(sql, [...result(sql), ready()]);
      } else if (type === "P") {
        // Parse: statement name, then the query text.
        const nameEnd = body.indexOf(0);
        extSql = body.subarray(nameEnd + 1, body.indexOf(0, nameEnd + 1)).toString();
      } else if (type === "S") {
        // Sync ends an extended-protocol batch (Parse, Bind, Describe, Execute): answer it all at once.
        answer(extSql, [msg("1", Buffer.alloc(0)), msg("2", Buffer.alloc(0)), ...result(extSql), ready()]);
      } else if (type === "X") {
        sock.end();
        return;
      }
    }
  });
});

parentPort.on("message", (m) => {
  if (m.mode === "kill") {
    for (const s of sockets) s.destroy();
    return;
  }
  mode = m.mode;
  if (mode === "normal") for (const send of held.splice(0)) send();
});
server.listen(0, "127.0.0.1", () => parentPort.postMessage({ port: server.address().port }));
