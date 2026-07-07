import { GoogleGenAI, mcpToTool, type Content, type Part, type GenerateContentConfig } from '@google/genai';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { customToolDeclarations, criarExecutorDeTools } from './tools.js';
import { podarHistorico } from './historico.js';
import { log } from './logger.js';
import { classificarErroAPI, calcularBackoffRateLimit, MAX_TENTATIVAS } from './erros.js';
import { registrarUsoTokens, obterCustoTotal } from './token-tracker.js';
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
${dryRun ? '\n** MODO DRY-RUN ATIVO: faca TODO o processo normalmente (navegar, analisar, preencher formularios) mas NAO envie de verdade. O sistema BLOQUEIA o envio automaticamente quando voce chama confirmar_envio. Registre a candidatura com registrar_candidatura (sera gravada como dry-run). **\n' : ''}

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
   m. ANTES de clicar no botao final de envio/submissao, SEMPRE chame confirmar_envio. Se a resposta bloquear (dry-run ou teto por execucao), NAO clique no botao — siga a instrucao da mensagem.
   n. Apos enviar (ou simular no dry-run), use salvar_screenshot para capturar prova
   o. Use registrar_candidatura para salvar no banco (inclua o score da vaga)
   p. Se a vaga foi PULADA (score baixo, localizacao errada), use registrar_vaga_vista para nao reanalisar
5. Se houver botao de "proxima pagina" ou paginacao, navegue para a proxima pagina e repita os passos 3-4
6. Passe para o proximo site

## REGRA DE PAGINACAO
- SEMPRE verifique se existe um botao de "proxima pagina", "proximo", "next", ">", ou paginacao numerada.
- Se existir, navegue para a proxima pagina apos processar todas as vagas da pagina atual.
- Continue ate: nao haver mais paginas, atingir o limite diario, ou nao encontrar mais vagas relevantes.
- Maximo de 5 paginas por site para evitar loops infinitos.

## FILTRO OBRIGATORIO: pontuar_vaga
Antes de se candidatar a QUALQUER vaga, SEMPRE use a tool "pontuar_vaga" passando os dados da vaga: tecnologias_pedidas, senioridade, localizacao, modelo_trabalho e, se a vaga mencionar exigencia de ingles, idioma_exigido.
- A tool retorna: score (1-10), veredicto (APLICAR/PULAR), motivo e eliminatorios.
- Se veredicto == PULAR (por score < ${scoreMinimo} OU por qualquer eliminatorio): PULE a vaga e va para a proxima. NAO insista.
- Se veredicto == APLICAR: prossiga com a candidatura.
- A tool JA considera a cidade, os modelos de trabalho aceitos e o nivel de ingles do candidato (do perfil). Confie no veredicto dela — NAO aplique regras de localizacao manualmente. Se o perfil tiver uma "regra_localizacao" especifica, respeite-a tambem.
- Ao registrar a candidatura, inclua SEMPRE o score (o sistema recusa registros abaixo do minimo).

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
- ENVIO (CRITICO): antes de QUALQUER clique de envio final (candidatar-se, enviar, submeter, finalizar) ou de enviar convite/mensagem ao recrutador, SEMPRE chame confirmar_envio primeiro. O sistema decide se libera (e a trava de seguranca do usuario). NUNCA clique no botao final sem passar por confirmar_envio.
- Se encontrar CAPTCHA ou desafio anti-bot: use resolver_captcha_telegram para pedir resolucao MANUAL do humano. (reCAPTCHA/Turnstile NAO tem "solucao de texto" para digitar — quem resolve e o humano, no proprio Chrome aberto.)
  1. Tire screenshot com browser_take_screenshot
  2. Chame resolver_captcha_telegram passando o base64 e a URL (o humano resolve no Chrome e responde OK ou PULAR)
  3. Se status == RESOLVIDO: use browser_snapshot para REVERIFICAR a pagina e, se o desafio sumiu, continue a candidatura
  4. Se status == PULAR ou TIMEOUT: use reportar_falha com codigo "captcha" (ou "portal_bloqueado" se o bloqueio foi na pagina de busca) para pular
  5. Se Telegram NAO estiver configurado: use reportar_falha com codigo "captcha"/"portal_bloqueado"
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
7. ANTES de clicar em "Enviar", chame confirmar_envio (acao: "mensagem ao recrutador"). Se bloquear (dry-run ou teto), NAO envie o convite e siga.
8. Clique em "Enviar"
9. Use registrar_mensagem_recrutador para salvar no banco

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
- localizacao_inelegivel: Vaga presencial/hibrida fora da regra de localizacao do candidato
- ja_aplicou: Candidato ja se candidatou (detectado pelo site, nao pelo banco)
- conta_necessaria: Exige cadastro em plataforma especifica
- nao_e_vaga: A pagina nao e uma vaga de emprego
- sso_obrigatorio: Requer login SSO (Google, Microsoft)
- site_bloqueado: Site bloqueou o acesso
- cloudflare: Protecao anti-bot ativa
- portal_bloqueado: Bloqueio (Cloudflare/CAPTCHA/login) na PAGINA DE BUSCA/LISTAGEM, antes de ver as vagas. O sistema ABANDONA o portal inteiro e voce vai para o proximo site — NAO insista em outras URLs/paginas deste portal. (Se o bloqueio for numa vaga especifica, use o codigo especifico como captcha.)
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

