import askpassword from '..';
import assert from 'assert';
import { spawn as spawnPty } from 'node-pty';
import { Readable } from 'stream';

function mustNotCall () {
  const { stack } = new Error();
  return () => assert.fail(`Unexpected call to function\n${stack}`);
}

describe('on regular streams', () => {
  it('lets the user enter a password', async () => {
    const stream = new Readable({ read () { /* ignore */ } });
    const pwdPromise = askpassword(stream);
    stream.push(Buffer.from('Banana\n'));
    assert.deepStrictEqual(await pwdPromise, Buffer.from('Banana'));
  });

  it('lets the user enter a password, string version', async () => {
    const stream = new Readable({ read () { /* ignore */ } });
    const pwdPromise = askpassword(stream);
    stream.setEncoding('utf8');
    stream.push(Buffer.from('Banana\n'));
    assert.deepStrictEqual(await pwdPromise, 'Banana');
  });

  it('lets the user enter a password, no newline but EOS', async () => {
    const stream = new Readable({ read () { /* ignore */ } });
    const pwdPromise = askpassword(stream);
    stream.setEncoding('utf8');
    stream.push(Buffer.from('Banana'));
    stream.push(null);
    assert.deepStrictEqual(await pwdPromise, 'Banana');
  });

  it('does not call other "data" listeners', async () => {
    const stream = new Readable({ read () { /* ignore */ } });
    stream.on('data', mustNotCall());
    const pwdPromise = askpassword(stream);
    stream.push(Buffer.from('Banana\n'));
    assert.deepStrictEqual(await pwdPromise, Buffer.from('Banana'));
  });

  it('does not call other "readable" listeners', async () => {
    const stream = new Readable({ read () { /* ignore */ } });
    stream.on('readable', mustNotCall());
    const pwdPromise = askpassword(stream);
    stream.push(Buffer.from('Banana\n'));
    assert.deepStrictEqual(await pwdPromise, Buffer.from('Banana'));
  });

  it('does call other "data" listeners if partial data is available', async () => {
    const stream = new Readable({ read () { /* ignore */ } });
    let extra = null;
    stream.on('data', (chunk) => { extra = chunk; });
    const pwdPromise = askpassword(stream);
    stream.push(Buffer.from('Banana\nPhone'));
    assert.deepStrictEqual(await pwdPromise, Buffer.from('Banana'));
    assert.deepStrictEqual(extra, Buffer.from('Phone'));
  });

  it('does call other "readable" listeners if partial data is available', async () => {
    const stream = new Readable({ read () { /* ignore */ } });
    let extra = null;
    stream.on('readable', () => { extra = stream.read(); });
    const pwdPromise = askpassword(stream);
    stream.push(Buffer.from('Banana\nPhone'));
    assert.deepStrictEqual(await pwdPromise, Buffer.from('Banana'));
    assert.deepStrictEqual(extra, Buffer.from('Phone'));
  });

  it('rejects when the stream is destroyed while reading', async () => {
    const stream = new Readable({ read () { /* ignore */ } });
    const pwdPromise = askpassword(stream);
    stream.push(Buffer.from('Banana'));
    setImmediate(() => stream.destroy());
    await assert.rejects(pwdPromise, /Stream closed before password could be read/);
  });

  it('rejects when the stream errors out while reading', async () => {
    const stream = new Readable({ read () { /* ignore */ } });
    const pwdPromise = askpassword(stream);
    stream.push(Buffer.from('Banana'));
    setImmediate(() => stream.destroy(new Error('some-error')));
    await assert.rejects(pwdPromise, /some-error/);
  });

  it('keeps a stream paused if it was before', async () => {
    const stream = new Readable({ read () { /* ignore */ } });
    stream.pause();
    const pwdPromise = askpassword(stream);
    stream.push(Buffer.from('Banana\r'));
    assert.deepStrictEqual(await pwdPromise, Buffer.from('Banana'));
    assert.strictEqual(stream.readableFlowing, false);
  });

  it('resumes if a new "data" handler is called', async () => {
    const stream = new Readable({ read () { /* ignore */ } });
    const pwdPromise = askpassword(stream);
    stream.push(Buffer.from('Banana\r'));
    assert.deepStrictEqual(await pwdPromise, Buffer.from('Banana'));
    assert.strictEqual(stream.readableFlowing, false);
    stream.on('data', mustNotCall());
    assert.strictEqual(stream.readableFlowing, true);
  });

  it('accepts both \\r and \\n as line delimiters, \\r first', async () => {
    const stream = new Readable({ read () { /* ignore */ } });
    const pwdPromise = askpassword(stream);
    stream.push(Buffer.from('Apple\rBanana\nOrange'));
    assert.deepStrictEqual(await pwdPromise, Buffer.from('Apple'));
  });

  it('accepts both \\r and \\n as line delimiters, \\n first', async () => {
    const stream = new Readable({ read () { /* ignore */ } });
    const pwdPromise = askpassword(stream);
    stream.push(Buffer.from('Apple\nBanana\rOrange'));
    assert.deepStrictEqual(await pwdPromise, Buffer.from('Apple'));
  });
});

describe('in a PTY', () => {
  const requirePath = require.resolve('..');

  it('Does not echo back to the user', (done) => {
    const proc = spawnPty(process.execPath, ['-e', `
      (async () => {
        try {
          assert.strictEqual(process.stdin.constructor, tty.ReadStream);

          const askpassword = require(${JSON.stringify(requirePath)});
          const pwdPromise = askpassword(process.stdin);
          console.log('READY');
          console.log('PW: >>' + await pwdPromise + '<<');
        } catch (err) {
          console.log('Fail: >>' + err.message + '<<');
        }
      })()
    `], { name: 'xterm' });

    // Note that node-pty does string encoding/decoding for us -- that seems
    // a bit shady on their side, but it's nice for testing.
    let out = '';
    let wrotePassword = false;
    proc.on('data', (chunk) => {
      out += chunk;
      if (out.includes('READY') && !wrotePassword) {
        proc.write('Mewtoo\r');
        wrotePassword = true;
      }
    });
    proc.on('exit', (code) => {
      assert.strictEqual(code, 0);
      assert.strictEqual(out, 'READY\r\nPW: >>Mewtoo<<\r\n');
      done();
    });
  });

  it('Does not echo back to the user when used from the REPL', (done) => {
    const proc = spawnPty(process.execPath, ['--interactive'], {
      name: 'xterm',
      env: { ...process.env, NO_COLOR: '1' }
    });

    let out = '';
    let startedAskPassword = false;
    let wrotePassword = false;
    let didExit = false;
    proc.on('data', (chunk) => {
      out += chunk;
      if (out.includes('> ') && !startedAskPassword) {
        proc.write(`const askpassword = require(${JSON.stringify(requirePath)});\r`);
        proc.write('askpassword(process.stdin).then((pw) => console.log("P" + "W: >>" + pw + "<<"));' +
          'console.log("READY")\r');
        startedAskPassword = true;
        return;
      }
      if (out.includes('READY') && !wrotePassword) {
        proc.write('Mewtoo\r');
        wrotePassword = true;
        return;
      }
      if (out.includes('PW: >>') && !didExit) {
        proc.write('.exit\r');
        didExit = true;
      }
    });
    proc.on('exit', (code) => {
      assert.strictEqual(code, 0);
      assert(
        out.includes('PW: >>Mewtoo<<'),
        `Unexpected output: ${out}`);
      assert(
        !out.replace('PW: >>Mewtoo<<', '').includes('Mewtoo'),
        `Unexpected output: ${out}`);
      done();
    });
  });
});
