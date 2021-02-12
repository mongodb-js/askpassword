import { promisify } from 'util';
import type { Readable, Writable } from 'stream';
import type { ReadStream } from 'tty';

type Options = {
  input?: Readable | ReadStream;
  output?: Writable;
  replacementCharacter?: string;
};

class CancelError extends Error {
  constructor () {
    super('The request was aborted by the user');
  }

  get code () {
    return 'ECANCELED';
  }
}

function askPasswordImpl (
  streamOrOptions: Readable | ReadStream | Options,
  callback: ((err: Error) => void) & ((err: null, result: Buffer|string) => void)) {
  let stream: Readable | ReadStream;
  let options: Options;
  if ('input' in streamOrOptions) {
    stream = streamOrOptions.input;
    options = streamOrOptions;
  } else {
    stream = streamOrOptions as Readable;
    options = {};
  }

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
    const prevLength = buf.length;
    if (typeof input === 'string') {
      buf += input; // If somebody called stream.setEncoding()
    } else {
      buf = Buffer.concat([buf, input]);
    }
    buf = handleBackspaces(buf);
    // Check for Ctrl+C/Ctrl+D/\r/\n
    const stops = ['\r', '\n'].concat(isTTY ? ['\u0003', '\u0004'] : []);
    let stopIndex = buf.length;
    let stopChar: string;
    for (const stop of stops) {
      const index = buf.indexOf(stop);
      if (index !== -1 && index < stopIndex) {
        stopIndex = index;
        stopChar = stop;
      }
    }

    const addedLength = stopIndex - prevLength;
    if (options.output && options.replacementCharacter) {
      options.output.write(options.replacementCharacter.repeat(addedLength));
    }

    if (stopIndex === buf.length) return;
    const result = buf.slice(0, stopIndex);
    buf = buf.slice(stopIndex + 1);

    reset();
    if (stopChar === '\r' || stopChar === '\n') {
      callback(null, result);
    } else {
      callback(new CancelError());
    }
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

function handleBackspaces (input: Buffer|string): Buffer|string {
  while (true) {
    const bs1Index = input.indexOf('\u007f');
    const bs2Index = input.indexOf('\u0008');
    let backspaceIndex = -1;
    if (bs1Index !== -1) {
      backspaceIndex = bs1Index;
    }
    if (bs2Index !== -1 && (backspaceIndex === -1 || bs2Index < backspaceIndex)) {
      backspaceIndex = bs2Index;
    }

    if (backspaceIndex === -1) break;
    if (backspaceIndex === 0) {
      input = input.slice(1);
    }

    // Find the first character before the backspace and remove it.
    if (typeof input === 'string') {
      input = input.slice(0, backspaceIndex).replace(/.$/u, '') + input.slice(backspaceIndex + 1);
    } else {
      // Assume UTF-8 here.
      let i;
      for (i = backspaceIndex - 1; i >= backspaceIndex - 6; i--) {
        if (input[i] <= 0x7f || input[i] >= 0xc0) {
          break;
        }
      }
      input = Buffer.concat([input.slice(0, i), input.slice(backspaceIndex + 1)]);
    }
  }

  return input;
}

export = promisify(askPasswordImpl);
