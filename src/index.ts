import { promisify } from 'util';
import type { Readable } from 'stream';
import type { ReadStream } from 'tty';

class CancelError extends Error {
  constructor () {
    super('The request was aborted by the user');
  }

  get code () {
    return 'ECANCELED';
  }
}

function askPasswordImpl (
  stream: Readable | ReadStream,
  callback: ((err: Error) => void) & ((err: null, result: Buffer|string) => void)) {
  const isTTY: boolean = 'isTTY' in stream && stream.isTTY;
  let wasRaw: boolean | null = false;
  let streamEnded = false;
  let wasReset = false;
  let origSetRawMode = null;
  const wasFlowing: boolean | null = stream.readableFlowing ?? null;
  let buf: Buffer|string = Buffer.alloc(0);

  const listeners = {
    readable: stream.rawListeners('readable'),
    data: stream.rawListeners('data'),
    keypress: stream.rawListeners('keypress')
  };
  stream.removeAllListeners('data');
  stream.removeAllListeners('readable');
  stream.removeAllListeners('keypress');
  if (isTTY) {
    const rs = stream as ReadStream;
    wasRaw = rs.isRaw;
    rs.setRawMode(true);
    origSetRawMode = rs.setRawMode;
    rs.setRawMode = (value) => {
      wasRaw = null; // Mark wasRaw as explicitly overriden.
      rs.setRawMode = origSetRawMode;
      return rs.setRawMode(value);
    };
  }
  stream.prependListener('data', ondata);
  stream.prependListener('error', onerror);
  stream.prependListener('close', onclose);
  stream.prependListener('end', onend);

  if (!wasFlowing) {
    stream.resume();
  }

  function reset () {
    if (wasReset) {
      throw new Error('askPassword() tried to reset twice, internal bug');
    }
    wasReset = true;
    stream.removeListener('data', ondata);
    stream.removeListener('error', onerror);
    stream.removeListener('close', onclose);
    stream.removeListener('end', onend);
    for (const listener of listeners.data) {
      stream.addListener('data', listener as ((chunk: Buffer|string) => void));
    }
    for (const listener of listeners.readable) {
      stream.addListener('readable', listener as (() => void));
    }
    for (const listener of listeners.keypress) {
      stream.addListener('keypress', listener as (() => void));
    }
    if (buf.length > 0 && !streamEnded) {
      stream.unshift(buf);
    }
    if (isTTY && wasRaw !== null) {
      (stream as ReadStream).setRawMode(wasRaw);
    }
    if (origSetRawMode !== null) {
      (stream as ReadStream).setRawMode = origSetRawMode;
    }
    if (wasFlowing === false) {
      stream.pause();
    } else if (wasFlowing === null) {
      // There is no way to get a stream back into `readableFlowing = null`,
      // unfortunately. We do our best to emulate that.
      stream.pause();
      const onnewlistener = (event) => {
        if (event === 'data' || event === 'readable') {
          stream.resume();
        }
      };
      const onresume = () => {
        stream.removeListener('newListener', onnewlistener);
        stream.removeListener('resume', onresume);
      };
      stream.addListener('newListener', onnewlistener);
      stream.addListener('resume', onresume);
    }
  }

  function ondata (input) {
    if (typeof input === 'string') {
      buf += input; // If somebody called stream.setEncoding()
    } else {
      buf = Buffer.concat([buf, input]);
    }
    // Check for Ctrl+C/Ctrl+D
    if (isTTY && (buf.indexOf('\u0003') !== -1 || buf.indexOf('\u0004') !== -1)) {
      reset();
      callback(new CancelError());
      return;
    }
    const crIndex = buf.indexOf('\r');
    const lfIndex = buf.indexOf('\n');
    const newlineIndex =
      crIndex === -1 ? lfIndex
        : lfIndex === -1 ? crIndex
          : Math.min(lfIndex, crIndex);
    if (newlineIndex === -1) return;

    const result = buf.slice(0, newlineIndex);
    buf = buf.slice(newlineIndex + 1);

    reset();
    callback(null, result);
  }

  function onend () {
    streamEnded = true;
    reset();
    callback(null, buf);
  }

  function onerror (err) {
    streamEnded = true;
    reset();
    callback(err);
  }

  function onclose () {
    streamEnded = true;
    reset();
    callback(new Error('Stream closed before password could be read'));
  }
}

export = promisify(askPasswordImpl);
