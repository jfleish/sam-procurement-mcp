# SAM Procurement MCP

Local MCP server for researching federal procurement opportunities. It queries live SAM.gov notices (with your personal SAM.gov API key) and public USAspending award data. It can also keep a private, local notice shortlist.

No service is hosted by this project. There is no telemetry, database, or embedded AI API.

## Install

Requires Node.js 20.19 or later (Node 22 or 24 LTS recommended).

### From npm

```sh
npm install -g sam-procurement-mcp
sam-procurement-mcp --version
```

### From a release file

Install the matching `sam-procurement-mcp-0.2.1.tgz` offline:

```sh
npm install -g --offline --ignore-scripts ./sam-procurement-mcp-0.2.1.tgz
sam-procurement-mcp --version
```

## One-time SAM.gov setup

USAspending tools work without a SAM.gov key. Live SAM.gov opportunity searches and public entity lookup require your personal public API key from [SAM.gov Account Details](https://sam.gov/workspace/profile/account-details).

Run this in an interactive terminal on the computer that will run the MCP client:

```sh
sam-procurement-mcp setup
```

The key is entered through a hidden prompt, verified once, then saved only in the operating system's secure store: Windows DPAPI, macOS Keychain, or Linux Secret Service. It is never placed in MCP tool arguments or the project configuration.

Useful commands:

```sh
sam-procurement-mcp doctor --live   # check setup and make live requests
sam-procurement-mcp validate-key    # test the current SAM.gov credential
sam-procurement-mcp forget-key      # remove the locally saved credential
```

`SAM_GOV_API_KEY` is an optional process-environment override for managed-client settings. It takes precedence over the securely saved key; do not put it in shell history, MCP JSON, source files, or chat.

## Connect a client

The server uses local stdio. After global installation, configure a supported local MCP client with:

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

This works with Codex, ChatGPT desktop on a local Codex host, Claude Code, and other stdio-compatible MCP clients. For Claude Desktop, build or download `sam-procurement-mcp.mcpb` and install it as a local extension; its API-key setting is marked sensitive.

Use `--demo` in the arguments for a credential-free walkthrough. Demo data is fictional and performs no network requests.

## Example prompts

```text
Find open cybersecurity opportunities under NAICS 541512 in Virginia.
```

```text
Research this notice, list its deadline with time zone and submission requirements, then compare similar awards. [notice ID]
```

```text
Who received the largest prime contracts under PSC DA01 in the last two years?
```

## Tools

The server exposes 13 tools:

- `search_opportunities`, `get_opportunity`, `research_opportunity`, `search`, `fetch`
- `search_contract_awards`, `analyze_contract_market`
- `lookup_public_entity`, `procurement_status`
- `save_pipeline_notice`, `list_pipeline`, `check_pipeline_notice`, `remove_pipeline_notice`

SAM.gov searches default to the previous 30 days and accept at most a 365-day posting window. USAspending searches default to two years and accept at most 10 years. Requests time out after 15 seconds; transient USAspending gateway errors receive one retry; SAM.gov rate-limit and authentication failures are returned as clear, key-free errors. Results include source URLs where available. Check official notices, amendments, attachments, eligibility, and submission instructions before acting.

## Local data and privacy

Saved notice baselines are private local JSON files. The default data directory is OS-specific; set `SAM_MCP_HOME` to select a separate local profile. Demo and live pipelines are separate. If a legacy plaintext key file is detected, the CLI requires migration before SAM.gov calls; successful setup removes it.

The optional `serve-http` command listens on loopback only and exposes read-only research tools. It is intended for a separately secured local tunnel, not public deployment.

## Build and verify a release

```sh
npm ci --ignore-scripts
npm test
npm run release:build
npm run release:verify
```

The build creates `dist/sam-procurement-mcp-0.2.1.tgz` and `dist/sam-procurement-mcp.mcpb`. The verifier installs both outside the checkout using an empty npm cache and smoke-tests the 13-tool demo server plus the loopback HTTP surface. Add `-- --live` to verify live USAspending and, only when a key is supplied through the verifier environment, authenticated SAM.gov paths.

## License

[MIT](LICENSE). This independent project is not affiliated with GSA, USAspending, OpenAI, or Anthropic.
