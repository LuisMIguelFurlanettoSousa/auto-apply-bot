// Anonimização de dados pessoais (PII) antes de enviar ao LLM.
// Adaptado do beatwad: substitui dados reais por placeholders,
// e restaura após receber a resposta do LLM.
//
// Objetivo: proteger nome, email, telefone, LinkedIn, GitHub e portfolio
// de serem armazenados/treinados por provedores de LLM externos.

import { log } from './logger.js';
import type { Perfil } from './types.js';

export interface MapaAnonimizacao {
  [valorReal: string]: string;
}

// Placeholders fixos (determinísticos para facilitar de-anonimização)
const PLACEHOLDERS = {
  nome: '[CANDIDATO]',
  email: 'candidato@email.example',
  telefone: '(00) 00000-0000',
  linkedin: 'https://linkedin.com/in/candidato',
  github: 'https://github.com/candidato',
  portfolio: 'https://candidato.dev',
} as const;

/**
 * Cria uma cópia do perfil com PII substituído por placeholders.
 * Retorna o perfil anonimizado + mapa para reverter.
 */
export function anonimizarPerfil(perfil: Perfil): { perfilAnonimo: Perfil; mapa: MapaAnonimizacao } {
  const mapa: MapaAnonimizacao = {};

  // Só adiciona ao mapa se o campo tiver valor real (não-vazio)
  if (perfil.nome) mapa[perfil.nome] = PLACEHOLDERS.nome;
  if (perfil.email) mapa[perfil.email] = PLACEHOLDERS.email;
  if (perfil.telefone) mapa[perfil.telefone] = PLACEHOLDERS.telefone;
  if (perfil.linkedin) mapa[perfil.linkedin] = PLACEHOLDERS.linkedin;
  if (perfil.github) mapa[perfil.github] = PLACEHOLDERS.github;
  if (perfil.portfolio) mapa[perfil.portfolio] = PLACEHOLDERS.portfolio;

  const perfilAnonimo: Perfil = {
    ...perfil,
    nome: PLACEHOLDERS.nome,
    email: PLACEHOLDERS.email,
    telefone: PLACEHOLDERS.telefone,
    linkedin: PLACEHOLDERS.linkedin,
    github: PLACEHOLDERS.github,
    portfolio: PLACEHOLDERS.portfolio,
  };

  log('TOOL', `Perfil anonimizado para envio ao LLM (${Object.keys(mapa).length} campos substituidos)`);

  return { perfilAnonimo, mapa };
}

/**
 * Substitui placeholders de volta para valores reais no texto gerado pelo LLM.
 * Itera o mapa invertido (placeholder → valor real) e faz replace global.
 */
export function desanonimizar(texto: string, mapa: MapaAnonimizacao): string {
  let resultado = texto;

  // Inverter mapa: placeholder → valor real
  for (const [valorReal, placeholder] of Object.entries(mapa)) {
    // Replace global (o LLM pode ter usado o placeholder múltiplas vezes)
    resultado = resultado.replaceAll(placeholder, valorReal);
  }

  return resultado;
}

/**
 * Cria versão do perfil para o system prompt do agente principal.
 * Remove PII de contato mas mantém dados profissionais + nome.
 */
export function perfilParaSystemPrompt(perfil: Perfil): Record<string, unknown> {
  const { email, telefone, linkedin, github, portfolio, curriculo_path, ...resto } = perfil;
  return {
    ...resto,
    _nota: 'Dados de contato omitidos do prompt. Use a tool obter_perfil_candidato quando precisar preencher email, telefone ou links em formularios.',
  };
}
