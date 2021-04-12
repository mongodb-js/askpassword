import hijackStream from 'hijack-stream';
import handleBackspaces from 'handle-backspaces';
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
  let input: Readable | ReadStream;
  let options: Options;
  if ('input' in streamOrOptions) {
    input = streamOrOptions.input;
    options = streamOrOptions;
  } else {
    input = streamOrOptions as Readable;
    options = {};
  }
  let buf: Buffer | string = Buffer.alloc(0);
  const isTTY: boolean = 'isTTY' in input && input.isTTY;

  const { restore } = hijackStream({
    stream: input,
    ondata (input: Buffer | string) {
      const prevLength = buf.length;
      if (typeof input === 'string') {
        buf += input; // If somebody called stream.setEncoding()
      } else {
        buf = Buffer.concat([buf as Buffer, input]);
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
        if (addedLength > 0) {
          options.output.write(options.replacementCharacter.repeat(addedLength));
        } else if (addedLength < 0) {
          options.output.write('\u0008 \u0008'.repeat(-addedLength));
        }
      }

      if (stopIndex === buf.length) return;
      const result = buf.slice(0, stopIndex);
      buf = buf.slice(stopIndex + 1);

      restore(buf);
      if (stopChar === '\r' || stopChar === '\n') {
        callback(null, result);
      } else {
        callback(new CancelError());
      }
    },
    onend (err: null | Error) {
      if (err) {
        callback(err);
      } else {
        callback(null, buf);
      }
    }
  });
}

export = promisify(askPasswordImpl);
