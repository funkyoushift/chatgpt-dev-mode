import express from 'express';
import cors from 'cors';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const SERVER_NAME = 'funkyou-dev-helper';
const SERVER_VERSION = '1.1.0';
const PROTOCOL_VERSION = '2025-06-18';

const defaultAllowedApps = 'funkyouai,funkyou-dev-helper';
const allowedApps = String(process.env.FLY_ALLOWED_APPS || defaultAllowedApps)
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

const repoConfigs = {
  funkyouai: {
    app: 'funkyouai',
    repo: process.env.FUNKYOUAI_REPO_URL || 'https://github.com/funkyoushift/FunkYouAI.git',
    branch: process.env.FUNKYOUAI_BRANCH || 'main'
  },
  'funkyou-dev-helper': {
    app: 'funkyou-dev-helper',
    repo: process.env.FUNKYOU_DEV_HELPER_REPO_URL || 'https://github.com/funkyoushift/chatgpt-dev-mode.git',
    branch: process.env.FUNKYOU_DEV_HELPER_BRANCH || 'main'
  }
};

const allowedNpmScripts = new Set(
  String(process.env.ALLOWED_NPM_SCRIPTS || 'check,audit,safety')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);

const resources = new Map([
  ['fly-status', {
    id: 'fly-status',
    title: 'Fly app status helper',
    text: `Use fly_status with an allowed app name to inspect Fly machine state. Allowed apps: ${allowedApps.join(', ')}.`
  }],
  ['fly-logs', {
    id: 'fly-logs',
    title: 'Fly logs helper',
    text: 'Use fly_logs with an allowed app name to read recent Fly logs. Logs may include app output; never paste secrets into Discord or logs.'
  }],
  ['fly-deploy', {
    id: 'fly-deploy',
    title: 'Fly deploy helper',
    text: [
      'Use fly_deploy to deploy an allowlisted Fly app from its allowlisted GitHub repo.',
      'This helper clones the repo into a temporary folder inside the helper container, runs flyctl deploy --remote-only, then deletes the temp folder.',
      `Allowed apps: ${Object.keys(repoConfigs).filter(appName => allowedApps.includes(appName)).join(', ')}.`
    ].join('\n')
  }],
  ['fly-restart', {
    id: 'fly-restart',
    title: 'Fly restart helper',
    text: 'Use fly_restart to restart machines for an allowlisted Fly app.'
  }],
  ['repo-run-script', {
    id: 'repo-run-script',
    title: 'Repo script helper',
    text: `Use repo_run_script to run an allowlisted npm script in an allowlisted repo. Allowed scripts: ${[...allowedNpmScripts].join(', ')}.`
  }],
  ['funkyouai-deploy-checklist', {
    id: 'funkyouai-deploy-checklist',
    title: 'FunkYouAI deploy checklist',
    text: [
      '1. repo_run_script app=funkyouai script=check',
      '2. repo_run_script app=funkyouai script=audit if the repo has that script',
      '3. repo_run_script app=funkyouai script=safety if the repo has that script',
      '4. fly_deploy app=funkyouai',
      '5. fly_status app=funkyouai',
      '6. fly_logs app=funkyouai'
    ].join('\n')
  }]
]);

app.use(cors({
  origin: ['https://chatgpt.com', 'https://chat.openai.com'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version'],
  methods: ['GET', 'POST', 'OPTIONS']
}));
app.use(express.json({ limit: '1mb' }));

function jsonRpc(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolText(text) {
  return { content: [{ type: 'text', text: String(text || '') }], isError: false };
}

function toolJson(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError };
}

function toolError(text) {
  return { content: [{ type: 'text', text: String(text || '') }], isError: true };
}

function flyToken() {
  return process.env.FLY_API_TOKEN || process.env.FLY_ACCESS_TOKEN || '';
}

function githubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
}

function commandEnv() {
  const env = { ...process.env };
  const token = flyToken();
  if (token) env.FLY_API_TOKEN = token;
  return env;
}

function assertAllowedApp(app) {
  const cleaned = String(app || '').trim();
  if (!cleaned) return { ok: false, error: 'Missing app name.' };
  if (!allowedApps.includes(cleaned)) {
    return { ok: false, error: `App '${cleaned}' is not allowlisted. Allowed apps: ${allowedApps.join(', ') || '(none)'}` };
  }
  return { ok: true, app: cleaned };
}

function assertAllowedRepoApp(app) {
  const allowed = assertAllowedApp(app);
  if (!allowed.ok) return allowed;
  const config = repoConfigs[allowed.app];
  if (!config) return { ok: false, error: `App '${allowed.app}' has no repo configuration on this helper.` };
  return { ok: true, config };
}

function runCommand(command, args, { cwd = process.cwd(), timeoutMs = 15000, maxBuffer = 1024 * 1024 * 5 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer,
    env: commandEnv()
  });

  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();

  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: stdout.slice(-12000),
    stderr: stderr.slice(-12000),
    error: result.error ? String(result.error.message || result.error) : ''
  };
}

