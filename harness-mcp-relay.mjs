// Runs INSIDE a harness boundary as the harness's own stdio MCP server (ACP v1 requires stdio MCP): it only relays bytes between its stdio and
// one exact Bridge-owned Unix socket, where Bridge serves the Codex MCP tools outside the boundary. It holds no tool, credential or state.
// Usage: node harness-mcp-relay.mjs <absolute socket path>
import { connect } from 'node:net';

const socket = connect(process.argv[2]);
socket.on('connect', () => { process.stdin.pipe(socket); socket.pipe(process.stdout); });
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
process.stdin.on('end', () => socket.end());
