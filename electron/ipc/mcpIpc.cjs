'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createMcpClient, validateServerConfig, isSafeHttpUrl } = require('../mcp-client.cjs');

const MCP_MAX_SERVERS = 20;
const MCP_NAME_MAX = 120;
const MCP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MCP_ARGS_PREVIEW_MAX = 1500;

function truncateMcpText(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n... truncated ...` : text;
}

function registerMcpHandlers({ app, dialog, ipcMain, safeStorage, assertTrustedRenderer, getMainWindow }) {
  const mcpClients = new Map();
  const mcpConsentHashes = new Set();

  const mcpServersPath = () => path.join(app.getPath('userData'), 'mcp-servers.json');

  function readMcpServerRecords() {
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpServersPath(), 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((record) => record && typeof record === 'object' && !Array.isArray(record) && typeof record.id === 'string')
        .slice(0, MCP_MAX_SERVERS);
    } catch {
      return [];
    }
  }

  function writeMcpServerRecords(records) {
    const file = mcpServersPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(records.slice(0, MCP_MAX_SERVERS)), { encoding: 'utf8', mode: 0o600 });
  }

  function decryptMcpValue(entry) {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object' || typeof entry.cipher !== 'string') return '';
    if (!safeStorage.isEncryptionAvailable()) return '';
    try {
      return safeStorage.decryptString(Buffer.from(entry.cipher, 'base64'));
    } catch {
      return '';
    }
  }

  function decryptMcpMap(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    for (const [key, entry] of Object.entries(value)) result[key] = decryptMcpValue(entry);
    return result;
  }

  function encryptMcpMap(value) {
    const result = {};
    const available = safeStorage.isEncryptionAvailable();
    for (const [key, entry] of Object.entries(value || {})) {
      result[key] = available && entry
        ? { cipher: safeStorage.encryptString(entry).toString('base64') }
        : '';
    }
    return result;
  }

  function mcpRecordToConfig(record, index, includeSecrets = false) {
    const transport = record.transport === 'http' ? 'http' : 'stdio';
    const config = {
      id: typeof record.id === 'string' ? record.id : `server-${index}`,
      name: typeof record.name === 'string' ? record.name.slice(0, MCP_NAME_MAX) : '',
      transport,
      enabled: record.enabled !== false
    };
    if (transport === 'stdio') {
      config.command = typeof record.command === 'string' ? record.command : '';
      config.args = Array.isArray(record.args) ? record.args.filter((arg) => typeof arg === 'string') : [];
      const env = includeSecrets ? decryptMcpMap(record.env) : {};
      if (!includeSecrets) {
        for (const key of Object.keys(record.env || {})) env[key] = '';
      }
      config.env = env;
    } else {
      config.url = typeof record.url === 'string' ? record.url : '';
      const headers = includeSecrets ? decryptMcpMap(record.headers) : {};
      if (!includeSecrets) {
        for (const key of Object.keys(record.headers || {})) headers[key] = '';
      }
      config.headers = headers;
    }
    return config;
  }

  function listMcpServerConfigs() {
    return readMcpServerRecords().map((record, index) => mcpRecordToConfig(record, index));
  }

  function findMcpServerConfig(id) {
    if (typeof id !== 'string') return null;
    const records = readMcpServerRecords();
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return null;
    return mcpRecordToConfig(records[index], index, true);
  }

  function closeMcpClient(id) {
    const client = mcpClients.get(id);
    if (!client) return Promise.resolve(false);
    mcpClients.delete(id);
    return client.close().then(() => true, () => false);
  }

  function saveMcpServerConfig(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('An MCP server configuration is required.');
    }
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!MCP_ID_PATTERN.test(id)) {
      throw new Error('MCP server ids must be 1-64 characters of letters, digits, dots, dashes, or underscores, starting with a letter or digit.');
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > MCP_NAME_MAX) {
      throw new Error(`MCP server names must be between 1 and ${MCP_NAME_MAX} characters.`);
    }
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      throw new Error('MCP server enabled must be a boolean.');
    }
    if (input.transport !== 'stdio' && input.transport !== 'http') {
      throw new Error('MCP server transport must be "stdio" or "http".');
    }
    if (input.transport === 'http' && !isSafeHttpUrl(input.url)) {
      throw new Error('MCP HTTP servers need an absolute http(s) URL without embedded credentials.');
    }

    const records = readMcpServerRecords();
    const existingIndex = records.findIndex((record) => record.id === id);
    const previous = existingIndex >= 0 ? records[existingIndex] : null;

    const mergeSecrets = (values, encrypted) => {
      const merged = { ...(values || {}) };
      for (const [key, value] of Object.entries(merged)) {
        if (value === '' && encrypted && encrypted[key]) {
          const stored = decryptMcpValue(encrypted[key]);
          if (stored) merged[key] = stored;
        }
      }
      return merged;
    };

    const normalized = validateServerConfig({
      name,
      transport: input.transport,
      command: input.command,
      args: input.args,
      env: mergeSecrets(input.env, previous?.env),
      url: input.url,
      headers: mergeSecrets(input.headers, previous?.headers)
    });
    const secretValues = normalized.transport === 'stdio'
      ? Object.values(normalized.env).filter(Boolean)
      : Object.values(normalized.headers).filter(Boolean);
    if (secretValues.length > 0 && !safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'Secure storage is unavailable on this system, so ShadRox cannot save MCP environment variables or header ' +
        'values. Remove them and save the server again once OS encryption is available.'
      );
    }

    if (existingIndex === -1 && records.length >= MCP_MAX_SERVERS) {
      throw new Error(`ShadRox supports at most ${MCP_MAX_SERVERS} MCP servers. Delete one before adding another.`);
    }

    const record = { id, name: normalized.name || name, transport: normalized.transport, enabled: input.enabled !== false };
    if (normalized.transport === 'stdio') {
      record.command = normalized.command;
      record.args = normalized.args;
      record.env = encryptMcpMap(normalized.env);
    } else {
      record.url = normalized.url;
      record.headers = encryptMcpMap(normalized.headers);
    }
    if (existingIndex === -1) records.push(record);
    else records[existingIndex] = record;
    writeMcpServerRecords(records);

    void closeMcpClient(id);
    return listMcpServerConfigs();
  }

  function stringifyToolArguments(toolArguments) {
    let text;
    try {
      text = JSON.stringify(toolArguments ?? {}, null, 2);
    } catch {
      text = String(toolArguments);
    }
    return truncateMcpText(text || '{}', MCP_ARGS_PREVIEW_MAX);
  }

  async function approveMcpToolCall(server, toolName, toolArguments) {
    const detail = truncateMcpText([
      `Server: ${server.name} (${server.id})`,
      `Tool: ${toolName}`,
      `Arguments: ${stringifyToolArguments(toolArguments)}`,
      'MCP tools run with the permissions of the configured server and can read workspace data or perform actions.'
    ].join('\n\n'), 2200);
    const confirmation = await dialog.showMessageBox(getMainWindow(), {
      type: 'warning',
      title: 'Allow MCP tool call?',
      message: `Allow "${toolName}" on ${server.name}?`,
      detail,
      buttons: ['Cancel', 'Allow tool call'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    return confirmation.response === 1;
  }

  function getMcpClient(server) {
    const existing = mcpClients.get(server.id);
    if (existing) return existing;
    const client = createMcpClient({
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      url: server.url,
      headers: server.headers,
      onApproveTool: ({ name, arguments: toolArguments }) => approveMcpToolCall(server, name, toolArguments),
      onStderr: () => {}
    });
    mcpClients.set(server.id, client);
    return client;
  }

  async function listMcpToolsFor(serverId) {
    const server = findMcpServerConfig(serverId);
    if (!server) throw new Error('That MCP server is not configured.');
    if (!server.enabled) throw new Error('That MCP server is disabled. Enable it in Settings first.');
    const client = getMcpClient(server);
    try {
      const tools = await client.listTools();
      return tools.map((tool) => ({
        serverId: server.id,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }));
    } catch (error) {
      await closeMcpClient(server.id);
      throw error;
    }
  }

  function mcpToolResultText(result, toolName) {
    const items = Array.isArray(result.content) ? result.content : [];
    const texts = items
      .filter((item) => item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text);
    if (texts.length > 0) return texts.join('\n');
    if (result.structuredContent !== undefined) {
      try {
        return JSON.stringify(result.structuredContent, null, 2);
      } catch {
        return '';
      }
    }
    return result.isError ? `The MCP tool "${toolName}" reported an error without text.` : '';
  }

  async function requireMcpConsent(server) {
    const consentKey = createHash('sha256')
      .update(JSON.stringify({
        transport: server.transport,
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        url: server.url,
        headers: server.headers,
        env: server.env
      }))
      .digest('hex');
    if (mcpConsentHashes.has(consentKey)) return;
    const targetDetail = server.transport === 'http'
      ? `URL: ${server.url}\nHeaders: ${Object.keys(server.headers || {}).join(', ') || '(none)'}`
      : `Command: ${server.command}\nArguments: ${(server.args || []).join(' ') || '(none)'}\nDirectory: ${server.cwd || '(default)'}`;
    const choice = await dialog.showMessageBox(getMainWindow(), {
      type: 'warning',
      buttons: ['Cancel', 'Connect'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Approve MCP server',
      message: server.transport === 'http'
        ? 'Allow ShadRox to connect to this MCP server?'
        : 'Allow ShadRox to start this MCP process?',
      detail: targetDetail
    });
    if (choice.response !== 1) throw new Error('MCP connection cancelled.');
    mcpConsentHashes.add(consentKey);
  }

  ipcMain.handle('mcp:list-servers', (event) => {
    assertTrustedRenderer(event);
    return listMcpServerConfigs();
  });

  ipcMain.handle('mcp:save-server', (event, server) => {
    assertTrustedRenderer(event);
    return saveMcpServerConfig(server);
  });

  ipcMain.handle('mcp:delete-server', async (event, id) => {
    assertTrustedRenderer(event);
    if (typeof id !== 'string') throw new Error('An MCP server id is required.');
    writeMcpServerRecords(readMcpServerRecords().filter((record) => record.id !== id));
    await closeMcpClient(id);
    return listMcpServerConfigs();
  });

  ipcMain.handle('mcp:connect', async (event, id) => {
    assertTrustedRenderer(event);
    const server = findMcpServerConfig(id);
    if (!server) throw new Error('That MCP server is not configured.');
    await requireMcpConsent(server);
    return listMcpToolsFor(id);
  });

  ipcMain.handle('mcp:list-tools', async (event, serverId) => {
    assertTrustedRenderer(event);
    const server = findMcpServerConfig(serverId);
    if (!server) throw new Error('That MCP server is not configured.');
    if (!server.enabled) throw new Error('That MCP server is disabled. Enable it in Settings first.');
    await requireMcpConsent(server);
    return listMcpToolsFor(serverId);
  });

  ipcMain.handle('mcp:call-tool', async (event, serverId, name, args) => {
    assertTrustedRenderer(event);
    if (typeof serverId !== 'string' || typeof name !== 'string' || !name) {
      throw new Error('An MCP server id and tool name are required.');
    }
    const toolArguments = args === undefined || args === null ? {} : args;
    if (typeof toolArguments !== 'object' || Array.isArray(toolArguments)) {
      throw new Error('MCP tool arguments must be a JSON object.');
    }
    const server = findMcpServerConfig(serverId);
    if (!server) throw new Error('That MCP server is not configured.');
    if (!server.enabled) throw new Error('That MCP server is disabled. Enable it in Settings first.');
    await requireMcpConsent(server);
    const result = await getMcpClient(server).callTool(name, toolArguments);
    return {
      isError: result.isError === true,
      text: mcpToolResultText(result, name),
      content: result.content
    };
  });

  ipcMain.handle('mcp:disconnect', async (event, id) => {
    assertTrustedRenderer(event);
    if (typeof id !== 'string') return false;
    return closeMcpClient(id);
  });

  return {
    closeAll() {
      for (const client of mcpClients.values()) void client.close();
      mcpClients.clear();
    }
  };
}

module.exports = {
  registerMcpHandlers
};
