#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const WINDOWS_LLAMA_DIRECTORY = 'C:/Users/sws/Desktop/web product images/llama-b11435-bin-win-cpu-x64';

function prebuiltServer(env, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path;
  const executable = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  if (env.LLAMA_CPP_DIR) return paths.join(env.LLAMA_CPP_DIR, executable);
  if (env.LLAMA_SERVER_BIN) return env.LLAMA_SERVER_BIN;
  if (platform === 'win32') return paths.join(WINDOWS_LLAMA_DIRECTORY, executable);
  return null;
}

// Persist only these two paths so future npm commands can find the same
// installation. Keep the DLLs beside the executable; do not copy the EXE alone.
function savePrebuiltPaths(envFile, serverBin) {
  const directory = path.dirname(serverBin);
  const values = {
    LLAMA_CPP_DIR: directory.replace(/\\/g, '/'),
    LLAMA_SERVER_BIN: serverBin.replace(/\\/g, '/'),
  };
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  for (const [key, value] of Object.entries(values)) {
    // Single-quoted values work in dotenv and Bash, including spaces and $.
    if (/[\r\n']/.test(value)) throw new Error('llama.cpp paths cannot contain newlines or single quotes.');
    const line = `${key}='${value}'`;
    const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[^\\r\\n]*`, 'gm');
    if (pattern.test(content)) {
      content = content.replace(pattern, () => line);
    } else {
      if (content && !content.endsWith('\n')) content += newline;
      content += line + newline;
    }
  }
  fs.writeFileSync(envFile, content);
}

function prepareLlama({
  env = process.env,
  platform = process.platform,
  backendRoot = BACKEND_ROOT,
  prebuiltOnly = false,
  spawn = spawnSync,
  log = console.log,
} = {}) {
  const configuredServer = prebuiltServer(env, platform);
  if (configuredServer) {
    const serverBin = path.resolve(backendRoot, configuredServer);
    if (!fs.existsSync(serverBin) || !fs.statSync(serverBin).isFile()) {
      throw new Error(`Prebuilt llama-server not found: ${serverBin}\nExtract the complete llama.cpp archive there, or set LLAMA_CPP_DIR to its directory.`);
    }
    savePrebuiltPaths(path.join(backendRoot, '.env'), serverBin);
    log(`Using prebuilt llama.cpp: ${path.dirname(serverBin)}`);
    log(`Server: ${serverBin}`);
    log('Saved LLAMA_CPP_DIR and LLAMA_SERVER_BIN in backend/.env. No build or inference was run.');
    return 0;
  }
  if (prebuiltOnly) throw new Error('Set LLAMA_CPP_DIR or LLAMA_SERVER_BIN to use a prebuilt llama.cpp installation.');

  // Existing Linux/macOS source build; Windows never invokes Bash/WSL.
  const result = spawn('bash', [path.join(backendRoot, 'scripts', 'build-llama-cpp.sh')], {
    cwd: backendRoot,
    env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (require.main === module) {
  try {
    require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });
    process.exitCode = prepareLlama({ prebuiltOnly: process.argv.includes('--prebuilt') });
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { WINDOWS_LLAMA_DIRECTORY, prebuiltServer, savePrebuiltPaths, prepareLlama };
