import { promisify } from 'util';
import type { Readable } from 'stream';
import type { ReadStream } from 'tty';

function askPasswordImpl (
  stream: Readable | ReadStream,
  callback: ((err: Error) => void) & ((err: null, result: Buffer|string) => void)) {
  const isTTY: boolean = 'isTTY' in stream && stream.isTTY;
  let wasRaw = false;
  let streamEnded = false;
  const wasFlowing: boolean | null = stream.readableFlowing ?? null;
  let buf: Buffer|string = Buffer.alloc(0);

  const listeners = {
    readable: stream.listeners('readable'),
    data: stream.listeners('data')
  };
  stream.removeAllListeners('data');
  stream.removeAllListeners('readable');
  if (isTTY) {
    wasRaw = (stream as ReadStream).isRaw;
    (stream as ReadStream).setRawMode(true);
  }
  stream.prependListener('data', ondata);
  stream.prependListener('error', onerror);
  stream.prependListener('close', onclose);
  stream.prependListener('end', onend);

  if (!wasFlowing) {
    stream.resume();
  }

  function reset () {
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
    if (buf.length > 0 && !streamEnded) {
      stream.unshift(buf);
    }
    if (isTTY) {
      (stream as ReadStream).setRawMode(wasRaw);
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
      buf += input;// If somebody called stream.setEncoding()
    } else {
      buf = Buffer.concat([buf, input]);
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
