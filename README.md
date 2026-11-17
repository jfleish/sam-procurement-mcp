# SAM Procurement MCP

Local MCP server for federal procurement research. It provides 13 tools for SAM.gov opportunities, public USAspending awards, public entity lookups, and a private local notice pipeline.

- Live SAM.gov opportunity and entity tools use your personal SAM.gov public API key.
- USAspending award tools are public and need no key.
- Demo mode uses fictional data, makes no network requests, and needs no key.
- Nothing is hosted by this project; there is no telemetry, database, or embedded AI API.

## Quick start

Requires [Node.js 20.19+](https://nodejs.org/), with Node 22 or 24 LTS recommended.

Try the complete server without credentials:

```sh
npx -y sam-procurement-mcp --demo
```

Install globally if you prefer a stable command for MCP client configuration:

```sh
npm install -g sam-procurement-mcp
sam-procurement-mcp --demo
```

GitHub fallback for unreleased changes:

```sh
npm install -g github:jfleish/sam-procurement-mcp
sam-procurement-mcp --demo
```

The demo is synthetic and fictional. Do not use it as evidence for a bid, eligibility decision, or market conclusion.

## Configure SAM.gov

1. Create or copy your personal public API key from [SAM.gov Account Details](https://sam.gov/workspace/profile/account-details).
2. On the same computer and Windows/macOS/Linux user account that runs your MCP client, run:

   ```sh
   sam-procurement-mcp setup
   ```

   If you did not install globally, use `npx -y sam-procurement-mcp setup`.

The key is validated once and saved only in the operating system's secure store: Windows DPAPI, macOS Keychain, or Linux Secret Service. It is never an MCP tool argument or client config value.

Useful checks:

```sh
sam-procurement-mcp doctor --live
sam-procurement-mcp validate-key
sam-procurement-mcp forget-key
```

`SAM_GOV_API_KEY` is an optional environment override for managed environments. It takes precedence over the secure store. Do not put it in shell history, MCP JSON, source files, or chat. USAspending remains available without it.

## Connect an MCP client

The server uses local stdio. The default command below uses the installed binary and live mode. For a no-key walkthrough, add `"--demo"` to `args`.

### Codex

```sh
codex mcp add procurement -- sam-procurement-mcp
codex mcp list
```

If the package is not installed globally:

```sh
codex mcp add procurement -- npx -y sam-procurement-mcp
```

On Windows, if `npx` is not found by the client, use `cmd /c` in the command configuration or install globally and use `sam-procurement-mcp`.

### Claude Code

```sh
claude mcp add --transport stdio procurement -- sam-procurement-mcp
claude mcp list
```

npx launcher:

```sh
claude mcp add --transport stdio procurement -- npx -y sam-procurement-mcp
```

Use `--scope user` if the server should be available in every Claude Code project. Run `/mcp` inside Claude Code to inspect the connection.

### Claude Desktop

Open Settings → Developer → Edit Config. The file is `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\\Claude\\claude_desktop_config.json` on Windows.

macOS/Linux:

```json
{
  "mcpServers": {
    "procurement": {
      "command": "sam-procurement-mcp",
      "args": []
    }
  }
}
```

Windows, using npx:

```json
{
  "mcpServers": {
    "procurement": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "sam-procurement-mcp"]
    }
  }
}
```

For demo mode, append `"--demo"` to `args`. Fully quit and restart Claude Desktop after saving. If installed globally, Windows can use `"command": "sam-procurement-mcp"` with an empty `args` array.

### Other stdio clients

Use this equivalent configuration wherever the client accepts an MCP command and argument list:

```json
{
  "command": "npx",
  "args": ["-y", "sam-procurement-mcp"]
}
```

For a client that cannot launch local processes, use the optional loopback transport:

```sh
sam-procurement-mcp serve-http --demo --port 3847
```

Connect the client to `http://127.0.0.1:3847/mcp`. It binds to loopback and exposes read-only research tools only; do not expose it publicly without a separately secured tunnel.

## Example prompts

```text
Use the demo data to show me an opportunity, its deadline status, and comparable awards.
```

```text
Find open cybersecurity opportunities under NAICS 541512 in Virginia.
```

```text
Research notice <notice ID>, list its deadline with time zone and submission requirements, then compare similar awards.
```

```text
Who received the largest prime contracts under PSC DA01 in the last two years?
```

## Tools and data behavior

The 13 tools are: `search_opportunities`, `get_opportunity`, `research_opportunity`, `search`, `fetch`, `search_contract_awards`, `analyze_contract_market`, `lookup_public_entity`, `procurement_status`, `save_pipeline_notice`, `list_pipeline`, `check_pipeline_notice`, and `remove_pipeline_notice`.

SAM.gov searches default to the previous 30 days and accept at most a 365-day posting window. USAspending searches default to two years and accept at most 10 years. Requests time out after 15 seconds; transient USAspending gateway errors receive one retry. Results include source URLs where available. Always check official notices, amendments, attachments, eligibility, and submission instructions before acting.

Saved notice baselines are private local JSON files. The default data directory is OS-specific; set `SAM_MCP_HOME` for a separate local profile. Demo and live pipelines are separate. If a legacy plaintext key file is found, setup must migrate it before SAM.gov calls and removes it after successful secure storage.

## Troubleshooting

- Run `sam-procurement-mcp --help` and `sam-procurement-mcp doctor --live`.
- If the client cannot find the command, install globally or use the npm `npx` configuration above. On Windows, wrap `npx` as `cmd /c npx ...`.
- If SAM.gov says setup is required, run `sam-procurement-mcp setup` in the same OS user account as the MCP client. `validate-key` checks the stored credential without revealing it.
- If Linux secure storage fails, install and unlock `secret-tool` / Secret Service.
- If Claude Desktop does not show the tools, check its [MCP logs and restart guidance](https://modelcontextprotocol.io/docs/quickstart/user#troubleshooting).
- For client behavior, see the [official MCP server examples](https://github.com/modelcontextprotocol/servers#using-an-mcp-client) and [Claude Desktop quickstart](https://modelcontextprotocol.io/docs/quickstart/user).
- Report reproducible issues at [GitHub Issues](https://github.com/jfleish/sam-procurement-mcp/issues).

## Build and verify a release

```sh
npm ci --ignore-scripts
npm test
npm run release:build
npm run release:verify
```

The build creates an npm tarball and Claude Desktop `.mcpb` bundle. The verifier installs the tarball outside the checkout with an empty npm cache and smoke-tests the 13-tool demo server plus loopback HTTP surface. Add `-- --live` to verify live USAspending and authenticated SAM.gov paths when `SAM_GOV_API_KEY` is supplied to the verifier environment.

## License

[MIT](LICENSE). This independent project is not affiliated with GSA, USAspending, OpenAI, or Anthropic.
