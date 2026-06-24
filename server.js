import express from 'express';
import cors from 'cors';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const SERVER_NAME = 'funkyou-dev-helper';
const SERVER_VERSION = '1.2.0';
const PROTOCOL_VERSION = '2025-06-18';

const defaultAllowedApps = 'funkyouai,funkyou-dev-helper';
const allowedApps = csv(process.env.FLY_ALLOWED_APPS || defaultAllowedApps);

const repoConfigs = {
  funkyouai: {
    app: 'funkyouai',
    repo: process.env.FUNKYOUAI_REPO_URL || 'https://github.com/funkyoushift/FunkYouAI.git',
    branch: process.env.FUNKYOUAI_BRANCH || 'main',
    fullName: process.env.FUNKYOUAI_REPO_FULL_NAME || 'funkyoushift/FunkYouAI'
  },
  'funkyou-dev-helper': {
    app: 'funkyou-dev-helper',
    repo: process.env.FUNKYOU_DEV_HELPER_REPO_URL || 'https://github.com/funkyoushift/chatgpt-dev-mode.git',
    branch: process.env.FUNKYOU_DEV_HELPER_BRANCH || 'main',
    fullName: process.env.FUNKYOU_DEV_HELPER_REPO_FULL_NAME || 'funkyoushift/chatgpt-dev-mode'
  }
};

const allowedNpmScripts = new Set(csv(process.env.ALLOWED_NPM_SCRIPTS || 'check,audit,safety'));
const allowedSecretNames = new Set(csv(process.env.ALLOWED_SECRET_NAMES || [
  'OPENAI_API_KEY',
  'DISCORD_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'FLY_API_TOKEN',
  'FLY_ACCESS_TOKEN',
  'BL4_SERIALS_API_URL',
  'BL4_SERIALS_API_KEY',
  'GITHUB_LOGS_TOKEN',
  'GITHUB_LOGS_REPO'
].join(',')));
const allowAnySecretName = bool(process.env.ALLOW_ANY_SECRET_NAME || 'false');
const writeToolsEnabled = bool(process.env.WRITE_TOOLS_ENABLED || 'true');

const LOG_ERROR_PATTERN = /(error|exception|crash|failed|fail|fatal|unhandled|rejected|denied|timeout|misconfigured|discord|openai|sdk)/i;
const BOOT_PATTERN = /(logged in|SDK-FIRST|runtime boot|member access|member item|web search|image analysis|serials API|model router|github logs|cooldown|max open tickets|max ticket messages|max attachment|listening|ready|started)/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache', '.turbo']);
const TEXT_FILE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.yml', '.yaml', '.toml', '.html', '.css', '.scss', '.py', '.sh', '.ps1', '.env.example', '.gitignore', '.dockerignore', '.Dockerfile'
]);

function csv(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function bool(value) {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value || '').trim().toLowerCase());
}

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

function discordToken() {
  return process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || '';
}

function commandEnv() {
  const env = { ...process.env };
  const token = flyToken();
  if (token) env.FLY_API_TOKEN = token;
  return env;
}

function redactSecretText(text) {
  let output = String(text || '');
  for (const secret of [flyToken(), githubToken(), discordToken()]) {
    if (secret) output = output.split(secret).join('***REDACTED***');
  }
  output = output.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
  output = output.replace(/(DISCORD_TOKEN|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|FLY_API_TOKEN|FLY_ACCESS_TOKEN)=\S+/g, '$1=***');
  return output;
}

function assertWriteToolsEnabled() {
  if (!writeToolsEnabled) return { ok: false, error: 'Write tools are disabled. Set WRITE_TOOLS_ENABLED=true on the helper app to enable them.' };
  return { ok: true };
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

function assertRelativePath(filePath) {
  const cleaned = String(filePath || '').replace(/\\/g, '/').trim();
  if (!cleaned) return { ok: false, error: 'Missing file path.' };
  if (cleaned.startsWith('/') || cleaned.includes('../') || cleaned === '..' || cleaned.includes('\0')) {
    return { ok: false, error: 'File path must be a safe relative path inside the repo.' };
  }
  return { ok: true, filePath: cleaned };
}

function runCommand(command, args, { cwd = process.cwd(), timeoutMs = 15000, maxBuffer = 1024 * 1024 * 5 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer,
    env: commandEnv()
  });

  const stdout = redactSecretText(String(result.stdout || '').trim());
  const stderr = redactSecretText(String(result.stderr || '').trim());

  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: stdout.slice(-20000),
    stderr: stderr.slice(-20000),
    error: result.error ? redactSecretText(String(result.error.message || result.error)) : ''
  };
}

