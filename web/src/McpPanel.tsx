/**
 * M11 F2 MCP panel (PLAN-M11.md — slice 2).
 *
 * Compact server config surface under Providers: add a stdio server (name +
 * command + args), list its tools (spawns the server), enable/disable and
 * delete. Default-deny is visible: a fresh server is OFF. Token-styled.
 */
import { useEffect, useState, type FormEvent } from 'react';
import type { McpServerSummary, McpToolInfo } from '@partner/shared';
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  listMcpTools,
  updateMcpServer,
} from './lib/mcp.js';
import { readStoredToken } from './lib/token.js';

export interface McpPanelProps {
  onUnpair: () => void;
}

interface ServerView {
  server: McpServerSummary;
  tools: McpToolInfo[] | null;
  busy: boolean;
  error: string | null;
}

export function McpPanel({ onUnpair }: McpPanelProps) {
  const [servers, setServers] = useState<McpServerSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [views, setViews] = useState<Record<string, ServerView>>({});

  const load = async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    try {
      setServers(await listMcpServers(token));
      setError(null);
    } catch (cause) {
      if (cause instanceof Error && ((cause as { status?: number }).status === 401 || (cause as { status?: number }).status === 403)) {
        onUnpair();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not load MCP servers.');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchView = (id: string, patch: Partial<ServerView>): void => {
    setViews((prev) => ({ ...prev, [id]: { ...viewForSafe(id), ...patch } }));
  };

  const viewForSafe = (id: string): ServerView => {
    const found = servers?.find((s) => s.id === id);
    return views[id] ?? { server: found as McpServerSummary, tools: null, busy: false, error: null };
  };

  const add = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const parsedArgs = args
        .split(/\s+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
      await createMcpServer(token, {
        name: name.trim(),
        command: command.trim(),
        ...(parsedArgs.length > 0 ? { args: parsedArgs } : {}),
      });
      setName('');
      setCommand('');
      setArgs('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add the MCP server.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (server: McpServerSummary): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    setError(null);
    try {
      await updateMcpServer(token, server.id, { name: server.name, command: server.command, args: server.args, enabled: !server.enabled });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the server.');
    }
  };

  const showTools = async (server: McpServerSummary): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    const view = viewForSafe(server.id);
    if (view.tools !== null || view.busy) {
      patchView(server.id, { tools: null, error: null });
      return;
    }
    patchView(server.id, { busy: true, error: null });
    try {
      const tools = await listMcpTools(token, server.id);
      patchView(server.id, { tools, busy: false });
    } catch (cause) {
      patchView(server.id, {
        busy: false,
        error: cause instanceof Error ? cause.message : 'Could not list tools.',
      });
    }
  };

  const removeServer = async (id: string): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    try {
      await deleteMcpServer(token, id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete the server.');
    }
  };

  return (
    <section className="card add-card" aria-label="MCP servers">
      <h2 className="card-title">MCP servers</h2>
      <p className="card-copy">
        Model Context Protocol servers Partner can call as tools. Each server is OFF until you
        enable it — enable only servers you trust; their tools run on this machine.
      </p>

      {error !== null ? (
        <p className="chat-attach-error" role="alert">
          {error}
        </p>
      ) : null}

      {servers === null ? (
        <p className="providers-loading" aria-busy="true">
          Loading MCP servers…
        </p>
      ) : servers.length === 0 ? (
        <p className="providers-loading">No MCP servers configured yet.</p>
      ) : (
        <ul className="mcp-server-list" role="list">
          {servers.map((server) => {
            const view = viewForSafe(server.id);
            return (
              <li key={server.id} className="mcp-server-row">
                <div className="mcp-server-head">
                  <span className="mcp-server-name">{server.name}</span>
                  <span className="source-badge">{server.enabled ? 'Enabled' : 'Off'}</span>
                  <span className="mcp-server-cmd" title={`${server.command} ${server.args.join(' ')}`}>
                    {server.command} {server.args.join(' ')}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void toggle(server)}
                  >
                    {server.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void showTools(server)}
                    aria-busy={view.busy}
                  >
                    {view.tools !== null ? 'Hide tools' : view.busy ? 'Listing…' : 'Tools'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm btn-danger"
                    onClick={() => void removeServer(server.id)}
                  >
                    Remove
                  </button>
                </div>
                {view.error !== null ? (
                  <p className="chat-attach-error" role="alert">
                    {view.error}
                  </p>
                ) : null}
                {view.tools !== null ? (
                  <ul className="mcp-tool-list" role="list">
                    {view.tools.length === 0 ? (
                      <li className="rail-note">This server declares no tools.</li>
                    ) : (
                      view.tools.map((tool) => (
                        <li key={tool.name} className="mcp-tool-row">
                          <span className="mcp-tool-name">{tool.name}</span>
                          {tool.description ? (
                            <span className="mcp-tool-desc">{tool.description}</span>
                          ) : null}
                        </li>
                      ))
                    )}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <form className="form-stack mcp-add-form" onSubmit={(event) => void add(event)}>
        <div className="form-row">
          <div className="form-field">
            <label className="label" htmlFor="mcp-name">
              Name
            </label>
            <input
              id="mcp-name"
              className="field"
              type="text"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              placeholder="local files"
              aria-required="true"
            />
          </div>
          <div className="form-field mcp-command-field">
            <label className="label" htmlFor="mcp-command">
              Command
            </label>
            <input
              id="mcp-command"
              className="field"
              type="text"
              value={command}
              disabled={busy}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="/usr/bin/npx or npx.cmd"
              aria-required="true"
            />
          </div>
        </div>
        <div className="form-field">
          <label className="label" htmlFor="mcp-args">
            Args (space-separated)
          </label>
          <input
            id="mcp-args"
            className="field"
            type="text"
            value={args}
            disabled={busy}
            onChange={(event) => setArgs(event.target.value)}
            placeholder="-y @modelcontextprotocol/server-filesystem /path/to/allow"
          />
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Adding…' : 'Add server'}
          </button>
        </div>
      </form>
    </section>
  );
}
