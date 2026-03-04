import { createHash } from 'crypto';
import { log } from './logger.js';
import { gerarTextoAux } from './llm-adapter.js';
import { anonimizarPerfil, desanonimizar } from './anonimizacao.js';
import type { Perfil } from './types.js';

// Cache em memória para evitar gerar a mesma cover letter 2x
const cacheGerados = new Map<string, string>();

// ========== PROMPT ==========

function buildCoverLetterPrompt(perfil: Perfil, descricaoVaga: string, empresa: string, tituloVaga: string): string {
  return `Voce e um redator profissional de cartas de apresentacao para candidaturas a vagas de emprego.

Sua tarefa: escrever uma carta de apresentacao curta, natural e personalizada para a vaga descrita abaixo.

## REGRAS ABSOLUTAS

1. Use SOMENTE informacoes reais do perfil do candidato. NAO invente experiencias, projetos ou habilidades.
2. A carta deve ter entre 3 a 5 paragrafos curtos (maximo 150 palavras no total).
3. Escreva em portugues brasileiro, tom profissional mas humano — sem cliches como "sou apaixonado por tecnologia" ou "busco novos desafios".
4. NAO repita o curriculo inteiro. Destaque apenas 2-3 pontos mais relevantes para ESTA vaga.
5. Mencione o nome da empresa e o cargo para mostrar que a carta e personalizada.
6. Finalize com disponibilidade para conversa, sem ser bajulador.

## PERFIL REAL DO CANDIDATO

Nome: ${perfil.nome}
Titulo: ${perfil.titulo_profissional}
Experiencia: ${perfil.anos_experiencia} ano(s)
Stack: ${perfil.stack_principal.join(', ')}
Bancos: ${(perfil.bancos_de_dados ?? []).join(', ')}
Resumo: ${perfil.resumo_profissional}
Experiencias:
${(perfil.experiencias ?? []).map(e => `- ${e.empresa} (${e.cargo}, ${e.periodo}): ${e.descricao}`).join('\n')}

## VAGA

Empresa: ${empresa}
Cargo: ${tituloVaga}
Descricao:
${descricaoVaga}

## INSTRUCAO FINAL

Retorne APENAS o texto da carta de apresentacao. Sem saudacao formal ("Prezados"), sem "Atenciosamente" no final — apenas o conteudo direto que o candidato colaria num campo de texto de formulario.

LEMBRETE: Se a vaga pedir tecnologia que o candidato NAO tem, NAO mencione. Foque nas intersecoes entre o perfil e a vaga.`;
}

// ========== GERACAO ==========

export async function gerarCoverLetter(
  _geminiApiKey: string,
  _geminiModel: string,
  perfil: Perfil,
  descricaoVaga: string,
  empresa: string,
  tituloVaga: string,
): Promise<{ texto: string; fonte: 'gerado' | 'cache' }> {
  // Cache por hash
  const hash = createHash('md5')
    .update(`${empresa}|${tituloVaga}|${descricaoVaga.substring(0, 300)}`)
    .digest('hex')
    .substring(0, 12);

  if (cacheGerados.has(hash)) {
    log('TOOL', `Cover letter encontrada em cache (hash: ${hash})`);
    return { texto: cacheGerados.get(hash)!, fonte: 'cache' };
  }

  log('TOOL', `Gerando cover letter para ${tituloVaga} na ${empresa}...`);

  // Anonimiza PII antes de enviar ao LLM
  const { perfilAnonimo, mapa } = anonimizarPerfil(perfil);

  const prompt = buildCoverLetterPrompt(perfilAnonimo, descricaoVaga, empresa, tituloVaga);
  const response = await gerarTextoAux(prompt, 'cover_letter');

  let texto = desanonimizar(response.text, mapa);

  // Limpar possíveis artefatos de markdown
  if (texto.startsWith('```')) {
    texto = texto.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
  }

  if (!texto || texto.length < 50) {
    throw new Error('Cover letter gerada muito curta ou vazia');
  }

  // Validação: verificar se não fabricou skills
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
    log('WARN', `Cover letter mencionou skills fabricadas: ${fabricadas.join(', ')}. Regenerando...`);
    const response2 = await gerarTextoAux(
      prompt + '\n\nATENCAO REDOBRADA: Voce ERROU na tentativa anterior e mencionou tecnologias que o candidato NAO possui. Use SOMENTE: ' + perfil.stack_principal.join(', '),
      'cover_letter_retry',
    );
    texto = desanonimizar(response2.text, mapa);
    if (texto.startsWith('```')) {
      texto = texto.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
    }
  }

  cacheGerados.set(hash, texto);
  log('TOOL', `Cover letter gerada (${texto.length} chars)`);

  return { texto, fonte: 'gerado' };
}
