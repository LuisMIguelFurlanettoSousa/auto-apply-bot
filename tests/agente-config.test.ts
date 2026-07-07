import { describe, it, expect } from 'vitest';
import { GoogleGenAI, mcpToTool } from '@google/genai';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { construirConfigGeracao } from '../src/agente';
import { customToolDeclarations } from '../src/tools';

// Client MCP falso: mcpToTool() só exige a presença de listTools na construção
// do CallableTool (o I/O real só ocorreria em .tool()/.callTool(), que estes
// testes nao invocam). Basta satisfazer o type-guard isMcpClient do SDK.
const mcpClientFake = { listTools: async () => ({ tools: [] }) } as unknown as Client;

describe('construirConfigGeracao', () => {
  it('desabilita o automatic function calling (AFC) para permitir MCP + functionDeclarations juntos', () => {
    // Cenário
    const systemPrompt = 'prompt de teste';

    // Ação
    const cfg = construirConfigGeracao(mcpClientFake, systemPrompt);

    // Validação
    // Sem esta flag, o @google/genai lança "Automatic function calling with
    // CallableTools (or MCP objects) and basic FunctionDeclarations is not yet
    // supported" ao misturar o objeto MCP com functionDeclarations no mesmo array.
    expect(cfg.automaticFunctionCalling?.disable).toBe(true);
  });

  it('mantem as duas fontes de tools: objeto MCP (CallableTool) + functionDeclarations customizadas', () => {
    // Cenário
    const systemPrompt = 'prompt de teste';

    // Ação
    const cfg = construirConfigGeracao(mcpClientFake, systemPrompt);
    const tools = cfg.tools ?? [];

    // Validação
    expect(tools).toHaveLength(2);
    // tools[0]: objeto MCP é um CallableTool (reconhecido pelo método callTool).
    expect(typeof (tools[0] as { callTool?: unknown }).callTool).toBe('function');
    // tools[1]: declarações básicas das tools customizadas do bot.
    expect((tools[1] as { functionDeclarations?: unknown }).functionDeclarations)
      .toBe(customToolDeclarations);
  });

  it('propaga o systemInstruction recebido', () => {
    // Cenário
    const systemPrompt = 'instrucao do sistema xyz';

    // Ação
    const cfg = construirConfigGeracao(mcpClientFake, systemPrompt);

    // Validação
    expect(cfg.systemInstruction).toBe(systemPrompt);
  });
});

// Testes de INTEGRACAO com o SDK real (@google/genai). Exercitam o guard de AFC
// de verdade — em vez de so checar o formato do config — para pegar regressoes
// que os testes de formato acima nao pegariam (ex.: alguem remover a flag, ou o
// SDK mudar a ordem dos checks numa versao futura). O guard roda ANTES da rede,
// entao usamos apiKey invalida + AbortController para nunca depender de conexao.
describe('guard de AFC do @google/genai (integracao com o SDK)', () => {
  const ai = new GoogleGenAI({ apiKey: 'chave-invalida-de-proposito' });
  const model = 'gemini-2.5-flash';
  const contents = [{ role: 'user', parts: [{ text: 'oi' }] }];

  it('rejeita a config ANTIGA (objeto MCP + functionDeclarations com AFC ligado)', async () => {
    // Cenário: o array de tools exatamente como era antes do fix (AFC no default).
    const configAntiga = {
      tools: [mcpToTool(mcpClientFake), { functionDeclarations: customToolDeclarations }],
    };

    // Ação + Validação: o SDK lanca o erro "not yet supported" antes de qualquer
    // rede — reproduz o bug original e prova que o teste realmente discrimina.
    await expect(
      ai.models.generateContent({ model, contents, config: configAntiga }),
    ).rejects.toThrow(/not yet supported/);
  });

  it('aceita a config de construirConfigGeracao (ultrapassa o guard de AFC)', async () => {
    // Cenário: AbortController ja abortado corta a chamada apos o guard, antes
    // de tocar a rede. O que importa e NAO cair no erro de tools incompativeis.
    const ctrl = new AbortController();
    ctrl.abort();
    const cfg = { ...construirConfigGeracao(mcpClientFake, 'x'), abortSignal: ctrl.signal };

    // Ação
    let mensagemErro = '';
    try {
      await ai.models.generateContent({ model, contents, config: cfg });
    } catch (e) {
      mensagemErro = e instanceof Error ? e.message : String(e);
    }

    // Validação: pode falhar por abort/auth/rede, mas NUNCA pelo guard de AFC.
    expect(mensagemErro).not.toMatch(/not yet supported/);
  });
});
