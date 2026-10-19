import { prepareCommand } from './prepare-command.js';
import { DEFAULT_TIMEOUT_MS, normalizeMaxOutput, normalizeTimeout, normalizeWorkdir } from './utils.js';

let runnerPromise = null;
let parserPromise = null;

function loadShellRunner() {
  if (!runnerPromise) runnerPromise = import('./runner.js').then((mod) => mod.ShellRunner);
  return runnerPromise;
}

function loadHarnessParser() {
  if (!parserPromise) parserPromise = import('./parser.js');
  return parserPromise;
}

export class RopilotHarness {
  constructor(app) {
    this.app = app;
    this.pendingFS = new Map();
  }

  warmParser() {
    Promise.all([loadShellRunner(), loadHarnessParser()]).catch(() => {});
  }

  loadParser() {
    return loadHarnessParser();
  }

  handleMessage(msg) {
    if (!msg || msg.type !== 'ropilot_harness_request') return false;
    this.executeRequest(msg).catch((error) => {
      this.sendResponse({
        request_id: msg.request_id,
        stdout: '',
        stderr: String(error?.message || error || 'Harness request failed'),
        exit_code: 1,
        error: String(error?.message || error || 'Harness request failed'),
      });
    });
    return true;
  }

  handleFSResponse(msg) {
    if (!msg || msg.type !== 'ropilot_harness_fs_response') return false;
    const pending = this.pendingFS.get(msg.fs_request_id);
    if (!pending) return true;
    this.pendingFS.delete(msg.fs_request_id);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(msg);
    return true;
  }

  async executeRequest(msg) {
    const start = Date.now();
    const ShellRunner = await loadShellRunner();
    const runner = new ShellRunner(this, {
      requestId: msg.request_id,
      workdir: normalizeWorkdir(msg.workdir),
      timeoutMs: normalizeTimeout(msg.timeout_ms),
      maxOutputBytes: normalizeMaxOutput(msg.max_output_bytes),
    });
    const command = String(msg.command || '');

    let output;
    try {
      output = await runner.run(command);
    } catch (error) {
      const message = String(error?.message || error || 'Harness execution failed');
      output = {
        stdout: '',
        stderr: `${message}\n`,
        exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : 1,
        error: message,
        timedOut: error?.timedOut === true,
      };
    }

    const response = {
      request_id: msg.request_id,
      stdout: output.stdout || '',
      stderr: output.stderr || '',
      exit_code: Number.isInteger(output.exitCode) ? output.exitCode : 0,
      duration_ms: Date.now() - start,
      error: output.error || '',
      timed_out: output.timedOut === true,
      truncated: output.truncated === true,
    };

    this.sendResponse(response);
  }

  sendResponse(payload) {
    this.app.wsManager?.send({ type: 'ropilot_harness_response', ...payload });
  }

  requestFS(requestId, operation, payload = {}) {
    const fsRequestId = `fs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ws = this.app.wsManager;
    if (!ws) return Promise.reject(new Error('WebSocket manager is not available'));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingFS.delete(fsRequestId);
        reject(new Error(`Timed out waiting for ${operation}`));
      }, DEFAULT_TIMEOUT_MS);

      this.pendingFS.set(fsRequestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      const sent = ws.send({
        type: 'ropilot_harness_fs_request',
        request_id: requestId,
        fs_request_id: fsRequestId,
        operation,
        ...payload,
      });
      if (!sent) {
        this.pendingFS.delete(fsRequestId);
        clearTimeout(timeout);
        reject(new Error('WebSocket is not open'));
      }
    });
  }
}

export { loadShellRunner, loadHarnessParser, prepareCommand };

export const __test__ = {
  RopilotHarness,
  loadShellRunner,
  loadHarnessParser,
  parseScript: async (...args) => (await loadHarnessParser()).parseScript(...args),
  prepareCommand,
};
