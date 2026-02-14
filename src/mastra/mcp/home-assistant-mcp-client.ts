import { MCPClient } from '@mastra/mcp';

export const homeAssistantMcpClient = new MCPClient({
  id: 'home-assistant-mcp-client',
  servers: {
    homeAssistant: {
      command: process.env.MCP_PROXY_PATH ?? '',
      args: [
        process.env.HOME_ASSISTANT_MCP_URL ?? '',
        '--transport=streamablehttp',
        '--stateless',
      ],
      env: {
        API_ACCESS_TOKEN: process.env.HOME_ASSISTANT_ACCESS_TOKEN ?? '',
      },
    },
  },
});
