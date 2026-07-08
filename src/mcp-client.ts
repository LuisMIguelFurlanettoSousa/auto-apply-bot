import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let mcpClient: Client | null = null;

/**
 * Verifica, ANTES de subir o agente, que o Chrome esta acessivel via CDP.
 *
 * Por que existe: o handshake do Playwright MCP conecta com sucesso mesmo sem o
 * Chrome no ar — a falha de CDP so apareceria la na frente, no meio do loop do
 * agente (na 1a tool browser_*), depois de ja ter gasto varias chamadas do LLM
 * (e ate estourar rate limit). Falhar cedo, com instrucao clara, evita esse
 * desperdicio. Testa o proprio endpoint DevTools do Chrome (/json/version).
 *
 * Dica de rede: use 127.0.0.1 (IPv4) em vez de "localhost". O Chrome, com
 * --remote-debugging-port, faz bind so em 127.0.0.1; "localhost" pode resolver
 * para ::1 (IPv6) e dar "connect ECONNREFUSED ::1:9222".
 */
export async function verificarChromeCDP(cdpEndpoint: string, timeoutMs = 3000): Promise<void> {
  const url = `${cdpEndpoint.replace(/\/+$/, '')}/json/version`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let ok = false;
  let motivo = '';
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    ok = resp.ok;
    if (ok) {
      // Nao usamos o corpo — cancela para liberar o socket (evita keep-alive pendurado).
      await resp.body?.cancel();
    } else {
      motivo = `HTTP ${resp.status}`;
    }
  } catch (e) {
    // signal.aborted distingue TIMEOUT de recusa/erro de rede, de forma
    // deterministica (independe do formato do erro do fetch/undici).
    motivo = ctrl.signal.aborted
      ? `timeout apos ${timeoutMs}ms`
      : e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }

  if (!ok) {
    throw new Error(
      `Nao foi possivel falar com o Chrome em ${cdpEndpoint} (${motivo}).\n` +
      `Abra o Chrome com a porta de debug ANTES de rodar o bot e faca login nos sites:\n` +
      `  Windows: & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\\.chrome-debug-profile"\n` +
      `  Linux:   google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-debug-profile"\n` +
      `  Mac:     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-debug-profile"\n` +
      `Confira abrindo ${cdpEndpoint}/json/version no proprio Chrome (deve mostrar um JSON).`,
    );
  }
}

export async function conectarPlaywrightMCP(cdpEndpoint: string): Promise<Client> {
  console.log(`[MCP] Conectando ao Playwright MCP via CDP: ${cdpEndpoint}`);

  // Versão pinada (não @latest): baixar a versão mais recente a cada execução é
  // um vetor de supply chain — código novo rodaria com acesso ao seu navegador/
  // CDP sem revisão. Atualize a versão conscientemente quando desejar.
  const transport = new StdioClientTransport({
    command: 'npx',
    args: [
      '@playwright/mcp@0.0.76',
      '--cdp-endpoint',
      cdpEndpoint,
    ],
  });

  mcpClient = new Client({
    name: 'job-bot',
    version: '1.0.0',
  });

  await mcpClient.connect(transport);

  console.log('[MCP] Conectado com sucesso ao Playwright MCP!');

  const { tools } = await mcpClient.listTools();
  console.log(`[MCP] ${tools.length} tools disponiveis: ${tools.map(t => t.name).join(', ')}`);

  return mcpClient;
}

export async function desconectarMCP(): Promise<void> {
  if (mcpClient) {
    await mcpClient.close();
    mcpClient = null;
    console.log('[MCP] Desconectado.');
  }
}

export function getMCPClient(): Client {
  if (!mcpClient) {
    throw new Error('MCP Client nao inicializado. Chame conectarPlaywrightMCP() primeiro.');
  }
  return mcpClient;
}
