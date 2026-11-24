'use strict';

// Main-thread half of the synchronous MySQL bridge. See mysql-sync-worker.js
// for the protocol. This class exposes a blocking `request()` that hands a
// payload to the worker and waits for the reply, giving the panel a
// synchronous MySQL API without a native (deasync) dependency.

const { Worker } = require('worker_threads');
const path = require('path');

const HEADER_BYTES = 16;
const BUFFER_BYTES = 64 * 1024 * 1024; // 64 MB is plenty for panel-sized rows
const STATE_REQUEST = 1;
const STATE_RESPONSE = 2;

class MysqlSyncConnection {
  constructor(config, options = {}) {
    this.timeoutMs = options.timeoutMs || 30000;
    this.fatal = null;

    this.sab = new SharedArrayBuffer(HEADER_BYTES + BUFFER_BYTES);
    this.header = new Int32Array(this.sab, 0, 4);
    this.data = new Uint8Array(this.sab, HEADER_BYTES);

    this.worker = new Worker(path.join(__dirname, 'mysql-sync-worker.js'), {
      workerData: { sab: this.sab, config },
    });
    this.worker.on('error', (err) => { this.fatal = this.fatal || err; });
    this.worker.on('exit', (code) => {
      if (code !== 0) {
        this.fatal = this.fatal || new Error(`MySQL worker exited with code ${code}`);
      }
    });
  }

  request(payload) {
    if (this.fatal) throw new Error(`MySQL connection failed: ${this.fatal.message}`);

    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    if (bytes.length > this.data.length) {
      throw new Error(`MySQL request of ${bytes.length} bytes exceeds the sync buffer`);
    }

    this.data.set(bytes, 0);
    Atomics.store(this.header, 1, bytes.length);
    Atomics.store(this.header, 0, STATE_REQUEST);
    Atomics.notify(this.header, 0);

    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`MySQL query timed out after ${this.timeoutMs}ms`);
      const waitResult = Atomics.wait(this.header, 0, STATE_REQUEST, remaining);
      const state = Atomics.load(this.header, 0);
      if (state === STATE_RESPONSE) break;
      if (waitResult === 'timed-out') throw new Error(`MySQL query timed out after ${this.timeoutMs}ms`);
    }

    const len = Atomics.load(this.header, 2);
    const text = Buffer.from(this.data.buffer, this.data.byteOffset, len).toString('utf8');

    // Hand control back to the worker for the next request.
    Atomics.store(this.header, 0, 0);
    Atomics.notify(this.header, 0);

    const response = JSON.parse(text);
    if (response.error) {
      const err = new Error(response.error.message);
      if (response.error.code) err.code = response.error.code;
      throw err;
    }
    return response.result;
  }
}

module.exports = MysqlSyncConnection;
