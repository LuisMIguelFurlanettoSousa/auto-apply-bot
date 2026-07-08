import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { verificarChromeCDP } from '../src/mcp-client';

let servidor: Server | undefined;

afterEach(async () => {
  // Derruba o servidor de teste entre casos, se algum tiver ficado de pé.
  // closeAllConnections() é necessário para o caso "servidor que nunca responde":
  // sem isso, close() ficaria pendurado esperando a conexão pendente encerrar.
  if (servidor) {
    servidor.closeAllConnections?.();
    await new Promise<void>((r) => servidor!.close(() => r()));
    servidor = undefined;
  }
});

function ouvir(s: Server): Promise<number> {
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port));
  });
}

describe('verificarChromeCDP', () => {
  it('resolve quando o CDP responde OK em /json/version (Chrome no ar)', async () => {
    // Cenário: servidor local simulando o endpoint DevTools do Chrome.
    servidor = createServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Browser: 'Chrome/126.0' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const porta = await ouvir(servidor);

    // Ação + Validação: não deve lançar.
    await expect(
      verificarChromeCDP(`http://127.0.0.1:${porta}`),
    ).resolves.toBeUndefined();
  });

  it('lanca erro com instrucao de setup quando nada escuta na porta (Chrome fechado)', async () => {
    // Cenário: sobe e derruba um servidor só para obter uma porta comprovadamente
    // livre — assim a conexão dá ECONNREFUSED real, sem depender de porta fixa.
    const tmp = createServer();
    const porta = await ouvir(tmp);
    await new Promise<void>((r) => tmp.close(() => r()));

    // Ação + Validação: rejeita e a mensagem ensina a abrir o Chrome.
    await expect(
      verificarChromeCDP(`http://127.0.0.1:${porta}`, 1000),
    ).rejects.toThrow(/remote-debugging-port/);
  });

  it('lanca erro de timeout quando o servidor aceita mas nao responde a tempo', async () => {
    // Cenário: servidor que recebe a request e nunca responde (simula um Chrome/
    // proxy que aceita o TCP mas trava em /json/version).
    servidor = createServer(() => { /* nunca chama res.end */ });
    const porta = await ouvir(servidor);

    // Ação + Validação: o timeout curto dispara o AbortController e a mensagem
    // deve deixar claro que foi TIMEOUT (nao uma recusa de conexao).
    await expect(
      verificarChromeCDP(`http://127.0.0.1:${porta}`, 200),
    ).rejects.toThrow(/timeout/i);
  });

  it('lanca erro quando o CDP responde com status de erro (nao-2xx)', async () => {
    // Cenário: algo escuta na porta mas devolve 500 em /json/version.
    servidor = createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    const porta = await ouvir(servidor);

    // Ação + Validação
    await expect(
      verificarChromeCDP(`http://127.0.0.1:${porta}`),
    ).rejects.toThrow(/HTTP 500/);
  });
});
