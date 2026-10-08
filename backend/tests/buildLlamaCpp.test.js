const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  WINDOWS_LLAMA_DIRECTORY,
  prebuiltServer,
  prepareLlama,
} = require('../scripts/build-llama-cpp');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fiberline llama setup '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'prebuilt with spaces');
  fs.mkdirSync(directory);
  const server = path.join(directory, 'llama-server.exe');
  fs.writeFileSync(server, 'test fixture only; never execute');
  fs.writeFileSync(path.join(directory, 'ggml.dll'), 'DLL fixture');
  return { root, directory, server, envFile: path.join(root, '.env') };
}

function noSpawn() {
  assert.fail('prebuilt setup must not invoke Bash, a compiler, or model inference');
}

test('npm uses Node rather than the broken Windows Bash/WSL launcher', () => {
  assert.equal(require('../package.json').scripts['llama:build'], 'node scripts/build-llama-cpp.js');
});

test('Windows defaults to the requested download and permits explicit overrides', () => {
  assert.equal(WINDOWS_LLAMA_DIRECTORY,
    'C:/Users/sws/Desktop/web product images/llama-b11435-bin-win-cpu-x64');
  assert.equal(prebuiltServer({}, 'win32'), path.win32.join(WINDOWS_LLAMA_DIRECTORY, 'llama-server.exe'));
  assert.equal(prebuiltServer({ LLAMA_SERVER_BIN: 'D:/custom/server.exe' }, 'win32'), 'D:/custom/server.exe');
  assert.equal(prebuiltServer({
    LLAMA_CPP_DIR: 'D:/my llama', LLAMA_SERVER_BIN: 'C:/old/server.exe',
  }, 'win32'), path.win32.join('D:/my llama', 'llama-server.exe'));
  assert.equal(prebuiltServer({}, 'linux'), null);
});

test('Windows prebuilt setup persists paths with spaces without spawning or moving DLLs', (t) => {
  const { root, directory, server, envFile } = fixture(t);
  fs.writeFileSync(envFile, '# Existing settings\r\nLOCAL_LLM_MODEL=\r\nDATABASE_URL=unchanged\r\nLLAMA_SERVER_BIN=old\r\n');
  const options = {
    platform: 'win32', backendRoot: root, env: { LLAMA_SERVER_BIN: server }, spawn: noSpawn, log() {},
  };
  assert.equal(prepareLlama(options), 0);
  const content = fs.readFileSync(envFile, 'utf8');
  assert.ok(content.startsWith('# Existing settings\r\nLOCAL_LLM_MODEL=\r\nDATABASE_URL=unchanged\r\n'));
  assert.ok(content.includes(`LLAMA_SERVER_BIN='${server.replace(/\\/g, '/')}'\r\n`));
  assert.ok(content.includes(`LLAMA_CPP_DIR='${directory.replace(/\\/g, '/')}'\r\n`));
  assert.equal(content.match(/^LLAMA_SERVER_BIN=/gm).length, 1);
  assert.equal(fs.readFileSync(path.join(directory, 'ggml.dll'), 'utf8'), 'DLL fixture');
  assert.equal(fs.readFileSync(server, 'utf8'), 'test fixture only; never execute');
  prepareLlama(options);
  assert.equal(fs.readFileSync(envFile, 'utf8'), content, 'repeated setup is idempotent');
});

test('a native prebuilt directory can be configured without building from source', (t) => {
  const { root, directory, envFile } = fixture(t);
  fs.writeFileSync(path.join(directory, 'llama-server'), 'never execute');
  assert.equal(prepareLlama({
    platform: 'linux', backendRoot: root, env: { LLAMA_CPP_DIR: directory }, spawn: noSpawn, log() {},
  }), 0);
  assert.ok(fs.readFileSync(envFile, 'utf8').includes('LLAMA_SERVER_BIN='));
});

test('missing prebuilt files fail clearly without editing settings or falling back to WSL', (t) => {
  const { root, envFile } = fixture(t);
  const original = 'DATABASE_URL=unchanged\n';
  fs.writeFileSync(envFile, original);
  assert.throws(() => prepareLlama({
    platform: 'win32', backendRoot: root,
    env: { LLAMA_SERVER_BIN: path.join(root, 'missing.exe') }, spawn: noSpawn,
  }), /Prebuilt llama-server not found:.*missing\.exe/);
  assert.equal(fs.readFileSync(envFile, 'utf8'), original);
  assert.throws(() => prepareLlama({
    platform: 'linux', backendRoot: root, env: {}, prebuiltOnly: true, spawn: noSpawn,
  }), /Set LLAMA_CPP_DIR or LLAMA_SERVER_BIN/);
});

test('Linux source builds retain the existing shell script and propagate failure status', (t) => {
  const { root } = fixture(t);
  let calls = 0;
  const env = { BUILD_JOBS: '2' };
  assert.equal(prepareLlama({
    platform: 'linux', backendRoot: root, env,
    spawn(command, args, options) {
      calls += 1;
      assert.equal(command, 'bash');
      assert.deepEqual(args, [path.join(root, 'scripts', 'build-llama-cpp.sh')]);
      assert.equal(options.cwd, root);
      assert.equal(options.env, env);
      assert.equal(options.shell, false);
      return { status: 7 };
    },
  }), 7);
  assert.equal(calls, 1);
});