function runFlyRaw(args, timeoutMs = 15000) {
  if (!flyToken()) {
    return { ok: false, stdout: '', stderr: '', error: 'Neither FLY_API_TOKEN nor FLY_ACCESS_TOKEN is configured on this MCP server. Add one as a Fly secret before using Fly helpers.' };
  }
  return runCommand('flyctl', args, { timeoutMs, maxBuffer: 1024 * 1024 * 10 });
}

function runFly(args, timeoutMs = 15000) {
  const result = runFlyRaw(args, timeoutMs);
  if (!result.ok) return toolError(result.stderr || result.stdout || result.error || `flyctl exited with ${result.status}`);
  return toolText(result.stdout || '(flyctl returned no output)');
}

function safeRepoUrl(repoUrl) {
  const token = githubToken();
  if (!token || !repoUrl.startsWith('https://github.com/')) return repoUrl;
  return repoUrl.replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
}

function redactedRepoUrl(repoUrl) {
  return redactSecretText(String(repoUrl || '')).replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
}

function cloneRepo(config, { depth = '1', branch = null } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'funkyou-helper-'));
  const repoDir = path.join(tempDir, 'repo');
  const cloneArgs = ['clone'];
  if (depth) cloneArgs.push('--depth', String(depth));
  cloneArgs.push('--branch', branch || config.branch || 'main', safeRepoUrl(config.repo), repoDir);

  const cloned = runCommand('git', cloneArgs, { timeoutMs: 120000, maxBuffer: 1024 * 1024 * 10 });

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

function isProbablyTextFile(filePath) {
  const base = path.basename(filePath);
  if (['Dockerfile', 'LICENSE', 'README', 'Makefile'].includes(base)) return true;
  const ext = path.extname(filePath);
  return TEXT_FILE_EXTENSIONS.has(ext) || TEXT_FILE_EXTENSIONS.has(base);
}

function walkFiles(dir, root = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(absolute, root, out);
    else if (entry.isFile()) out.push(path.relative(root, absolute).replace(/\\/g, '/'));
  }
  return out;
}

function searchFiles(repoDir, query, { maxResults = 50, caseSensitive = false } = {}) {
  const needle = String(query || '');
  if (!needle) return [];
  const files = walkFiles(repoDir);
  const results = [];
  const normalizedNeedle = caseSensitive ? needle : needle.toLowerCase();
  for (const rel of files) {
    if (!isProbablyTextFile(rel)) continue;
    const absolute = path.join(repoDir, rel);
    let text = '';
    try {
      const stat = fs.statSync(absolute);
      if (stat.size > 1024 * 1024) continue;
      text = fs.readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const haystack = caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (haystack.includes(normalizedNeedle)) {
        results.push({ path: rel, line: i + 1, text: lines[i].slice(0, 300) });
        if (results.length >= maxResults) return results;
      }
    }
  }
  return results;
}

function getLogs(appName, timeoutMs = 25000) {
  const result = runFlyRaw(['logs', '--app', appName, '--no-tail'], timeoutMs);
  return result.ok ? result.stdout : `${result.stderr}\n${result.stdout}\n${result.error}`.trim();
}

function getStatus(appName, json = false) {
  const args = json ? ['status', '--app', appName, '--json'] : ['status', '--app', appName];
  return runFlyRaw(args, 20000);
}

function parseJsonMaybe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function summarizeBootLogs(logText) {
  const lines = String(logText || '').split(/\r?\n/).filter(Boolean);
  const interesting = lines.filter(line => BOOT_PATTERN.test(line)).slice(-80);
  return {
    loggedIn: /logged in as/i.test(logText),
    sdkFirstBoot: /SDK-FIRST/i.test(logText),
    memberItemBetaOn: /Member item beta mode:\s*ON/i.test(logText),
    serialsApiOff: /Borderlands4 serials API:\s*OFF/i.test(logText),
    githubLogsMisconfigured: /GitHub logs:\s*MISCONFIGURED/i.test(logText),
    recentBootLines: interesting
  };
}

