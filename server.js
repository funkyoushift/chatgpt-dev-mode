import express from 'express';
import cors from 'cors';
import { spawnSync } from 'node:child_process';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const SERVER_NAME = 'funkyou-dev-helper';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2025-06-18';

const allowedApps = String(process.env.FLY_ALLOWED_APPS || 'funkyouai')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

const resources = new Map([
  ['fly-status', {
    id: 'fly-status',
    title: 'Fly app status helper',
    text: 'Use fly_status with an allowed app name to inspect Fly machine state. Default allowlist: funkyouai.'
  }],
  ['fly-logs', {
    id: 'fly-logs',
    title: 'Fly logs helper',
    text: 'Use fly_logs with an allowed app name to read recent Fly logs. Logs may include app output; never paste secrets into Discord or logs.'
  }],
  ['funkyouai-deploy-checklist', {
    id: 'funkyouai-deploy-checklist',
    title: 'FunkYouAI deploy checklist',
    text: [
      '1. node --check src/bl4/sdk-session-runner.js',
      '2. git diff --check',
      '3. git add .',
      '4. git commit -m "message"',
      '5. git pull --rebase',
      '6. git push',
      '7. confirm GitHub Actions is green',
      '8. fly status --app funkyouai',
      '9. fly logs --app funkyouai'
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

function toolError(text) {
  return { content: [{ type: 'text', text: String(text || '') }], isError: true };
}

function assertAllowedApp(app) {
  const cleaned = String(app || '').trim();
  if (!cleaned) return { ok: false, error: 'Missing app name.' };
  if (!allowedApps.includes(cleaned)) {
    return { ok: false, error: `App '${cleaned}' is not allowlisted. Allowed apps: ${allowedApps.join(', ') || '(none)'}` };
  }
  return { ok: true, app: cleaned };
}

function runFly(args, timeoutMs = 15000) {
  if (!process.env.FLY_API_TOKEN) {
    return toolError('FLY_API_TOKEN is not configured on this MCP server. Add it as a Fly secret before using Fly helpers.');
  }

  const result = spawnSync('flyctl', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  });

  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();

  if (result.error) return toolError(`flyctl error: ${result.error.message}`);
  if (result.status !== 0) return toolError(stderr || stdout || `flyctl exited with ${result.status}`);
  return toolText(stdout || '(flyctl returned no output)');
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
      properties: {
        app: { type: 'string', description: 'Fly app name, such as funkyouai' }
      },
      required: ['app'],
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

    return res.json(jsonRpcError(id, -32601, `Unknown tool: ${name}`));
  }

  return res.json(jsonRpcError(id, -32601, `Unknown method: ${method}`));
});

app.listen(PORT, () => {
  console.log(`${SERVER_NAME} listening on ${PORT}`);
});
