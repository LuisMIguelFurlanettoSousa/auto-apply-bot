// Geração de mensagens personalizadas para recrutadores/hiring managers.
// Adaptado do beatwad: módulo separado que gera mensagens curtas e personalizadas
// para enviar via LinkedIn (connection request com nota).
//
// Limite do LinkedIn: 300 caracteres para nota de conexão.

import { GoogleGenAI } from '@google/genai';
import { createHash } from 'crypto';
import { log } from './logger.js';
import type { Perfil } from './types.js';

// Cache em memória para evitar gerar a mesma mensagem 2x
const cacheGerados = new Map<string, string>();

// ========== PROMPT ==========

function buildMensagemRecrutadorPrompt(
  perfil: Perfil,
  nomeRecrutador: string,
  cargoRecrutador: string,
  empresa: string,
  tituloVaga: string,
  descricaoVaga: string,
): string {
  return `Voce e um especialista em networking profissional no LinkedIn.

Sua tarefa: escrever uma nota CURTA e personalizada para enviar junto com um pedido de conexao no LinkedIn para o recrutador/hiring manager de uma vaga.

## REGRAS ABSOLUTAS

1. MAXIMO 280 caracteres (limite do LinkedIn e 300, mas deixe margem).
2. Use SOMENTE informacoes reais do perfil do candidato. NAO invente nada.
3. Escreva em portugues brasileiro, tom profissional e direto.
4. Mencione o NOME do recrutador para personalizar (se disponivel).
5. Mencione a VAGA especifica para mostrar que nao e spam.
6. Destaque 1-2 skills que fazem match com a vaga.
7. Finalize com interesse em conversar, sem ser bajulador.
8. NAO use saudacoes formais ("Prezado"), NAO use "Atenciosamente".
9. NAO use emojis. NAO use excesso de exclamacoes.
10. Nao pareca um bot — pareca um profissional real fazendo networking.

## PERFIL REAL DO CANDIDATO

Nome: ${perfil.nome}
Titulo: ${perfil.titulo_profissional}
Experiencia: ${perfil.anos_experiencia} ano(s)
Stack: ${perfil.stack_principal.join(', ')}
Resumo: ${perfil.resumo_profissional}

## RECRUTADOR/HIRING MANAGER

Nome: ${nomeRecrutador || 'nao informado'}
Cargo: ${cargoRecrutador || 'nao informado'}
Empresa: ${empresa}

## VAGA

Cargo: ${tituloVaga}
Descricao (resumida):
${descricaoVaga.substring(0, 500)}

## EXEMPLOS DE BOAS NOTAS (para referencia de tom/estilo)

- "Oi Maria, vi a vaga de Dev Backend na Empresa X e me interessei. Trabalho com Java e Node.js ha 2 anos e tenho experiencia com APIs REST. Gostaria de trocar uma ideia sobre a oportunidade."
- "Ola Joao, me candidatei para Fullstack na Empresa Y. Meu background em React + TypeScript e relevante para a posicao. Posso compartilhar mais detalhes se houver interesse."

## INSTRUCAO FINAL

Retorne APENAS o texto da nota. Sem aspas, sem formatacao, sem explicacao.
Conte os caracteres — MAXIMO 280. Se passar, reescreva mais curto.

LEMBRETE: Se a vaga pedir tecnologia que o candidato NAO tem, NAO mencione. Foque nas intersecoes.`;
}

// ========== GERACAO ==========

export async function gerarMensagemRecrutador(
  geminiApiKey: string,
  geminiModel: string,
  perfil: Perfil,
  nomeRecrutador: string,
  cargoRecrutador: string,
  empresa: string,
  tituloVaga: string,
  descricaoVaga: string,
): Promise<{ texto: string; fonte: 'gerado' | 'cache' }> {
  // Cache por hash
  const hash = createHash('md5')
    .update(`msg|${nomeRecrutador}|${empresa}|${tituloVaga}`)
    .digest('hex')
    .substring(0, 12);

  if (cacheGerados.has(hash)) {
    log('TOOL', `Mensagem recrutador encontrada em cache (hash: ${hash})`);
    return { texto: cacheGerados.get(hash)!, fonte: 'cache' };
  }

  log('TOOL', `Gerando mensagem para recrutador ${nomeRecrutador || '(sem nome)'} na ${empresa}...`);

  const ai = new GoogleGenAI({ apiKey: geminiApiKey });
  const prompt = buildMensagemRecrutadorPrompt(
    perfil, nomeRecrutador, cargoRecrutador, empresa, tituloVaga, descricaoVaga,
  );

  const response = await ai.models.generateContent({
    model: geminiModel,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  let texto = response.text?.trim() ?? '';

  // Limpar artefatos de markdown
  if (texto.startsWith('```')) {
    texto = texto.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
  }

  // Remover aspas envolventes
  if ((texto.startsWith('"') && texto.endsWith('"')) || (texto.startsWith("'") && texto.endsWith("'"))) {
    texto = texto.slice(1, -1);
  }

  if (!texto || texto.length < 20) {
    throw new Error('Mensagem para recrutador gerada muito curta ou vazia');
  }

  // Truncar se passou do limite (280 chars)
  if (texto.length > 280) {
    log('WARN', `Mensagem recrutador com ${texto.length} chars — truncando para 280`);
    // Tenta cortar na última frase completa antes de 280
    const cortado = texto.substring(0, 280);
    const ultimoPonto = Math.max(
      cortado.lastIndexOf('.'),
      cortado.lastIndexOf('!'),
      cortado.lastIndexOf('?'),
    );
    texto = ultimoPonto > 200 ? cortado.substring(0, ultimoPonto + 1) : cortado;
  }

  // Validação anti-fabricação (mesma lógica da cover letter)
  const textoLower = texto.toLowerCase();
  const skillsFabricadas = [
    'python', 'django', 'golang', 'rust', 'c#', '.net',
    'angular', 'vue.js', 'svelte', 'kubernetes', 'terraform',
    'machine learning', 'deep learning', 'scala', 'kotlin',
    'php', 'laravel', 'ruby', 'rails',
  ];

  const skillsReais = perfil.stack_principal.map(s => s.toLowerCase());
  const fabricadas = skillsFabricadas.filter(s =>
    textoLower.includes(s) && !skillsReais.some(r => r.includes(s)),
  );

  if (fabricadas.length > 0) {
    log('WARN', `Mensagem recrutador mencionou skills fabricadas: ${fabricadas.join(', ')}. Regenerando...`);
    const response2 = await ai.models.generateContent({
      model: geminiModel,
      contents: [{ role: 'user', parts: [{ text: prompt + '\n\nATENCAO: Voce mencionou tecnologias FALSAS. Use SOMENTE: ' + perfil.stack_principal.join(', ') + '. MAXIMO 280 caracteres.' }] }],
    });
    texto = response2.text?.trim() ?? texto;
    if (texto.startsWith('```')) {
      texto = texto.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
    }
    if (texto.length > 280) {
      texto = texto.substring(0, 280);
    }
  }

  cacheGerados.set(hash, texto);
  log('TOOL', `Mensagem recrutador gerada (${texto.length} chars)`);

  return { texto, fonte: 'gerado' };
}