function recentErrorLines(logText, limit = 80) {
  return String(logText || '')
    .split(/\r?\n/)
    .filter(line => LOG_ERROR_PATTERN.test(line))
    .slice(-Math.max(1, Math.min(Number(limit) || 80, 200)));
}

function resourcesMap() {
  return new Map([
    ['tools', { id: 'tools', title: 'Available tools', text: `Tools: ${tools.map(tool => tool.name).join(', ')}` }],
    ['fly-status', { id: 'fly-status', title: 'Fly app status helper', text: `Use fly_status with an allowed app name. Allowed apps: ${allowedApps.join(', ')}.` }],
    ['fly-logs', { id: 'fly-logs', title: 'Fly logs helper', text: 'Use fly_logs with an allowed app name to read recent Fly logs.' }],
    ['fly-deploy', { id: 'fly-deploy', title: 'Fly deploy helper', text: 'Use fly_deploy to deploy an allowlisted Fly app from its allowlisted GitHub repo.' }],
    ['repo-tools', { id: 'repo-tools', title: 'Repo helper tools', text: 'Use repo_file_search, repo_fetch_file, github_latest_commit, github_update_file, github_create_pr, and repo_run_script for repo work.' }],
    ['health', { id: 'health', title: 'Bot health helper', text: 'Use bot_health_check, fly_recent_errors, fly_boot_summary, fly_current_image, and discord_bot_ping for diagnostics.' }],
    ['secrets', { id: 'secrets', title: 'Fly secrets helper', text: `Use fly_list_secret_names and fly_set_secret. Default allowed secret names: ${[...allowedSecretNames].join(', ')}.` }],
    ['funkyouai-deploy-checklist', {
      id: 'funkyouai-deploy-checklist',
      title: 'FunkYouAI deploy checklist',
      text: ['1. repo_run_script app=funkyouai script=check', '2. repo_run_script app=funkyouai script=audit', '3. repo_run_script app=funkyouai script=safety', '4. fly_deploy app=funkyouai', '5. bot_health_check app=funkyouai'].join('\n')
    }]
  ]);
}

function searchResources(query) {
  const resources = resourcesMap();
  const q = String(query || '').toLowerCase().trim();
  return [...resources.values()].filter(item => {
    const haystack = `${item.id} ${item.title} ${item.text}`.toLowerCase();
    return !q || haystack.includes(q);
  });
}

function githubHeaders() {
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': SERVER_NAME, 'X-GitHub-Api-Version': '2022-11-28' };
  if (githubToken()) headers.Authorization = `Bearer ${githubToken()}`;
  return headers;
}

async function createGitHubPullRequest(config, { title, body, head, base }) {
  if (!githubToken()) throw new Error('GITHUB_TOKEN or GH_TOKEN is required to create a pull request.');
  const repo = config.fullName;
  const response = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
    method: 'POST',
    headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, head, base })
  });
  const text = await response.text();
  const json = parseJsonMaybe(text);
  if (!response.ok) throw new Error(`GitHub PR create failed (${response.status}): ${text}`);
  return json;
}

