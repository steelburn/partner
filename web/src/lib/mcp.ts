/**
 * M11 F2 MCP API client (PLAN-M11.md — slice 2). stdio server config is
 * default-deny (OFF until enabled); tools/list + call are user-initiated.
 */
import { ApiRequestError, expectJson, expectNoContent, type FetchLike } from './api.js';
import type { McpCallResult, McpServerInput, McpServerSummary, McpServerUpdate, McpToolInfo } from '@partner/shared';

export type { FetchLike };

const BASE = '/v1/mcp/servers';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseServer(value: unknown, status = 200): McpServerSummary {
  if (isRecord(value) && typeof value.id === 'string') {
    return value as unknown as McpServerSummary;
  }
  throw new ApiRequestError(status, 'The MCP server response had an unexpected shape.');
}

function parseServerList(value: unknown, status = 200): McpServerSummary[] {
  if (Array.isArray(value)) return value as McpServerSummary[];
  if (isRecord(value) && Array.isArray(value.servers)) return value.servers as unknown as McpServerSummary[];
  throw new ApiRequestError(status, 'The MCP servers response had an unexpected shape.');
}

export async function listMcpServers(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<McpServerSummary[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(BASE, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseServerList(await expectJson<unknown>(response), response.status);
}

export async function createMcpServer(
  token: string,
  input: McpServerInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<McpServerSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(BASE, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return parseServer(await expectJson<unknown>(response), response.status);
}

export async function updateMcpServer(
  token: string,
  id: string,
  patch: McpServerUpdate,
  options: { fetchImpl?: FetchLike } = {},
): Promise<McpServerSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(patch),
  });
  return parseServer(await expectJson<unknown>(response), response.status);
}

export async function deleteMcpServer(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return expectNoContent(response, 'Deleting the MCP server');
}

export async function listMcpTools(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<McpToolInfo[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${BASE}/${encodeURIComponent(id)}/tools`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const body: unknown = await expectJson<unknown>(response);
  if (isRecord(body) && Array.isArray(body.tools)) return body.tools as unknown as McpToolInfo[];
  throw new ApiRequestError(response.status, 'The tools response had an unexpected shape.');
}

export async function callMcpTool(
  token: string,
  id: string,
  tool: string,
  args: Record<string, unknown> | undefined,
  options: { fetchImpl?: FetchLike } = {},
): Promise<McpCallResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${BASE}/${encodeURIComponent(id)}/call`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ tool, args: args ?? {} }),
  });
  const body: unknown = await expectJson<unknown>(response);
  if (isRecord(body) && Array.isArray(body.content)) {
    return body as unknown as McpCallResult;
  }
  throw new ApiRequestError(response.status, 'The call response had an unexpected shape.');
}
