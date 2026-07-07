import { describe, it, expect } from 'vitest';
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