const tools = [
  {
    name: 'search',
    title: 'Search dev helper resources',
    description: 'Search the available FunkYouAI/Fly helper resources.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'], additionalProperties: false }
  },
  {
    name: 'fetch',
    title: 'Fetch dev helper resource',
    description: 'Fetch a helper resource by id returned from search.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Resource id' } }, required: ['id'], additionalProperties: false }
  },
  {
    name: 'fly_status', title: 'Fly status', description: 'Read Fly status for an allowlisted app.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'Fly app name, such as funkyouai' } }, required: ['app'], additionalProperties: false }
  },
  {
    name: 'fly_logs', title: 'Fly logs', description: 'Read recent Fly logs for an allowlisted app.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'Fly app name, such as funkyouai' } }, required: ['app'], additionalProperties: false }
  },
  {
    name: 'fly_recent_errors', title: 'Fly recent errors', description: 'Filter recent Fly logs down to likely errors/warnings/crashes.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' }, limit: { type: 'number', description: 'Max matching lines, default 80.' } }, required: ['app'], additionalProperties: false }
  },
  {
    name: 'fly_boot_summary', title: 'Fly boot summary', description: 'Summarize recent startup and bot boot lines from Fly logs.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'], additionalProperties: false }
  },
  {
    name: 'bot_health_check', title: 'Bot health check', description: 'Check Fly status and logs for a quick bot health report.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'], additionalProperties: false }
  },
  {
    name: 'fly_current_image', title: 'Fly current image', description: 'Return the current Fly image/version/status for an app.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'], additionalProperties: false }
  },
  {
    name: 'fly_deploy', title: 'Fly deploy', description: 'Deploy an allowlisted Fly app from its allowlisted GitHub repo.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', enum: Object.keys(repoConfigs), description: 'Allowlisted Fly app name.' } }, required: ['app'], additionalProperties: false }
  },
  {
    name: 'fly_restart', title: 'Fly restart', description: 'Restart machines for an allowlisted Fly app.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'Fly app name, such as funkyouai' } }, required: ['app'], additionalProperties: false }
  },
  {
    name: 'fly_list_secret_names', title: 'Fly list secret names', description: 'List Fly secret names only; values are not returned.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'], additionalProperties: false }
  },
  {
    name: 'fly_set_secret', title: 'Fly set secret', description: 'Set a Fly secret for an allowlisted app. Secret value is never returned.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' }, name: { type: 'string' }, value: { type: 'string' } }, required: ['app', 'name', 'value'], additionalProperties: false }
  },
  {
    name: 'repo_run_script', title: 'Run repo npm script', description: 'Clone an allowlisted repo and run an allowlisted npm script.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', enum: Object.keys(repoConfigs) }, script: { type: 'string', enum: [...allowedNpmScripts] } }, required: ['app', 'script'], additionalProperties: false }
  },
  {
    name: 'repo_file_search', title: 'Repo file search', description: 'Clone an allowlisted repo and search text files for a string.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', enum: Object.keys(repoConfigs) }, query: { type: 'string' }, maxResults: { type: 'number' }, caseSensitive: { type: 'boolean' } }, required: ['app', 'query'], additionalProperties: false }
  },
  {
    name: 'repo_fetch_file', title: 'Repo fetch file', description: 'Clone an allowlisted repo and return one text file by relative path.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', enum: Object.keys(repoConfigs) }, path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['app', 'path'], additionalProperties: false }
  },
  {
    name: 'github_latest_commit', title: 'GitHub latest commit', description: 'Return latest commit sha/message from an allowlisted repo branch.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', enum: Object.keys(repoConfigs) } }, required: ['app'], additionalProperties: false }
  },
  {
    name: 'github_update_file', title: 'GitHub update file', description: 'Commit a file update directly to an allowlisted repo branch.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', enum: Object.keys(repoConfigs) }, path: { type: 'string' }, content: { type: 'string' }, message: { type: 'string' }, branch: { type: 'string' } }, required: ['app', 'path', 'content', 'message'], additionalProperties: false }
  },
  {
    name: 'github_create_pr', title: 'GitHub create PR', description: 'Create a branch, commit one file change, push it, and open a GitHub PR.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', enum: Object.keys(repoConfigs) }, path: { type: 'string' }, content: { type: 'string' }, branch: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, message: { type: 'string' } }, required: ['app', 'path', 'content', 'branch', 'title', 'message'], additionalProperties: false }
  },
  {
    name: 'discord_bot_ping', title: 'Discord bot ping', description: 'Use DISCORD_TOKEN/DISCORD_BOT_TOKEN, if configured, to ask Discord who the bot token belongs to.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

function sendTool(res, id, result) {
  return res.json(jsonRpc(id, result));
}

app.use(cors({
  origin: ['https://chatgpt.com', 'https://chat.openai.com'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version'],
  methods: ['GET', 'POST', 'OPTIONS']
}));
app.use(express.json({ limit: '6mb' }));

app.get('/', (req, res) => {
  res.json({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    status: 'running',
    writeToolsEnabled,
    allowAnySecretName,
    allowedApps,
    allowedNpmScripts: [...allowedNpmScripts],
    allowedSecretNames: allowAnySecretName ? ['*'] : [...allowedSecretNames],
    tools: tools.map(tool => tool.name)
  });
});

app.post('/', async (req, res) => {
  const { jsonrpc, method, params = {}, id } = req.body || {};
  if (jsonrpc !== '2.0') return res.json(jsonRpcError(id ?? null, -32600, 'Expected JSON-RPC 2.0 request.'));

  if (method === 'initialize') {
    return res.json(jsonRpc(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, title: 'FunkYou Dev Helper', version: SERVER_VERSION }
    }));
  }

  if (method === 'initialized') return res.status(200).end();
  if (method === 'tools/list') return res.json(jsonRpc(id, { tools }));

  if (method === 'resources/list') {
    const resources = resourcesMap();
    return res.json(jsonRpc(id, {
      resources: [...resources.values()].map(item => ({ uri: item.id, name: item.title, description: item.text.slice(0, 120) })),
      nextCursor: null
    }));
  }

  if (method !== 'tools/call') return res.json(jsonRpcError(id, -32601, `Unknown method: ${method}`));

  const name = params.name;
  const args = params.arguments || {};

  try {
    if (name === 'search') {
      const results = searchResources(args.query).map(item => ({ id: item.id, title: item.title, text: item.text.slice(0, 800) }));
      return sendTool(res, id, toolText(JSON.stringify(results, null, 2)));
    }

    if (name === 'fetch') {
      const item = resourcesMap().get(String(args.id || '').trim());
      if (!item) return sendTool(res, id, toolError(`Unknown resource id: ${args.id}`));
      return sendTool(res, id, toolText(JSON.stringify(item, null, 2)));
    }

    if (name === 'fly_status') {
      const allowed = assertAllowedApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      return sendTool(res, id, runFly(['status', '--app', allowed.app]));
    }

    if (name === 'fly_logs') {
      const allowed = assertAllowedApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      return sendTool(res, id, runFly(['logs', '--app', allowed.app, '--no-tail'], 25000));
    }

    if (name === 'fly_recent_errors') {
      const allowed = assertAllowedApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      const logs = getLogs(allowed.app);
      return sendTool(res, id, toolJson({ app: allowed.app, matches: recentErrorLines(logs, args.limit), scanned: 'recent fly logs' }));
    }

    if (name === 'fly_boot_summary') {
      const allowed = assertAllowedApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      const logs = getLogs(allowed.app);
      return sendTool(res, id, toolJson({ app: allowed.app, ...summarizeBootLogs(logs) }));
    }

    if (name === 'bot_health_check') {
      const allowed = assertAllowedApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      const status = getStatus(allowed.app, false);
      const logs = getLogs(allowed.app);
      const boot = summarizeBootLogs(logs);
      const errors = recentErrorLines(logs, 30);
      return sendTool(res, id, toolJson({
        app: allowed.app,
        flyStatusOk: status.ok,
        flyStatus: status.stdout || status.stderr || status.error,
        loggedIntoDiscord: boot.loggedIn,
        sdkFirstBoot: boot.sdkFirstBoot,
        memberItemBetaOn: boot.memberItemBetaOn,
        serialsApiOff: boot.serialsApiOff,
        githubLogsMisconfigured: boot.githubLogsMisconfigured,
        recentErrorCount: errors.length,
        recentErrors: errors.slice(-20),
        recentBootLines: boot.recentBootLines.slice(-40)
      }, !status.ok));
    }

    if (name === 'fly_current_image') {
      const allowed = assertAllowedApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      const jsonStatus = getStatus(allowed.app, true);
      const parsed = parseJsonMaybe(jsonStatus.stdout);
      if (jsonStatus.ok && parsed) return sendTool(res, id, toolJson({ app: allowed.app, status: parsed }));
      const textStatus = getStatus(allowed.app, false);
      const imageLine = String(textStatus.stdout).split(/\r?\n/).find(line => /Image/i.test(line)) || '';
      const versionLine = String(textStatus.stdout).split(/\r?\n/).find(line => /VERSION|started|stopped/i.test(line)) || '';
      return sendTool(res, id, toolJson({ app: allowed.app, imageLine, versionLine, rawStatus: textStatus.stdout || textStatus.stderr || textStatus.error }, !textStatus.ok));
    }

    if (name === 'fly_restart') {
      const write = assertWriteToolsEnabled();
      if (!write.ok) return sendTool(res, id, toolError(write.error));
      const allowed = assertAllowedApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      return sendTool(res, id, runFly(['machine', 'restart', '--app', allowed.app], 180000));
    }

    if (name === 'fly_deploy') {
      const write = assertWriteToolsEnabled();
      if (!write.ok) return sendTool(res, id, toolError(write.error));
      if (!flyToken()) return sendTool(res, id, toolError('Neither FLY_API_TOKEN nor FLY_ACCESS_TOKEN is configured on this MCP server.'));
      const allowed = assertAllowedRepoApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      let tempDir = '';
      try {
        const cloned = cloneRepo(allowed.config);
        tempDir = cloned.tempDir;
        const deployed = runCommand('flyctl', ['deploy', '-a', allowed.config.app, '--remote-only'], { cwd: cloned.repoDir, timeoutMs: 1000 * 60 * 12, maxBuffer: 1024 * 1024 * 20 });
        return sendTool(res, id, toolJson({ ok: deployed.ok, app: allowed.config.app, repo: redactedRepoUrl(allowed.config.repo), branch: allowed.config.branch, stdout: deployed.stdout, stderr: deployed.stderr, error: deployed.error }, !deployed.ok));
      } finally { cleanupTemp(tempDir); }
    }

    if (name === 'fly_list_secret_names') {
      const allowed = assertAllowedApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      const result = runFlyRaw(['secrets', 'list', '--app', allowed.app], 30000);
      return sendTool(res, id, toolJson({ ok: result.ok, app: allowed.app, note: 'Fly returns secret names only, not values.', output: result.stdout || result.stderr || result.error }, !result.ok));
    }

    if (name === 'fly_set_secret') {
      const write = assertWriteToolsEnabled();
      if (!write.ok) return sendTool(res, id, toolError(write.error));
      const allowed = assertAllowedApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      const secretName = String(args.name || '').trim();
      if (!/^[A-Z0-9_]+$/.test(secretName)) return sendTool(res, id, toolError('Secret name must contain only A-Z, 0-9, and underscore.'));
      if (!allowAnySecretName && !allowedSecretNames.has(secretName)) return sendTool(res, id, toolError(`Secret '${secretName}' is not allowlisted. Set ALLOW_ANY_SECRET_NAME=true or add it to ALLOWED_SECRET_NAMES.`));
      const value = String(args.value || '');
      const result = runFlyRaw(['secrets', 'set', `${secretName}=${value}`, '--app', allowed.app], 180000);
      return sendTool(res, id, toolJson({ ok: result.ok, app: allowed.app, name: secretName, stdout: redactSecretText(result.stdout), stderr: redactSecretText(result.stderr), error: redactSecretText(result.error), valueReturned: false }, !result.ok));
    }

    if (name === 'repo_run_script') {
      const allowed = assertAllowedRepoApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      const script = String(args.script || '').trim();
      if (!allowedNpmScripts.has(script)) return sendTool(res, id, toolError(`Script '${script}' is not allowlisted. Allowed scripts: ${[...allowedNpmScripts].join(', ')}`));
      let tempDir = '';
      try {
        const cloned = cloneRepo(allowed.config);
        tempDir = cloned.tempDir;
        const installed = installRepoDependencies(cloned.repoDir);
        if (!installed.ok) return sendTool(res, id, toolJson({ ok: false, app: allowed.config.app, step: 'install dependencies', stdout: installed.stdout, stderr: installed.stderr, error: installed.error }, true));
        const checked = runCommand('npm', ['run', script], { cwd: cloned.repoDir, timeoutMs: 1000 * 60 * 5, maxBuffer: 1024 * 1024 * 10 });
        return sendTool(res, id, toolJson({ ok: checked.ok, app: allowed.config.app, repo: redactedRepoUrl(allowed.config.repo), branch: allowed.config.branch, script, stdout: checked.stdout, stderr: checked.stderr, error: checked.error }, !checked.ok));
      } finally { cleanupTemp(tempDir); }
    }

    if (name === 'repo_file_search') {
      const allowed = assertAllowedRepoApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      let tempDir = '';
      try {
        const cloned = cloneRepo(allowed.config);
        tempDir = cloned.tempDir;
        const results = searchFiles(cloned.repoDir, args.query, { maxResults: args.maxResults || 50, caseSensitive: Boolean(args.caseSensitive) });
        return sendTool(res, id, toolJson({ app: allowed.config.app, query: args.query, count: results.length, results }));
      } finally { cleanupTemp(tempDir); }
    }

    if (name === 'repo_fetch_file') {
      const allowed = assertAllowedRepoApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      const safePath = assertRelativePath(args.path);
      if (!safePath.ok) return sendTool(res, id, toolError(safePath.error));
      let tempDir = '';
      try {
        const cloned = cloneRepo(allowed.config);
        tempDir = cloned.tempDir;
        const absolute = path.join(cloned.repoDir, safePath.filePath);
        if (!absolute.startsWith(cloned.repoDir)) return sendTool(res, id, toolError('Resolved file path escaped repo root.'));
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return sendTool(res, id, toolError(`File not found: ${safePath.filePath}`));
        const stat = fs.statSync(absolute);
        if (stat.size > 1024 * 1024 * 2) return sendTool(res, id, toolError('File is larger than 2MB; refusing to return it through the connector.'));
        const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
        const start = Math.max(1, Number(args.startLine) || 1);
        const end = Math.min(lines.length, Number(args.endLine) || Math.min(lines.length, start + 300));
        return sendTool(res, id, toolJson({ app: allowed.config.app, path: safePath.filePath, startLine: start, endLine: end, totalLines: lines.length, content: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n') }));
      } finally { cleanupTemp(tempDir); }
    }

    if (name === 'github_latest_commit') {
      const allowed = assertAllowedRepoApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      let tempDir = '';
      try {
        const cloned = cloneRepo(allowed.config);
        tempDir = cloned.tempDir;
        const log = runCommand('git', ['log', '-1', '--pretty=format:%H%n%an%n%ae%n%ad%n%s'], { cwd: cloned.repoDir });
        const [sha, authorName, authorEmail, date, ...messageParts] = String(log.stdout || '').split('\n');
        return sendTool(res, id, toolJson({ ok: log.ok, app: allowed.config.app, repo: redactedRepoUrl(allowed.config.repo), branch: allowed.config.branch, sha, authorName, authorEmail, date, message: messageParts.join('\n'), stderr: log.stderr, error: log.error }, !log.ok));
      } finally { cleanupTemp(tempDir); }
    }

    if (name === 'github_update_file') {
      const write = assertWriteToolsEnabled();
      if (!write.ok) return sendTool(res, id, toolError(write.error));
      if (!githubToken()) return sendTool(res, id, toolError('GITHUB_TOKEN or GH_TOKEN is required for github_update_file.'));
      const allowed = assertAllowedRepoApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      const safePath = assertRelativePath(args.path);
      if (!safePath.ok) return sendTool(res, id, toolError(safePath.error));
      const branch = String(args.branch || allowed.config.branch || 'main').trim();
      let tempDir = '';
      try {
        const cloned = cloneRepo(allowed.config, { depth: '', branch });
        tempDir = cloned.tempDir;
        runCommand('git', ['config', 'user.email', process.env.GIT_COMMIT_EMAIL || 'funkyou-dev-helper@example.com'], { cwd: cloned.repoDir });
        runCommand('git', ['config', 'user.name', process.env.GIT_COMMIT_NAME || 'FunkYou Dev Helper'], { cwd: cloned.repoDir });
        const absolute = path.join(cloned.repoDir, safePath.filePath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, String(args.content ?? ''), 'utf8');
        const add = runCommand('git', ['add', safePath.filePath], { cwd: cloned.repoDir });
        if (!add.ok) return sendTool(res, id, toolJson({ ok: false, step: 'git add', ...add }, true));
        const commit = runCommand('git', ['commit', '-m', String(args.message || 'Update file via FunkYou Dev Helper')], { cwd: cloned.repoDir });
        if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) return sendTool(res, id, toolJson({ ok: false, step: 'git commit', ...commit }, true));
        const push = runCommand('git', ['push', 'origin', branch], { cwd: cloned.repoDir, timeoutMs: 120000 });
        return sendTool(res, id, toolJson({ ok: push.ok, app: allowed.config.app, branch, path: safePath.filePath, commit: commit.stdout || commit.stderr, push: push.stdout || push.stderr, error: push.error }, !push.ok));
      } finally { cleanupTemp(tempDir); }
    }

    if (name === 'github_create_pr') {
      const write = assertWriteToolsEnabled();
      if (!write.ok) return sendTool(res, id, toolError(write.error));
      if (!githubToken()) return sendTool(res, id, toolError('GITHUB_TOKEN or GH_TOKEN is required for github_create_pr.'));
      const allowed = assertAllowedRepoApp(args.app);
      if (!allowed.ok) return sendTool(res, id, toolError(allowed.error));
      const safePath = assertRelativePath(args.path);
      if (!safePath.ok) return sendTool(res, id, toolError(safePath.error));
      const branch = String(args.branch || '').trim();
      if (!branch || branch === allowed.config.branch) return sendTool(res, id, toolError('Provide a new branch name different from the base branch.'));
      let tempDir = '';
      try {
        const cloned = cloneRepo(allowed.config, { depth: '', branch: allowed.config.branch });
        tempDir = cloned.tempDir;
        runCommand('git', ['config', 'user.email', process.env.GIT_COMMIT_EMAIL || 'funkyou-dev-helper@example.com'], { cwd: cloned.repoDir });
        runCommand('git', ['config', 'user.name', process.env.GIT_COMMIT_NAME || 'FunkYou Dev Helper'], { cwd: cloned.repoDir });
        const checkout = runCommand('git', ['checkout', '-b', branch], { cwd: cloned.repoDir });
        if (!checkout.ok) return sendTool(res, id, toolJson({ ok: false, step: 'git checkout', ...checkout }, true));
        const absolute = path.join(cloned.repoDir, safePath.filePath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, String(args.content ?? ''), 'utf8');
        const add = runCommand('git', ['add', safePath.filePath], { cwd: cloned.repoDir });
        if (!add.ok) return sendTool(res, id, toolJson({ ok: false, step: 'git add', ...add }, true));
        const commit = runCommand('git', ['commit', '-m', String(args.message || args.title || 'Update file via FunkYou Dev Helper')], { cwd: cloned.repoDir });
        if (!commit.ok) return sendTool(res, id, toolJson({ ok: false, step: 'git commit', ...commit }, true));
        const push = runCommand('git', ['push', '-u', 'origin', branch], { cwd: cloned.repoDir, timeoutMs: 120000 });
        if (!push.ok) return sendTool(res, id, toolJson({ ok: false, step: 'git push', ...push }, true));
        const pr = await createGitHubPullRequest(allowed.config, { title: String(args.title), body: String(args.body || ''), head: branch, base: allowed.config.branch });
        return sendTool(res, id, toolJson({ ok: true, app: allowed.config.app, branch, path: safePath.filePath, pullRequest: { number: pr.number, title: pr.title, url: pr.html_url } }));
      } finally { cleanupTemp(tempDir); }
    }

    if (name === 'discord_bot_ping') {
      const token = discordToken();
      if (!token) return sendTool(res, id, toolError('DISCORD_TOKEN or DISCORD_BOT_TOKEN is not configured on the helper app.'));
      const response = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${token}` } });
      const text = await response.text();
      const json = parseJsonMaybe(text);
      return sendTool(res, id, toolJson({ ok: response.ok, status: response.status, bot: response.ok ? { id: json?.id, username: json?.username, discriminator: json?.discriminator, bot: json?.bot } : null, error: response.ok ? '' : text }, !response.ok));
    }

    return res.json(jsonRpcError(id, -32601, `Unknown tool: ${name}`));
  } catch (err) {
    return sendTool(res, id, toolJson({ ok: false, error: redactSecretText(String(err.message || err)) }, true));
  }
});

app.listen(PORT, () => {
  console.log(`${SERVER_NAME} v${SERVER_VERSION} listening on ${PORT}`);
});
