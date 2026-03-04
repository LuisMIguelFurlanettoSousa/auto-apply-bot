import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';
import { gerarTextoAux } from './llm-adapter.js';
import { anonimizarPerfil, desanonimizar } from './anonimizacao.js';
import type { Perfil } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAILORED_DIR = path.resolve(__dirname, '..', 'curriculos', '_tailored');
const BASE_HTML_PATH = path.resolve(__dirname, '..', 'curriculos', '_base', 'template.html');

// Cache em memória para evitar gerar o mesmo currículo 2x na mesma execução
const cacheGerados = new Map<string, string>();

// ========== TEMPLATE HTML BASE ==========

export function gerarHTMLBase(perfil: Perfil): string {
  const experienciasHTML = (perfil.experiencias ?? []).map(exp => `
    <h3>${exp.empresa} — ${exp.cargo} <span class="periodo">(${exp.periodo})</span></h3>
    <ul>
      ${exp.descricao.split('. ').filter(Boolean).map(item => `<li>${item.trim().replace(/\.$/, '')}.</li>`).join('\n      ')}
    </ul>
  `).join('\n');

  const skillsCategorizadas = categorizarSkills(perfil);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<style>
  @page { margin: 18mm 18mm 14mm 18mm; size: A4; }
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #222; line-height: 1.5; margin: 0; padding: 28px 36px; max-width: 800px; }
  h1 { font-size: 26px; margin-bottom: 2px; color: #111; }
  .contato { font-size: 13px; color: #444; margin-bottom: 2px; }
  .contato a { color: #1a73e8; text-decoration: none; }
  h2 { font-size: 15px; margin: 14px 0 6px 0; color: #111; border-bottom: 1px solid #ccc; padding-bottom: 3px; text-transform: uppercase; letter-spacing: 0.5px; }
  h3 { font-size: 14px; margin: 10px 0 4px 0; color: #222; }
  .periodo { color: #555; font-weight: normal; font-size: 13px; }
  p { margin: 4px 0; font-size: 13.5px; }
  ul { margin: 4px 0 8px 18px; padding: 0; }
  li { font-size: 13px; margin-bottom: 3px; }
  .skills-line { font-size: 13px; margin: 3px 0; }
  .skills-line strong { color: #111; }
</style>
</head>
<body>

<h1>${perfil.nome}</h1>
<div class="contato">${perfil.telefone} | ${perfil.email}</div>
<div class="contato"><a href="${perfil.linkedin}">LinkedIn</a> | <a href="${perfil.github}">GitHub</a>${perfil.portfolio ? ` | <a href="${perfil.portfolio}">Portfolio</a>` : ''}</div>

<h2>Resumo Profissional</h2>
<p>{{RESUMO}}</p>

<h2>Experiencia Profissional</h2>
{{EXPERIENCIAS}}

<h2>Competencias Tecnicas</h2>
{{SKILLS}}

<h2>Idiomas</h2>
<p>${perfil.informacoes_extras?.idiomas ?? 'Portugues (nativo)'}</p>

</body>
</html>`.replace('{{EXPERIENCIAS}}', experienciasHTML)
    .replace('{{SKILLS}}', skillsCategorizadas);
}

function categorizarSkills(perfil: Perfil): string {
  const backend = ['Java', 'Node.js', 'Camunda BPM'];
  const frontend = ['React', 'Next.js', 'Tailwind'];
  const mobile = ['React Native', 'Expo'];
  const devops = ['Docker'];
  const bancos = perfil.bancos_de_dados ?? [];
  const metodologias = perfil.metodologias ?? [];

  const filtrar = (lista: string[]) =>
    lista.filter(s => perfil.stack_principal.includes(s));

  const linhas: string[] = [];

  const be = filtrar(backend);
  if (be.length) linhas.push(`<p class="skills-line"><strong>Backend:</strong> ${be.join(', ')}</p>`);

  const fe = filtrar(frontend);
  if (fe.length) linhas.push(`<p class="skills-line"><strong>Frontend:</strong> ${fe.join(', ')}</p>`);

  const mb = filtrar(mobile);
  if (mb.length) linhas.push(`<p class="skills-line"><strong>Mobile:</strong> ${mb.join(', ')}</p>`);

  linhas.push(`<p class="skills-line"><strong>Linguagens:</strong> ${perfil.stack_principal.filter(s => ['Java', 'TypeScript'].includes(s)).join(', ')}</p>`);

  if (bancos.length) linhas.push(`<p class="skills-line"><strong>Banco de Dados:</strong> ${bancos.join(', ')}</p>`);

  const dv = filtrar(devops);
  if (dv.length) linhas.push(`<p class="skills-line"><strong>DevOps:</strong> ${dv.join(', ')}, CI/CD, Git</p>`);

  if (metodologias.length) linhas.push(`<p class="skills-line"><strong>Metodologias:</strong> ${metodologias.join(', ')}</p>`);

  return linhas.join('\n');
}

// ========== PROMPT PARA O GEMINI ==========

function buildTailoringPrompt(htmlBase: string, descricaoVaga: string, perfil: Perfil): string {
  return `Voce e um especialista em otimizacao de curriculos para sistemas ATS (Applicant Tracking System).

Sua tarefa: receber um curriculo HTML e a descricao de uma vaga, e REORGANIZAR o curriculo para maximizar a compatibilidade com a vaga.

## REGRAS ABSOLUTAS (VIOLACAO = FALHA)

1. SOMENTE use informacoes que existem no perfil do candidato abaixo. Voce NAO PODE inventar NADA.
2. NAO adicione tecnologias, frameworks, ferramentas ou habilidades que o candidato NAO possui.
3. NAO mude datas, nomes de empresas ou cargos.
4. NAO exagere responsabilidades ou invente projetos.
5. NAO adicione certificacoes, cursos ou formacoes que nao existem no perfil.

## O QUE VOCE PODE FAZER

1. REESCREVER o resumo profissional para destacar aspectos relevantes para esta vaga especifica (usando apenas fatos reais do perfil).
2. REORDENAR os bullet points das experiencias para colocar os mais relevantes primeiro.
3. REESCREVER bullet points para enfatizar aspectos que coincidem com a vaga (sem mudar o significado).
4. REORDENAR as categorias de skills para colocar as mais relevantes primeiro.
5. REMOVER bullet points irrelevantes (mantenha no minimo 3 por experiencia).

## PERFIL REAL DO CANDIDATO (FONTE DA VERDADE)

Tecnologias reais: ${perfil.stack_principal.join(', ')}
Bancos de dados reais: ${(perfil.bancos_de_dados ?? []).join(', ')}
Metodologias reais: ${(perfil.metodologias ?? []).join(', ')}
Anos de experiencia: ${perfil.anos_experiencia}
Experiencias:
${(perfil.experiencias ?? []).map(e => `- ${e.empresa} (${e.cargo}, ${e.periodo}): ${e.descricao}`).join('\n')}

## DESCRICAO DA VAGA

${descricaoVaga}

## CURRICULO HTML ATUAL

${htmlBase}

## INSTRUCAO FINAL

Retorne APENAS o HTML completo do curriculo otimizado. Sem explicacoes, sem markdown, sem comentarios. Apenas o HTML puro (comecando com <!DOCTYPE html> e terminando com </html>).

LEMBRETE FINAL: Se a vaga pedir uma tecnologia que o candidato NAO tem, NAO a adicione. Apenas destaque as tecnologias que ele TEM e que coincidem com a vaga.`;
}

// ========== GERACAO DO CURRICULO ==========

export async function gerarCurriculoTailored(
  geminiApiKey: string,
  geminiModel: string,
  perfil: Perfil,
  descricaoVaga: string,
): Promise<{ caminhoPDF: string; caminhoHTML: string; fonte: 'gerado' | 'cache' }> {
  // Gera hash da descrição para cache
  const hash = createHash('md5').update(descricaoVaga.substring(0, 500)).digest('hex').substring(0, 12);
  const cacheKey = hash;

  // Verifica cache em memória
  if (cacheGerados.has(cacheKey)) {
    const caminhoPDF = cacheGerados.get(cacheKey)!;
    log('TOOL', `Curriculo tailored encontrado em cache: ${caminhoPDF}`);
    return { caminhoPDF, caminhoHTML: caminhoPDF.replace('.pdf', '.html'), fonte: 'cache' };
  }

  // Verifica cache em disco
  if (!existsSync(TAILORED_DIR)) {
    mkdirSync(TAILORED_DIR, { recursive: true });
  }

  const nomePDF = `curriculo_${hash}.pdf`;
  const nomeHTML = `curriculo_${hash}.html`;
  const caminhoPDF = path.join(TAILORED_DIR, nomePDF);
  const caminhoHTML = path.join(TAILORED_DIR, nomeHTML);

  if (existsSync(caminhoPDF)) {
    log('TOOL', `Curriculo tailored encontrado em disco: ${nomePDF}`);
    cacheGerados.set(cacheKey, caminhoPDF);
    return { caminhoPDF, caminhoHTML, fonte: 'cache' };
  }

  // Anonimiza PII antes de enviar ao LLM
  const { perfilAnonimo, mapa } = anonimizarPerfil(perfil);

  // Gerar HTML base com dados anonimizados (vai no prompt para o LLM)
  const htmlBase = gerarHTMLBase(perfilAnonimo);

  // Chamar LLM para otimizar o HTML
  log('TOOL', `Gerando curriculo tailored para vaga (hash: ${hash})...`);

  const prompt = buildTailoringPrompt(htmlBase, descricaoVaga, perfilAnonimo);

  let htmlOtimizado: string;

  try {
    const response = await gerarTextoAux(prompt, 'curriculo_tailored');

    htmlOtimizado = response.text;

    // Limpar possíveis artefatos de markdown
    if (htmlOtimizado.startsWith('```html')) {
      htmlOtimizado = htmlOtimizado.slice(7);
    }
    if (htmlOtimizado.startsWith('```')) {
      htmlOtimizado = htmlOtimizado.slice(3);
    }
    if (htmlOtimizado.endsWith('```')) {
      htmlOtimizado = htmlOtimizado.slice(0, -3);
    }
    htmlOtimizado = htmlOtimizado.trim();

    if (!htmlOtimizado.includes('<!DOCTYPE html') && !htmlOtimizado.includes('<html')) {
      throw new Error('Gemini retornou resposta que nao e HTML valido');
    }

    // Restaura dados reais (nome, email, telefone, links) no HTML
    htmlOtimizado = desanonimizar(htmlOtimizado, mapa);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log('ERRO', `Falha ao gerar curriculo tailored: ${msg}`);
    throw error;
  }

  // Validar que o HTML não contém skills fabricadas
  const validacao = validarHTML(htmlOtimizado, perfil);
  if (!validacao.valido) {
    log('WARN', `Curriculo tailored rejeitado: ${validacao.motivo}`);
    log('WARN', 'Usando HTML base sem tailoring como fallback de seguranca.');
    htmlOtimizado = htmlBase.replace('{{RESUMO}}', perfil.resumo_profissional);
  }

  // Salvar HTML
  writeFileSync(caminhoHTML, htmlOtimizado);
  log('TOOL', `HTML tailored salvo: ${nomeHTML}`);

  // Converter HTML → PDF via Chrome headless
  try {
    const chromePath = detectarChrome();
    execSync(
      `"${chromePath}" --headless=new --disable-gpu --no-sandbox --print-to-pdf="${caminhoPDF}" --no-pdf-header-footer "file://${caminhoHTML}"`,
      { timeout: 15000, stdio: 'pipe' },
    );
    log('TOOL', `PDF tailored gerado: ${nomePDF}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log('ERRO', `Falha ao converter HTML→PDF: ${msg}`);
    log('WARN', 'Tentando metodo alternativo (copia do HTML como fallback)...');

    // Fallback: copiar o HTML original como PDF não é possível,
    // mas podemos retornar o HTML para upload manual
    throw new Error(`Falha na conversao PDF. HTML disponivel em: ${caminhoHTML}`);
  }

  cacheGerados.set(cacheKey, caminhoPDF);
  return { caminhoPDF, caminhoHTML, fonte: 'gerado' };
}

// ========== VALIDACAO ANTI-FABRICACAO ==========

function validarHTML(html: string, perfil: Perfil): { valido: boolean; motivo: string } {
  const htmlLower = html.toLowerCase();

  // Lista de tecnologias suspeitas (que o candidato NÃO tem)
  const techsSuspeitas = [
    'python', 'django', 'flask', 'fastapi',
    'golang', 'go lang', 'rust',
    'c#', 'c sharp', '.net', 'asp.net',
    'angular', 'vue.js', 'vuejs', 'svelte',
    'kubernetes', 'k8s', 'terraform', 'ansible',
    'aws certified', 'azure certified', 'gcp certified',
    'machine learning', 'deep learning', 'tensorflow', 'pytorch',
    'scala', 'kotlin', 'swift', 'objective-c',
    'php', 'laravel', 'symfony',
    'ruby', 'rails',
    'elasticsearch', 'redis', 'kafka', 'rabbitmq',
    'graphql',
    'spring boot', 'spring cloud', 'spring security',
    'microservices architecture', 'event-driven architecture',
    'clean architecture', 'hexagonal architecture', 'ddd',
  ];

  // Verificar skills que o candidato realmente tem (para não dar falso positivo)
  const skillsReais = [
    ...perfil.stack_principal,
    ...(perfil.bancos_de_dados ?? []),
    ...(perfil.metodologias ?? []),
    'api', 'rest', 'restful', 'ci/cd', 'git', 'oauth', 'keycloak',
    'firebase', 'clicksign', 'i18n', 'camunda', 'bpm',
  ].map(s => s.toLowerCase());

  const fabricadas: string[] = [];
  for (const tech of techsSuspeitas) {
    if (htmlLower.includes(tech)) {
      // Verificar se não é uma skill real do candidato
      const ehReal = skillsReais.some(s => s.toLowerCase().includes(tech) || tech.includes(s.toLowerCase()));
      if (!ehReal) {
        fabricadas.push(tech);
      }
    }
  }

  if (fabricadas.length > 0) {
    return {
      valido: false,
      motivo: `Tecnologias fabricadas detectadas: ${fabricadas.join(', ')}`,
    };
  }

  return { valido: true, motivo: '' };
}

// ========== DETECÇÃO DO CHROME ==========

function detectarChrome(): string {
  const candidatos = [
    'google-chrome',
    'google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    'chromium-browser',
    'chromium',
  ];

  for (const candidato of candidatos) {
    try {
      execSync(`which ${candidato}`, { stdio: 'pipe' });
      return candidato;
    } catch {
      // Tentar próximo
    }
  }

  return 'google-chrome'; // Fallback
}
