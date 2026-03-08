import { MCPClient } from '@mastra/mcp';

const mcpProxyPath = process.env.MCP_PROXY_PATH;
const haMcpUrl = process.env.HOME_ASSISTANT_MCP_URL;
const haAccessToken = process.env.HOME_ASSISTANT_ACCESS_TOKEN;

if (!mcpProxyPath || !haMcpUrl || !haAccessToken) {
  console.warn(
    '[home-assistant-mcp] MCP_PROXY_PATH, HOME_ASSISTANT_MCP_URL, or HOME_ASSISTANT_ACCESS_TOKEN ' +
    'not set — Home Assistant MCP tools will be unavailable.',
  );
}

export const homeAssistantMcpClient = new MCPClient({
  id: 'home-assistant-mcp-client',
  servers: {
    ...(mcpProxyPath && haMcpUrl && haAccessToken
      ? {
          homeAssistant: {
            command: mcpProxyPath,
            args: [haMcpUrl, '--transport=streamablehttp', '--stateless'],
            env: { API_ACCESS_TOKEN: haAccessToken },
          },
        }
      : {}),
  },
});
