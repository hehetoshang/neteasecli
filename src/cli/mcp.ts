import { Command } from 'commander';

export function createMcpCommand(): Command {
  const mcp = new Command('mcp')
    .description('Run as MCP (Model Context Protocol) server (stdio)')
    .action(async () => {
      try {
        const { startMcpServer } = await import('../mcp/server.js');
        await startMcpServer();
      } catch (error) {
        console.error(
          JSON.stringify({
            success: false,
            error: {
              code: 'MCP_ERROR',
              message: error instanceof Error ? error.message : 'MCP server failed',
            },
          }),
        );
        process.exit(1);
      }
    });

  return mcp;
}