/**
 * Monta o `config` da chamada `generateContent`.
 *
 * O agente despacha as function calls MANUALMENTE (ver loop em executarAgente),
 * então o automatic function calling (AFC) do SDK precisa ficar DESLIGADO. Com o
 * AFC ligado — o padrão quando há um objeto MCP na lista de tools — o
 * @google/genai recusa misturar o objeto MCP (CallableTool) com
 * functionDeclarations básicas no mesmo array `tools`, lançando "Automatic
 * function calling with CallableTools (or MCP objects) and basic
 * FunctionDeclarations is not yet supported. Incompatible tools found at
 * tools[1]". Desligar o AFC faz o SDK apenas EXPOR as declarações ao modelo
 * (inclusive as do MCP, convertidas por mcpToTool) e devolver os functionCalls
 * para o nosso loop despachar — que é o comportamento desejado.
 */
export function construirConfigGeracao(
  mcpClient: Client,
  systemPrompt: string,
): GenerateContentConfig {
  return {
    systemInstruction: systemPrompt,
    automaticFunctionCalling: { disable: true },
    tools: [
      mcpToTool(mcpClient),
      { functionDeclarations: customToolDeclarations },
    ],
  };
}

export async function executarAgente(
  mcpClient: Client,
  perfil: Perfil,
  sites: SitesConfig,
  config: AgenteConfig,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const executarTool = criarExecutorDeTools(perfil, config);
  const systemPrompt = buildSystemPrompt(perfil, sites, config);

  const sitesAtivos = sites.sites.filter(s => s.ativo);
  if (sitesAtivos.length === 0) {
    return 'Nenhum site ativo configurado em sites.json. Adicione sites e tente novamente.';
  }

  log('AGENTE', `Iniciando com ${sitesAtivos.length} site(s) ativo(s)`);
  log('AGENTE', `Limite diario: ${config.limiteDiario} candidaturas`);
  log('AGENTE', `Modelo: ${config.geminiModel}`);

  // Historico de mensagens para manter contexto entre iteracoes.
  // É `let` porque o sliding window (podarHistorico) substitui o array por uma
  // versão podada e válida quando ele cresce demais.
  let history: Content[] = [];

  // Tentar restaurar estado de uma execucao anterior interrompida.
  // Não reidratamos o histórico bruto (snapshots antigos não ajudam e poderiam
  // quebrar o pareamento de function calls); em vez disso, avisamos o agente de
  // que houve interrupção. O dedup real vem do banco (vagas_vistas/candidaturas).
  const estadoRecuperado = carregarRecovery();
  let avisoRecovery = '';
  if (estadoRecuperado) {
    log('AGENTE', `Estado anterior encontrado: ${estadoRecuperado.iteracao} iteracao(oes), ultimo site: ${estadoRecuperado.ultimoSite}`);
    avisoRecovery = `\n\nATENCAO: uma execucao anterior foi interrompida (ultimo site: ${estadoRecuperado.ultimoSite}). As vagas ja vistas/aplicadas estao registradas no banco e serao puladas — use verificar_vaga_ja_vista e verificar_ja_aplicou normalmente para continuar de onde parou.`;
  }

  // Mensagem inicial que dispara o agente
  const mensagemInicial = (`
Inicie o processo de candidatura. Comece pelo primeiro site da lista.
Lembre-se: use aguardar entre cada acao, verifique duplicatas, e varie as respostas.
` + avisoRecovery).trim();

  history.push({ role: 'user', parts: [{ text: mensagemInicial }] });

  let iteracao = 0;
  let respostaFinal = '';
  let errosConsecutivos = 0;
  let saiuComErroFatal = false;

  while (iteracao < MAX_ITERACOES) {
    iteracao++;
    log('AGENTE', `Iteracao ${iteracao}/${MAX_ITERACOES}`);

    try {
      const response = await ai.models.generateContent({
        model: config.geminiModel,
        contents: history,
        config: construirConfigGeracao(mcpClient, systemPrompt),
      });

      // Reset do contador — iteração bem sucedida
      errosConsecutivos = 0;

      // Registra uso de tokens desta chamada
      registrarUsoTokens(config.geminiModel, response.usageMetadata, 'agente');

      // Circuito de parada por custo: limite economico complementar ao
      // MAX_ITERACOES (so ativo se CUSTO_MAX_USD > 0). Evita queimar dezenas de
      // chamadas caras num loop improdutivo. Limite soft (avaliado entre iteracoes).
      if (config.custoMaxUsd > 0 && obterCustoTotal() > config.custoMaxUsd) {
        log('AGENTE', `Custo maximo atingido ($${obterCustoTotal().toFixed(4)} > $${config.custoMaxUsd} USD). Finalizando.`);
        respostaFinal = `Execucao interrompida: custo maximo de $${config.custoMaxUsd} USD atingido.`;
        break;
      }

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

      // Processa as function calls SEQUENCIALMENTE.
      // As tools do Playwright MCP (browser_*) operam no MESMO navegador/aba;
      // executá-las em paralelo causaria race conditions (navegar enquanto digita,
      // screenshot de página meio-carregada, elemento sumindo do DOM). A ordem
      // também importa no preenchimento de formulários. O custo de serializar é
      // desprezível perto do risco de estados intercalados.
      log('AGENTE', `Executando ${functionCalls.length} tool(s) em sequencia...`);

      const toolResults: Part[] = [];
      for (const fc of functionCalls) {
        const toolName = fc.name ?? 'unknown';
        const toolArgs = (fc.args ?? {}) as Record<string, unknown>;
        log('TOOL', `${toolName}(${JSON.stringify(toolArgs).substring(0, 100)}...)`);

        let resultado: string;

        // try/catch por tool: uma tool que lança NÃO derruba as demais nem o
        // agente — vira um functionResponse de erro que o modelo consegue tratar.
        try {
          if (customToolDeclarations.some(t => t.name === toolName)) {
            resultado = await executarTool(toolName, toolArgs);
          } else {
            // Tool do Playwright MCP — executa via mcpClient
            const mcpResult = await mcpClient.callTool({
              name: toolName,
              arguments: toolArgs,
            });

            const content = mcpResult.content as Array<{ type: string; text?: string }> | undefined;
            resultado = content
              ?.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
              .join('\n') || 'OK';
          }
        } catch (toolError) {
          resultado = `ERRO_TOOL: ${toolError instanceof Error ? toolError.message : String(toolError)}`;
          log('ERRO', `Tool ${toolName} falhou: ${resultado}`);
        }

        log('TOOL', `Resultado: ${resultado.substring(0, 150)}...`);

        toolResults.push({
          functionResponse: {
            name: fc.name,
            response: { result: resultado },
          },
        } as Part);
      }

      // Envia resultados das tools de volta ao modelo
      history.push({ role: 'user', parts: toolResults });

      // Sliding window: poda mensagens antigas preservando a validade do
      // histórico para a API do Gemini (ver src/historico.ts).
      if (history.length > MAX_HISTORICO) {
        const antes = history.length;
        history = podarHistorico(history, MAX_HISTORICO);
        log('AGENTE', `Sliding window: ${antes - history.length} mensagens antigas descartadas (historico: ${history.length})`);
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
      saiuComErroFatal = true;
      break;
    }
  }

  if (iteracao >= MAX_ITERACOES) {
    respostaFinal = `Agente atingiu o limite maximo de ${MAX_ITERACOES} iteracoes.`;
  }

  // Só limpa o recovery se NÃO saímos por erro fatal — assim o aviso de
  // "execução anterior interrompida" sobrevive para a próxima execução.
  if (!saiuComErroFatal) {
    limparRecovery();
  }
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
      // Remove o arquivo de fato. Antes era gravada uma string vazia, o que
      // fazia carregarRecovery() sempre lançar em JSON.parse('') e nunca
      // distinguir "sem recovery" de "recovery limpo".
      unlinkSync(RECOVERY_PATH);
    }
  } catch {
    // Silencioso — não quebrar o fluxo por erro de limpeza.
  }
}
