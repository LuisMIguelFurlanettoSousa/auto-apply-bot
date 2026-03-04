// Tracking de custo de tokens das chamadas ao Gemini.
// Adaptado do beatwad/AIHawk: registra input/output tokens de cada chamada,
// calcula custo em USD e exibe resumo ao final da execução.
//
// Pricing: Gemini 2.5 Pro (standard tier ≤ 200K context)
// - Input:  $1.25 / 1M tokens
// - Output: $10.00 / 1M tokens
// - Cached: $0.125 / 1M tokens
// Fonte: https://ai.google.dev/gemini-api/docs/pricing

import { log } from './logger.js';

// ========== PRICING ==========

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedPer1M: number;
}

const PRICING: Record<string, ModelPricing> = {
  'gemini-2.5-pro': {
    inputPer1M: 1.25,
    outputPer1M: 10.00,
    cachedPer1M: 0.125,
  },
  'gemini-2.5-flash': {
    inputPer1M: 0.15,
    outputPer1M: 0.60,
    cachedPer1M: 0.0375,
  },
  'gemini-2.0-flash': {
    inputPer1M: 0.10,
    outputPer1M: 0.40,
    cachedPer1M: 0.025,
  },
};

// Fallback para modelos não listados (usa pricing do 2.5 pro)
const PRICING_FALLBACK: ModelPricing = {
  inputPer1M: 1.25,
  outputPer1M: 10.00,
  cachedPer1M: 0.125,
};

// ========== TIPOS ==========

// Campos que o SDK do Gemini retorna em response.usageMetadata
export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

interface RegistroUso {
  timestamp: string;
  modelo: string;
  contexto: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  custoUSD: number;
}

// ========== TRACKER (SINGLETON) ==========

const registros: RegistroUso[] = [];
let custoTotal = 0;
let tokensTotal = 0;

function getPricing(modelo: string): ModelPricing {
  // Busca pelo nome exato ou por prefixo
  if (PRICING[modelo]) return PRICING[modelo];
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (modelo.startsWith(key)) return pricing;
  }
  return PRICING_FALLBACK;
}

function calcularCusto(
  modelo: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
): number {
  const pricing = getPricing(modelo);
  const newInputTokens = inputTokens - cachedTokens;

  const custoInput = (newInputTokens / 1_000_000) * pricing.inputPer1M;
  const custoCached = (cachedTokens / 1_000_000) * pricing.cachedPer1M;
  const custoOutput = (outputTokens / 1_000_000) * pricing.outputPer1M;

  return custoInput + custoCached + custoOutput;
}

/**
 * Registra o uso de tokens de uma chamada ao Gemini.
 * Chamar após cada response do modelo.
 *
 * @param modelo - Nome do modelo (ex: 'gemini-2.5-pro')
 * @param usage - usageMetadata da resposta do Gemini
 * @param contexto - Identificador do contexto (ex: 'agente', 'cover_letter', 'curriculo_tailored')
 */
export function registrarUsoTokens(
  modelo: string,
  usage: UsageMetadata | undefined | null,
  contexto: string,
): void {
  if (!usage) return;

  const inputTokens = usage.promptTokenCount ?? 0;
  const outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  const cachedTokens = usage.cachedContentTokenCount ?? 0;
  const totalTokens = usage.totalTokenCount ?? (inputTokens + outputTokens);

  const custoUSD = calcularCusto(modelo, inputTokens, outputTokens, cachedTokens);

  registros.push({
    timestamp: new Date().toISOString(),
    modelo,
    contexto,
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens,
    custoUSD,
  });

  custoTotal += custoUSD;
  tokensTotal += totalTokens;
}

/**
 * Retorna o custo total acumulado em USD.
 */
export function obterCustoTotal(): number {
  return custoTotal;
}

/**
 * Retorna o total de tokens consumidos.
 */
export function obterTokensTotal(): number {
  return tokensTotal;
}

/**
 * Retorna o total de chamadas registradas.
 */
export function obterTotalChamadas(): number {
  return registros.length;
}

/**
 * Retorna resumo agrupado por contexto.
 */
export function obterResumoPorContexto(): Record<string, { chamadas: number; tokens: number; custoUSD: number }> {
  const porContexto: Record<string, { chamadas: number; tokens: number; custoUSD: number }> = {};

  for (const r of registros) {
    if (!porContexto[r.contexto]) {
      porContexto[r.contexto] = { chamadas: 0, tokens: 0, custoUSD: 0 };
    }
    porContexto[r.contexto].chamadas++;
    porContexto[r.contexto].tokens += r.totalTokens;
    porContexto[r.contexto].custoUSD += r.custoUSD;
  }

  return porContexto;
}

/**
 * Exibe resumo formatado no log.
 */
export function exibirResumoTokens(): void {
  if (registros.length === 0) {
    log('INFO', 'Tokens: Nenhuma chamada registrada.');
    return;
  }

  const porContexto = obterResumoPorContexto();

  log('INFO', '='.repeat(60));
  log('INFO', '  CUSTO DE TOKENS');
  log('INFO', '='.repeat(60));
  log('INFO', `  Total de chamadas: ${registros.length}`);
  log('INFO', `  Total de tokens:   ${tokensTotal.toLocaleString('pt-BR')}`);
  log('INFO', `  Custo total:       $${custoTotal.toFixed(4)} USD`);

  if (registros.length > 0) {
    log('INFO', `  Media por chamada: $${(custoTotal / registros.length).toFixed(6)} USD`);
  }

  log('INFO', '  ---');
  log('INFO', '  Por contexto:');

  for (const [ctx, dados] of Object.entries(porContexto)) {
    log('INFO', `    ${ctx}: ${dados.chamadas} chamada(s), ${dados.tokens.toLocaleString('pt-BR')} tokens, $${dados.custoUSD.toFixed(4)}`);
  }
}

/**
 * Retorna os dados brutos para persistência no banco.
 */
export function obterRegistros(): RegistroUso[] {
  return [...registros];
}

/**
 * Reseta o tracker (para uso entre execuções no modo cron).
 */
export function resetarTracker(): void {
  registros.length = 0;
  custoTotal = 0;
  tokensTotal = 0;
}
