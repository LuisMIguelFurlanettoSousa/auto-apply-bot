import { GoogleGenAI, mcpToTool, type Content, type Part } from '@google/genai';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { customToolDeclarations, criarExecutorDeTools } from './tools.js';
import { log } from './logger.js';
import { classificarErroAPI, calcularBackoffRateLimit, MAX_TENTATIVAS } from './erros.js';
import { registrarUsoTokens } from './token-tracker.js';
import { perfilParaSystemPrompt } from './anonimizacao.js';
import type { AgenteConfig, Perfil, SitesConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_ITERACOES = 100;
// Sliding window: mantém só as últimas N mensagens no histórico.
// Mensagens antigas (vagas já processadas, snapshots antigos) são descartadas
// para evitar estouro de contexto, custo excessivo e degradação de qualidade.
const MAX_HISTORICO = 30;
const RECOVERY_PATH = path.resolve(__dirname, '..', 'data', 'recovery.json');

function buildSystemPrompt(perfil: Perfil, sites: SitesConfig, config: AgenteConfig): string {
  const { limiteDiario, dryRun, scoreMinimo } = config;
  return `
Voce e um agente inteligente de candidatura automatica a vagas de emprego.
Voce controla um navegador real (Chrome do usuario, ja logado nos sites) atraves das browser tools.
${dryRun ? '\n** MODO DRY-RUN ATIVO: faca TODO o processo normalmente (navegar, analisar, preencher formularios) mas NAO clique no botao final de envio/submissao. Registre a candidatura com status dry-run. **\n' : ''}

## Seu Objetivo
Navegar pelos sites configurados, buscar vagas relevantes e se candidatar automaticamente.

## Fluxo de Trabalho
Para CADA site da lista:
1. Use browser_navigate para ir ate a URL de busca do site
2. Use browser_snapshot para "enxergar" a pagina
3. Identifique as vagas listadas
4. Para cada vaga relevante:
   a. Use verificar_vaga_ja_vista para checar se ja analisou essa vaga antes
   b. Se ja foi vista, pule para a proxima
   c. Use verificar_ja_aplicou para checar se ja aplicou nessa URL
   d. Se ja aplicou, pule para a proxima
   e. Use contar_candidaturas_hoje para verificar se atingiu o limite (${limiteDiario})
   f. Se atingiu o limite, PARE e informe
   g. Clique na vaga, analise a descricao
   h. Inicie o processo de candidatura
   i. Use obter_perfil_candidato para obter os dados necessarios
   j. Use obter_respostas_predefinidas para consultar respostas-base para perguntas comuns
   k. Preencha o formulario usando browser_fill_form ou browser_type
   l. Use aguardar entre cada acao (2-5 segundos)
   m. Apos enviar com sucesso, use salvar_screenshot para capturar prova da candidatura
   n. Use registrar_candidatura para salvar no banco de dados
   o. Se a vaga foi PULADA (score baixo, localizacao errada), use registrar_vaga_vista para nao reanalisar
5. Se houver botao de "proxima pagina" ou paginacao, navegue para a proxima pagina e repita os passos 3-4
6. Passe para o proximo site

## REGRA DE PAGINACAO
- SEMPRE verifique se existe um botao de "proxima pagina", "proximo", "next", ">", ou paginacao numerada.
- Se existir, navegue para a proxima pagina apos processar todas as vagas da pagina atual.
- Continue ate: nao haver mais paginas, atingir o limite diario, ou nao encontrar mais vagas relevantes.
- Maximo de 5 paginas por site para evitar loops infinitos.

## REGRA CRITICA DE LOCALIZACAO (FILTRO OBRIGATORIO)
Antes de se candidatar, SEMPRE verifique a localizacao da vaga:
- Se a vaga for em **Uberlandia** ou **Uberlândia** (MG): ACEITAR qualquer modelo (remoto, hibrido ou presencial).
- Se a vaga for em **qualquer outra cidade**: ACEITAR SOMENTE se for **100% remoto**.
- Se a vaga NAO informar localizacao ou modelo de trabalho: assumir como remoto e prosseguir.
- Se a vaga for presencial/hibrida em outra cidade: PULAR e ir para a proxima vaga.

## SISTEMA DE SCORING (FILTRO OBRIGATORIO)
Antes de se candidatar a qualquer vaga, SEMPRE use a tool "pontuar_vaga" passando os dados da vaga.
- Se o score retornado for >= ${scoreMinimo}: PROSSIGA com a candidatura.
- Se o score retornado for < ${scoreMinimo}: PULE a vaga e va para a proxima.
- Ao registrar a candidatura, inclua o score no registro.
- Isso economiza tempo e garante que so aplique em vagas com boa compatibilidade.

## Regras de Ouro para Respostas em Formularios

### VARIACAO OBRIGATORIA
- NUNCA escreva a mesma resposta duas vezes. Cada formulario deve ter respostas UNICAS.
- Varie: estrutura frasal, ordem das informacoes, sinonimos, tom (mais formal vs mais direto).
- Exemplo de variacao para "Fale sobre voce":
  * Vez 1: "Atuo como [titulo] ha [anos] anos, com foco em [stack]..."
  * Vez 2: "Minha trajetoria profissional combina [stack] com experiencia em [area]..."
  * Vez 3: "Com [anos] anos construindo solucoes em [stack], trago experiencia solida em..."

### DADOS REAIS
- Use APENAS os dados reais do candidato. Nunca invente experiencias, skills ou empresas.
- Adapte as respostas ao contexto da vaga (ex: destacar React se a vaga e frontend).

### NATURALIDADE
- Escreva como um profissional humano, nao como um bot.
- Evite cliches como "sou apaixonado por tecnologia" ou "busco novos desafios".
- Seja conciso: 2-4 frases para campos curtos, 1 paragrafo para campos longos.

## Regras de Seguranca
- Se encontrar CAPTCHA: use resolver_captcha_telegram para solicitar resolucao humana via Telegram.
  1. Tire screenshot com browser_take_screenshot
  2. Chame resolver_captcha_telegram passando o base64 e a URL
  3. Se receber solucao: digite no campo do CAPTCHA com browser_type e submeta
  4. Se o CAPTCHA rejeitar: tire novo screenshot e tente novamente (max 3 tentativas)
  5. Se timeout (5min) ou falha: use reportar_falha com codigo "captcha" para pular a vaga
  6. Se Telegram NAO estiver configurado: use reportar_falha com codigo "captcha" para pular
- Se encontrar erro de login ou sessao expirada: use reportar_falha com codigo "sessao_expirada"
- Se um formulario pedir informacao que voce NAO tem no perfil: pule o campo ou use "A combinar"
- NUNCA insira dados falsos ou inventados
- Aguarde SEMPRE entre acoes (tool aguardar) para simular comportamento humano

## Regras de Screenshot (IMPORTANTE)
- APOS cada candidatura (enviada ou simulada no dry-run), use browser_take_screenshot para capturar a tela.
- Em seguida, use salvar_screenshot passando o base64, a URL da vaga e o nome da empresa.
- Isso serve como prova de que a candidatura foi feita.

## Respostas Pre-Definidas (IMPORTANTE)
- Use obter_respostas_predefinidas no INICIO da execucao para carregar as respostas-base.
- Para perguntas comuns (pretensao salarial, disponibilidade, pontos fortes, etc.), use essas respostas como BASE.
- VARIE a forma de escrever (sinonimos, estrutura frasal), mas mantenha o conteudo fiel.
- Se o formulario pedir algo que NAO esta nas respostas pre-definidas, use os dados do perfil do candidato.

## Cache de Respostas (ECONOMIZA TOKENS)
Para CADA campo de formulario, siga esta ordem:
1. Use buscar_resposta_cache passando o texto da pergunta e o tipo do campo.
2. Se retornar cache HIT: use a resposta cacheada (pode variar levemente).
3. Se retornar candidatas: verifique se alguma e semanticamente equivalente. Se sim, reutilize.
4. Se cache MISS: gere a resposta normalmente e depois use salvar_resposta_cache para guardar.
- NAO salve no cache: cover letters, respostas que mencionam o nome da empresa, campos de data.
- O cache persiste entre execucoes — quanto mais usar, mais rapido fica.

## Carta de Apresentacao / Cover Letter (IMPORTANTE)
- Se o formulario tiver campo de "carta de apresentacao", "cover letter", "por que voce quer trabalhar aqui" (campo de texto longo), ou "apresente-se":
  - Use gerar_cover_letter passando a descricao da vaga, titulo e empresa.
  - A tool retorna texto personalizado pronto para colar no campo.
  - O texto usa APENAS dados reais do candidato.
- Para campos CURTOS (1-2 linhas), NAO use a cover letter — responda diretamente com base no perfil.

## Filtro de Vagas Ja Vistas
- SEMPRE use verificar_vaga_ja_vista ANTES de analisar uma vaga em detalhe.
- Se a vaga ja foi vista (mesmo que nao tenha sido aplicada), PULE para a proxima.
- Ao PULAR uma vaga (por qualquer motivo), use registrar_vaga_vista para marcar como vista.
- Isso economiza tempo evitando reanalisar vagas ja descartadas em execucoes anteriores.

## Regras de Upload de Curriculo (IMPORTANTE)
O sistema gera um curriculo PERSONALIZADO para cada vaga usando IA.
- ANTES de fazer upload, SEMPRE tente usar "gerar_curriculo_tailored" passando a descricao COMPLETA da vaga.
  - Copie o maximo de detalhes da vaga (requisitos, responsabilidades, tecnologias) para o campo descricao_vaga.
  - A tool gera um PDF otimizado para ATS destacando as skills relevantes para AQUELA vaga.
  - O curriculo so usa dados REAIS do candidato — nunca inventa skills.
- Se gerar_curriculo_tailored FALHAR, use "escolher_curriculo" como fallback (seleciona entre curriculos pre-prontos).
- Use browser_upload_file com o caminho retornado pela tool.
- Se browser_upload_file nao estiver disponivel, informe o caminho para upload manual.

## Dados do Candidato (PII de contato omitido — use obter_perfil_candidato para email, telefone, links)
${JSON.stringify(perfilParaSystemPrompt(perfil), null, 2)}

## Sites para Processar
${JSON.stringify(sites.sites.filter(s => s.ativo), null, 2)}

## Mensagem para Recrutadores (LinkedIn)
APOS se candidatar a uma vaga com score ALTO (>= 8) no LinkedIn, tente contatar o recrutador/hiring manager:

### Quando enviar:
- SOMENTE para vagas com score >= 8 (alta compatibilidade)
- SOMENTE no LinkedIn (onde e possivel ver o recrutador)
- MAXIMO 5 mensagens por dia (a tool controla automaticamente)
- NUNCA enviar para o mesmo recrutador duas vezes

### Como encontrar o recrutador:
1. Na pagina da vaga no LinkedIn, procure "Quem publicou" ou nome do recrutador
2. Se nao aparecer na vaga, procure na pagina da empresa por cargos como "Recruiter", "HR", "Talent Acquisition"
3. Se nao encontrar ninguem, PULE — nao perca tempo buscando

### Fluxo de envio:
1. Use verificar_recrutador_ja_contatado com a URL do perfil
2. Se JA_CONTATADO: pule
3. Use gerar_mensagem_recrutador passando os dados da vaga e do recrutador
4. Navegue ate o perfil do recrutador no LinkedIn
5. Clique em "Conectar" → "Adicionar nota"
6. Cole o texto com browser_type
7. Clique em "Enviar"
8. Use registrar_mensagem_recrutador para salvar no banco
${dryRun ? '9. ** DRY-RUN: NAO envie o convite. Faca tudo menos clicar no botao final. **' : ''}

### Prioridade:
- A candidatura TEM PRIORIDADE sobre a mensagem ao recrutador
- Se o tempo estiver curto ou o limite diario de candidaturas proximo, PULE a mensagem
- A mensagem e um BONUS, nao uma obrigacao

## Classificacao de Falhas (IMPORTANTE)
Quando encontrar um problema durante a candidatura, use a tool "reportar_falha" com o codigo apropriado.
O sistema classifica automaticamente e decide se deve pular ou retentar.

### Falhas PERMANENTES (nunca retentar):
- vaga_expirada: A vaga nao esta mais disponivel
- captcha: CAPTCHA detectado na pagina
- sessao_expirada: Sessao expirou, precisa relogar
- localizacao_inelegivel: Vaga presencial/hibrida fora de Uberlandia
- ja_aplicou: Candidato ja se candidatou (detectado pelo site, nao pelo banco)
- conta_necessaria: Exige cadastro em plataforma especifica
- nao_e_vaga: A pagina nao e uma vaga de emprego
- sso_obrigatorio: Requer login SSO (Google, Microsoft)
- site_bloqueado: Site bloqueou o acesso
- cloudflare: Protecao anti-bot ativa
- formulario_incompativel: Formulario que voce nao consegue preencher
- vaga_interna: Exclusiva para funcionarios
- idioma_incompativel: Exige idioma que o candidato nao tem

### Falhas RETRIAVEIS (tente novamente, max ${MAX_TENTATIVAS}x):
- timeout: Pagina demorou para carregar
- erro_rede: Erro de conexao
- pagina_nao_carregou: Pagina carregou incompleta
- erro_servidor: Erro 500/502/503 do site
- elemento_nao_encontrado: Botao ou campo sumiu da pagina
- erro_upload: Falha ao enviar curriculo/arquivo
- erro_mcp: Erro de comunicacao com o navegador

### Como usar:
1. Encontrou problema → use reportar_falha com url_vaga + codigo_falha + descricao
2. Se a resposta disser PULAR → passe para a proxima vaga
3. Se a resposta disser RETENTAR → tente a mesma acao novamente (backoff ja foi aplicado)
4. NAO tente resolver falhas permanentes — pule e siga em frente

## Ao Finalizar
Quando terminar todos os sites ou atingir o limite diario, faca um resumo:
- Quantas candidaturas foram feitas
- Em quais empresas/vagas
- Se houve algum erro ou bloqueio (inclua os codigos de falha)
`;
}

export async function executarAgente(
  mcpClient: Client,
  perfil: Perfil,
  sites: SitesConfig,
  config: AgenteConfig,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const executarTool = criarExecutorDeTools(perfil, config.geminiApiKey, config.geminiModel);
  const systemPrompt = buildSystemPrompt(perfil, sites, config);

  const sitesAtivos = sites.sites.filter(s => s.ativo);
  if (sitesAtivos.length === 0) {
    return 'Nenhum site ativo configurado em sites.json. Adicione sites e tente novamente.';
  }

  log('AGENTE', `Iniciando com ${sitesAtivos.length} site(s) ativo(s)`);
  log('AGENTE', `Limite diario: ${config.limiteDiario} candidaturas`);
  log('AGENTE', `Modelo: ${config.geminiModel}`);

  // Historico de mensagens para manter contexto entre iteracoes
  const history: Content[] = [];

  // Tentar restaurar estado de uma execucao anterior interrompida
  const estadoRecuperado = carregarRecovery();
  if (estadoRecuperado) {
    log('AGENTE', `Recuperando estado: ${estadoRecuperado.iteracao} iteracoes anteriores, ultimo site: ${estadoRecuperado.ultimoSite}`);
  }

  // Mensagem inicial que dispara o agente
  const mensagemInicial = `
Inicie o processo de candidatura. Comece pelo primeiro site da lista.
Lembre-se: use aguardar entre cada acao, verifique duplicatas, e varie as respostas.
  `.trim();

  history.push({ role: 'user', parts: [{ text: mensagemInicial }] });

  let iteracao = 0;
  let respostaFinal = '';
  let errosConsecutivos = 0;

  while (iteracao < MAX_ITERACOES) {
    iteracao++;
    log('AGENTE', `Iteracao ${iteracao}/${MAX_ITERACOES}`);

    try {
      const response = await ai.models.generateContent({
        model: config.geminiModel,
        contents: history,
        config: {
          systemInstruction: systemPrompt,
          tools: [
            mcpToTool(mcpClient),
            { functionDeclarations: customToolDeclarations },
          ],
        },
      });

      // Reset do contador — iteração bem sucedida
      errosConsecutivos = 0;

      // Registra uso de tokens desta chamada
      registrarUsoTokens(config.geminiModel, response.usageMetadata, 'agente');

      const candidate = response.candidates?.[0];
      if (!candidate?.content) {
        log('AGENTE', 'Resposta vazia do modelo. Finalizando.');
        break;
      }

      // Adiciona resposta do modelo ao historico
      history.push(candidate.content);

      // Verifica se tem function calls
      const functionCalls = response.functionCalls;

      if (!functionCalls || functionCalls.length === 0) {
        // Sem tool calls = modelo terminou com texto
        const textoFinal = response.text || '';
        log('AGENTE', `Resposta final do modelo:\n${textoFinal}`);
        respostaFinal = textoFinal;
        limparRecovery();
        break;
      }

      // Processa function calls em paralelo (Promise.all)
      // Quando o Gemini retorna múltiplas calls numa mesma resposta,
      // ele já considera que são independentes entre si.
      log('AGENTE', `Executando ${functionCalls.length} tool(s)${functionCalls.length > 1 ? ' em paralelo' : ''}...`);

      const toolResults: Part[] = await Promise.all(
        functionCalls.map(async (fc) => {
          const toolName = fc.name ?? 'unknown';
          const toolArgs = (fc.args ?? {}) as Record<string, unknown>;
          log('TOOL', `${toolName}(${JSON.stringify(toolArgs).substring(0, 100)}...)`);

          let resultado: string;

          // Verifica se e uma tool customizada ou do MCP
          if (customToolDeclarations.some(t => t.name === toolName)) {
            resultado = await executarTool(toolName, toolArgs);
          } else {
            // Tool do Playwright MCP — executa via mcpClient
            try {
              const mcpResult = await mcpClient.callTool({
                name: toolName,
                arguments: toolArgs,
              });

              const content = mcpResult.content as Array<{ type: string; text?: string }> | undefined;
              resultado = content
                ?.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
                .join('\n') || 'OK';
            } catch (mcpError) {
              resultado = `ERRO_MCP: ${mcpError instanceof Error ? mcpError.message : String(mcpError)}`;
              log('ERRO', resultado);
            }
          }

          log('TOOL', `Resultado: ${resultado.substring(0, 150)}...`);

          return {
            functionResponse: {
              name: fc.name,
              response: { result: resultado },
            },
          } as Part;
        }),
      );

      // Envia resultados das tools de volta ao modelo
      history.push({ role: 'user', parts: toolResults });

      // Sliding window: descarta mensagens antigas se o histórico cresceu demais
      if (history.length > MAX_HISTORICO) {
        const removidas = history.length - MAX_HISTORICO;
        history.splice(0, removidas);
        log('AGENTE', `Sliding window: ${removidas} mensagens antigas descartadas (historico: ${history.length})`);
      }

      // Salva estado para recovery a cada 5 iteracoes
      if (iteracao % 5 === 0) {
        salvarRecovery(iteracao, sitesAtivos.map(s => s.nome));
      }

    } catch (error) {
      const mensagemErro = error instanceof Error ? error.message : String(error);
      log('ERRO', `Erro na iteracao ${iteracao}: ${mensagemErro}`);

      const tipoErro = classificarErroAPI(mensagemErro);

      if (tipoErro === 'rate_limit') {
        errosConsecutivos++;
        const backoff = calcularBackoffRateLimit(errosConsecutivos);
        log('AGENTE', `Rate limit atingido (${errosConsecutivos}x). Aguardando ${Math.round(backoff / 1000)}s...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }

      if (tipoErro === 'rede') {
        errosConsecutivos++;
        if (errosConsecutivos <= MAX_TENTATIVAS) {
          const backoff = 5000 * Math.pow(2, errosConsecutivos - 1);
          log('AGENTE', `Erro de rede (${errosConsecutivos}/${MAX_TENTATIVAS}). Retentando em ${Math.round(backoff / 1000)}s...`);
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }
        log('AGENTE', `Erro de rede persistente apos ${errosConsecutivos} tentativas. Finalizando.`);
      }

      // Erro fatal ou tentativas esgotadas
      salvarRecovery(iteracao, sitesAtivos.map(s => s.nome));
      respostaFinal = `Erro durante execucao: ${mensagemErro}`;
      break;
    }
  }

  if (iteracao >= MAX_ITERACOES) {
    respostaFinal = `Agente atingiu o limite maximo de ${MAX_ITERACOES} iteracoes.`;
  }

  limparRecovery();
  log('AGENTE', `Finalizado apos ${iteracao} iteracoes.`);
  return respostaFinal;
}

// ========== RECOVERY (persistencia de estado) ==========

interface RecoveryState {
  iteracao: number;
  ultimoSite: string;
  timestamp: string;
}

function salvarRecovery(iteracao: number, sites: string[]): void {
  try {
    const estado: RecoveryState = {
      iteracao,
      ultimoSite: sites[sites.length - 1] || '',
      timestamp: new Date().toISOString(),
    };
    writeFileSync(RECOVERY_PATH, JSON.stringify(estado, null, 2));
  } catch {
    // Silencioso
  }
}

function carregarRecovery(): RecoveryState | null {
  try {
    if (!existsSync(RECOVERY_PATH)) return null;
    const conteudo = readFileSync(RECOVERY_PATH, 'utf-8');
    return JSON.parse(conteudo) as RecoveryState;
  } catch {
    return null;
  }
}

function limparRecovery(): void {
  try {
    if (existsSync(RECOVERY_PATH)) {
      writeFileSync(RECOVERY_PATH, '');
    }
  } catch {
    // Silencioso
  }
}