function runFly(args, timeoutMs = 15000) {
  if (!flyToken()) {
    return toolError('Neither FLY_API_TOKEN nor FLY_ACCESS_TOKEN is configured on this MCP server. Add one as a Fly secret before using Fly helpers.');
  }

  const result = runCommand('flyctl', args, { timeoutMs, maxBuffer: 1024 * 1024 * 10 });
  if (!result.ok) return toolError(result.stderr || result.stdout || result.error || `flyctl exited with ${result.status}`);
  return toolText(result.stdout || '(flyctl returned no output)');
}

function safeRepoUrl(repoUrl) {
  const token = githubToken();
  if (!token || !repoUrl.startsWith('https://github.com/')) return repoUrl;
  return repoUrl.replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
}

function redactedRepoUrl(repoUrl) {
  return String(repoUrl || '').replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
}

function cloneRepo(config) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'funkyou-helper-'));
  const repoDir = path.join(tempDir, 'repo');
  const cloned = runCommand('git', [
    'clone',
    '--depth',
    '1',
    '--branch',
    config.branch || 'main',
    safeRepoUrl(config.repo),
    repoDir
  ], { timeoutMs: 120000, maxBuffer: 1024 * 1024 * 10 });

  if (!cloned.ok) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`Git clone failed for ${redactedRepoUrl(config.repo)}:\n${cloned.stderr || cloned.stdout || cloned.error}`);
  }

  return { tempDir, repoDir };
}

function cleanupTemp(tempDir) {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}

function installRepoDependencies(repoDir) {
  const hasPackageJson = fs.existsSync(path.join(repoDir, 'package.json'));
  if (!hasPackageJson) return { ok: true, skipped: true, reason: 'No package.json found.' };

  const hasPackageLock = fs.existsSync(path.join(repoDir, 'package-lock.json'));
  const args = hasPackageLock ? ['ci'] : ['install'];
  return runCommand('npm', args, { cwd: repoDir, timeoutMs: 300000, maxBuffer: 1024 * 1024 * 10 });
}

function searchResources(query) {
  const q = String(query || '').toLowerCase().trim();
  return [...resources.values()].filter(item => {
    const haystack = `${item.id} ${item.title} ${item.text}`.toLowerCase();
    return !q || haystack.includes(q);
  });
}

const tools = [
  {
    name: 'search',
    title: 'Search dev helper resources',
    description: 'Search the available FunkYouAI/Fly helper resources.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'fetch',
    title: 'Fetch dev helper resource',
    description: 'Fetch a helper resource by id returned from search.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Resource id' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'fly_status',
    title: 'Fly status',
    description: 'Read Fly status for an allowlisted app.',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', description: 'Fly app name, such as funkyouai' } },
      required: ['app'],
      additionalProperties: false
    }
  },
  {
    name: 'fly_logs',
    title: 'Fly logs',
    description: 'Read recent Fly logs for an allowlisted app.',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', description: 'Fly app name, such as funkyouai' } },
      required: ['app'],
      additionalProperties: false
    }
  },
  {
    name: 'fly_deploy',
    title: 'Fly deploy',
    description: 'Deploy an allowlisted Fly app from its allowlisted GitHub repo.',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', enum: Object.keys(repoConfigs), description: 'Allowlisted Fly app name.' } },
      required: ['app'],
      additionalProperties: false
    }
  },
  {
    name: 'fly_restart',
    title: 'Fly restart',
    description: 'Restart machines for an allowlisted Fly app.',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', description: 'Fly app name, such as funkyouai' } },
      required: ['app'],
      additionalProperties: false
    }
  },
  {
    name: 'repo_run_script',
    title: 'Run repo npm script',
    description: 'Clone an allowlisted repo and run an allowlisted npm script such as check, audit, or safety.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', enum: Object.keys(repoConfigs), description: 'Allowlisted app/repo to check.' },
        script: { type: 'string', enum: [...allowedNpmScripts], description: 'Allowlisted npm script.' }
      },
      required: ['app', 'script'],
      additionalProperties: false
    }
  }
];

app.get('/', (req, res) => {
  res.json({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    status: 'running',
    allowedApps,
    allowedNpmScripts: [...allowedNpmScripts],
    tools: tools.map(tool => tool.name)
  });
});

