# singleton-mcp-proxy

Cross-platform stdio MCP bridge for OpenCode and similar clients. It connects each local stdio client to one shared HTTP MCP endpoint. If the endpoint is down, a detached local supervisor starts the configured server command and waits for its TCP port. Multiple bridge processes use the same per-configuration supervisor lock.

## Default: browser-search-mcp

```jsonc
{
  "mcp": {
    "browser-search-shared": {
      "type": "local",
      "command": ["npx", "-y", "singleton-mcp-proxy"],
      "enabled": true,
      "timeout": 1800000,
      "environment": {
        "SINGLETON_MCP_URL": "http://127.0.0.1:8892/mcp",
        "SINGLETON_MCP_TRANSPORT": "stream",
        "SINGLETON_MCP_COMMAND": "[\"npx.cmd\",\"-y\",\"browser-search-mcp\"]"
      }
    }
  }
}
```

For a config shared between Windows and POSIX, set `SINGLETON_MCP_COMMAND` per platform: Windows uses `npx.cmd`; Linux/macOS use `npx`. If your OpenCode version calls this property `env` instead of `environment`, use the property supported by that installed version.

The package defaults to `http://127.0.0.1:8892/mcp`, Streamable HTTP, and `npx -y browser-search-mcp`. The endpoint is probed at the TCP level; this confirms the port is listening, not that the remote MCP handshake has completed.

## Configuration

- `SINGLETON_MCP_URL`: full MCP endpoint URL; default `http://127.0.0.1:8892/mcp`.
- `SINGLETON_MCP_TRANSPORT`: `stream` (Streamable HTTP) or `sse` (legacy SSE); default `stream`.
- `SINGLETON_MCP_COMMAND`: JSON array containing executable and arguments; default is `npx -y browser-search-mcp` (Windows shim is `npx.cmd`).
- `SINGLETON_MCP_START_TIMEOUT_MS`: wait limit; default `300000`.
- `SINGLETON_MCP_RETRY_MS`: retry interval; default `1500`.
- `SINGLETON_MCP_STATE_DIR`: state/log root; default `~/.singleton-mcp-proxy`.

Logs are stored under the state directory in `server.log`.

## Important limitations

- This package intentionally does not terminate the shared server when an OpenCode process exits; other clients may still be using it. The supervisor remains running in the background.
- The supervisor restarts the configured command when the endpoint is unavailable. If a different service occupies the configured port, it will treat that TCP port as available; use a dedicated localhost port.
- This is a local-process singleton, not a distributed lock for multiple computers.
- Do not expose the endpoint to untrusted networks. Keep it bound to localhost unless you deliberately configure authentication and network security.
- `mcp-proxy` currently multiplexes client sessions over one upstream connection. Its README documents limitations for server-to-client requests such as sampling/elicitation/roots; see upstream documentation before using servers that rely on those features.
