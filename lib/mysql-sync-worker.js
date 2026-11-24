'use strict';

// Worker-thread half of the synchronous MySQL bridge.
//
// The panel's database layer is synchronous (it was built on top of sql.js,
// which runs entirely in-process). MySQL drivers are async, so instead of
// rewriting every call site we run mysql2 here, in a worker thread, and
// shuttle requests/responses through a SharedArrayBuffer. The main thread
// blocks on Atomics.wait until this worker posts the result, which preserves
// the existing synchronous `db.prepare(...).get/all/run` API.
//
// The shared buffer layout:
//   bytes 0..15   Int32 header: [state, requestLength, responseLength, reserved]
//   bytes 16..    UTF-8 payload (request or response JSON)

const { workerData } = require('worker_threads');
const mysql = require('mysql2');

const { sab, config } = workerData;
const header = new Int32Array(sab, 0, 4);
const data = new Uint8Array(sab, 16);

const STATE_IDLE = 0;
const STATE_REQUEST = 1;
const STATE_RESPONSE = 2;
const WAIT_SLICE_MS = 1000;

let conn = null;
let fatal = null;

function writeResponse(payload) {
  let bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  if (bytes.length > data.length) {
    bytes = Buffer.from(JSON.stringify({
      error: { message: `Response of ${bytes.length} bytes exceeds the sync buffer` },
    }), 'utf8');
  }
  data.set(bytes, 0);
  Atomics.store(header, 2, bytes.length);
  Atomics.store(header, 0, STATE_RESPONSE);
  Atomics.notify(header, 0);
}

function runRequest(req, cb) {
  const method = req.method;
  if (method === 'exec') {
    conn.query(req.sql, (err) => cb(err, null));
    return;
  }
  conn.query(req.sql, req.params || [], (err, result) => {
    if (err) return cb(err);
    if (method === 'all' || method === 'get') return cb(null, result);
    // `run`: return the affected row count and the auto-increment id.
    if (Array.isArray(result)) return cb(null, { affectedRows: 0, insertId: 0 });
    cb(null, { affectedRows: result.affectedRows, insertId: result.insertId });
  });
}

function loop() {
  // Block (with a timeout so mysql2's own timers/IO keep running) until the
  // main thread leaves a request in the buffer.
  for (;;) {
    const state = Atomics.load(header, 0);
    if (state === STATE_REQUEST) break;
    const result = Atomics.wait(header, 0, state, WAIT_SLICE_MS);
    if (result === 'timed-out') {
      // Give the event loop a turn, then resume polling.
      setTimeout(loop, 0);
      return;
    }
  }

  const len = Atomics.load(header, 1);
  const raw = Buffer.from(data.buffer, data.byteOffset, len).toString('utf8');

  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    writeResponse({ error: { message: `Malformed request: ${e.message}` } });
    setImmediate(loop);
    return;
  }

  if (fatal) {
    writeResponse({ error: { message: `MySQL unavailable: ${fatal.message}`, code: fatal.code } });
    setImmediate(loop);
    return;
  }

  runRequest(req, (err, result) => {
    if (err) writeResponse({ error: { message: err.message, code: err.code, errno: err.errno } });
    else writeResponse({ result });
    // Wait for the main thread to reset the state before handling the next one.
    setImmediate(loop);
  });
}

function connect() {
  conn = mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    charset: config.charset || 'utf8mb4',
    connectTimeout: config.connectTimeout || 10000,
    multipleStatements: true,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });

  conn.on('error', (err) => {
    if (!fatal) fatal = err;
  });

  conn.connect((err) => {
    if (err) {
      fatal = err;
    }
    loop();
  });
}

connect();
