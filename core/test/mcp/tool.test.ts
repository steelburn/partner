import { describe, expect, it } from 'vitest';
import { mcpToolExternal } from '../../src/mcp/tool.js';
import type { McpManager } from '../../src/mcp/manager.js';

function stubMcp(over: Partial<McpManager>): McpManager {
  const server = (id: string) =>
    ({
      id,
      name: id,
      transport: 'stdio',
      command: 'node',
      args: [],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    } as McpManager extends never ? never : never);
  void server;
  return {
    list: () => [
      {
        id: 'fs-box',
        name: 'fs-box',
        transport: 'stdio',
        command: 'node',
        args: [],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    get: (id: string) =>
      id === 'fs-box'
        ? {
            id: 'fs-box',
            name: 'fs-box',
            transport: 'stdio',
            command: 'node',
            args: [],
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          }
        : id === 'off-box'
          ? {
              id: 'off-box',
              name: 'off-box',
              transport: 'stdio',
              command: 'node',
              args: [],
              enabled: false,
              createdAt: 1,
              updatedAt: 1,
            }
          : null,
    create: () => {
      throw new Error('n/a');
    },
    update: () => {
      throw new Error('n/a');
    },
    remove: () => undefined,
    listTools: async () => [],
    call: async (id: string, input: { tool: string; args?: Record<string, unknown>; timeoutMs?: number }) => ({
      content: [{ type: 'text', text: `ran ${input.tool} on ${id}` }],
      isError: false,
      ms: 1,
    }),
    ...over,
  };
}

describe('M11 F2 MCP chat tool', () => {
  it('is absent when no MCP manager is wired', () => {
    expect(mcpToolExternal(undefined)).toBeUndefined();
  });

  it('allow/match gate on the ENABLED server only (default deny)', () => {
    const external = mcpToolExternal(stubMcp({}));
    expect(external?.allow('mcp:fs-box/read')).toBe(true);
    expect(external?.match?.('mcp:fs-box/read')?.risk).toBe('medium');
    expect(external?.allow('mcp:off-box/read')).toBe(false);
    expect(external?.allow('search')).toBe(false);
    expect(external?.match?.('files.read')).toBeUndefined();
  });

  it('exec calls the MCP manager and flattens text output', async () => {
    const external = mcpToolExternal(stubMcp({}));
    const response = await external?.exec('mcp:fs-box/list', { dir: '/' });
    expect(response).toMatchObject({ outcome: 'executed' });
    if (response?.outcome === 'executed') {
      expect(String(response.result.output_1)).toContain('ran list on fs-box');
      expect(String(response.result.tool)).toBe('list');
    }
  });

  it('denies unknown formats, disabled servers, and empty output', async () => {
    const external = mcpToolExternal(stubMcp({}));
    expect(await external?.exec('search', {})).toMatchObject({ outcome: 'denied', reason: 'unknown_tool' });
    expect(await external?.exec('mcp:off-box/read', {})).toMatchObject({ outcome: 'denied', reason: 'disabled' });
    const empty = mcpToolExternal(stubMcp({ call: async () => ({ content: [], isError: false, ms: 1 }) }));
    expect(await empty?.exec('mcp:fs-box/read', {})).toMatchObject({ outcome: 'denied', reason: 'empty_result' });
  });
});