app.post('/', (req, res) => {
  const { jsonrpc, method, params = {}, id } = req.body || {};
  if (jsonrpc !== '2.0') return res.json(jsonRpcError(id ?? null, -32600, 'Expected JSON-RPC 2.0 request.'));

  if (method === 'initialize') {
    return res.json(jsonRpc(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false }
      },
      serverInfo: { name: SERVER_NAME, title: 'FunkYou Dev Helper', version: SERVER_VERSION }
    }));
  }

  if (method === 'initialized') return res.status(200).end();

  if (method === 'tools/list') return res.json(jsonRpc(id, { tools }));

  if (method === 'resources/list') {
    return res.json(jsonRpc(id, {
      resources: [...resources.values()].map(item => ({ uri: item.id, name: item.title, description: item.text.slice(0, 120) })),
      nextCursor: null
    }));
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};

    if (name === 'search') {
      const results = searchResources(args.query).map(item => ({ id: item.id, title: item.title, text: item.text.slice(0, 240) }));
      return res.json(jsonRpc(id, toolText(JSON.stringify(results, null, 2))));
    }

    if (name === 'fetch') {
      const item = resources.get(String(args.id || '').trim());
      if (!item) return res.json(jsonRpc(id, toolError(`Unknown resource id: ${args.id}`)));
      return res.json(jsonRpc(id, toolText(JSON.stringify(item, null, 2))));
    }

    if (name === 'fly_status') {
      const allowed = assertAllowedApp(args.app);
      if (!allowed.ok) return res.json(jsonRpc(id, toolError(allowed.error)));
      return res.json(jsonRpc(id, runFly(['status', '--app', allowed.app])));
    }

    if (name === 'fly_logs') {
      const allowed = assertAllowedApp(args.app);
      if (!allowed.ok) return res.json(jsonRpc(id, toolError(allowed.error)));
      return res.json(jsonRpc(id, runFly(['logs', '--app', allowed.app, '--no-tail'], 20000)));
    }

    if (name === 'fly_restart') {
      const allowed = assertAllowedApp(args.app);
      if (!allowed.ok) return res.json(jsonRpc(id, toolError(allowed.error)));
      return res.json(jsonRpc(id, runFly(['machine', 'restart', '--app', allowed.app], 180000)));
    }

    if (name === 'fly_deploy') {
      if (!flyToken()) return res.json(jsonRpc(id, toolError('Neither FLY_API_TOKEN nor FLY_ACCESS_TOKEN is configured on this MCP server.')));
      const allowed = assertAllowedRepoApp(args.app);
      if (!allowed.ok) return res.json(jsonRpc(id, toolError(allowed.error)));

      let tempDir = '';
      try {
        const cloned = cloneRepo(allowed.config);
        tempDir = cloned.tempDir;
        const deployed = runCommand('flyctl', ['deploy', '-a', allowed.config.app, '--remote-only'], {
          cwd: cloned.repoDir,
          timeoutMs: 1000 * 60 * 12,
          maxBuffer: 1024 * 1024 * 15
        });
        return res.json(jsonRpc(id, toolJson({
          ok: deployed.ok,
          app: allowed.config.app,
          repo: redactedRepoUrl(allowed.config.repo),
          branch: allowed.config.branch,
          stdout: deployed.stdout,
          stderr: deployed.stderr,
          error: deployed.error
        }, !deployed.ok)));
      } catch (err) {
        return res.json(jsonRpc(id, toolJson({ ok: false, error: String(err.message || err) }, true)));
      } finally {
        cleanupTemp(tempDir);
      }
    }

    if (name === 'repo_run_script') {
      const allowed = assertAllowedRepoApp(args.app);
      if (!allowed.ok) return res.json(jsonRpc(id, toolError(allowed.error)));

      const script = String(args.script || '').trim();
      if (!allowedNpmScripts.has(script)) {
        return res.json(jsonRpc(id, toolError(`Script '${script}' is not allowlisted. Allowed scripts: ${[...allowedNpmScripts].join(', ')}`)));
      }

      let tempDir = '';
      try {
        const cloned = cloneRepo(allowed.config);
        tempDir = cloned.tempDir;
        const installed = installRepoDependencies(cloned.repoDir);
        if (!installed.ok) {
          return res.json(jsonRpc(id, toolJson({
            ok: false,
            app: allowed.config.app,
            step: 'install dependencies',
            stdout: installed.stdout,
            stderr: installed.stderr,
            error: installed.error
          }, true)));
        }

        const checked = runCommand('npm', ['run', script], {
          cwd: cloned.repoDir,
          timeoutMs: 1000 * 60 * 5,
          maxBuffer: 1024 * 1024 * 10
        });
        return res.json(jsonRpc(id, toolJson({
          ok: checked.ok,
          app: allowed.config.app,
          repo: redactedRepoUrl(allowed.config.repo),
          branch: allowed.config.branch,
          script,
          stdout: checked.stdout,
          stderr: checked.stderr,
          error: checked.error
        }, !checked.ok)));
      } catch (err) {
        return res.json(jsonRpc(id, toolJson({ ok: false, error: String(err.message || err) }, true)));
      } finally {
        cleanupTemp(tempDir);
      }
    }

    return res.json(jsonRpcError(id, -32601, `Unknown tool: ${name}`));
  }

  return res.json(jsonRpcError(id, -32601, `Unknown method: ${method}`));
});

app.listen(PORT, () => {
  console.log(`${SERVER_NAME} v${SERVER_VERSION} listening on ${PORT}`);
});
