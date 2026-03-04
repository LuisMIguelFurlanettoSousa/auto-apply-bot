import { Type, type FunctionDeclaration } from '@google/genai';
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  verificarJaAplicou,
  registrarCandidatura,
  contarCandidaturasHoje,
  listarCandidaturas,
  registrarVagaVista,
  verificarVagaJaVista,
  atualizarScreenshot,
  buscarRespostaCache,
  buscarCandidatasCache,
  salvarRespostaCache,
  sanitizarPergunta,
  verificarRecrutadorJaContatado,
  registrarMensagemRecrutador,
  contarMensagensHoje,
} from './database.js';
import { log } from './logger.js';
import { notificarCandidatura, solicitarResolucaoCaptcha } from './notificacoes.js';
import { gerarCurriculoTailored } from './curriculo-tailored.js';
import { gerarCoverLetter } from './cover-letter.js';
import { gerarMensagemRecrutador } from './mensagem-recrutador.js';
import {
  ehFalhaPermanente,
  ehFalhaRetriavel,
  calcularBackoff,
  FALHAS_PERMANENTES,
  FALHAS_RETRIAVEIS,
  MAX_TENTATIVAS,
} from './erros.js';
import type { Perfil, RespostasPredefinidas } from './types.js';

// Configuração do Gemini passada pelo index.ts na criação do executor
let _geminiApiKey = '';
let _geminiModel = '';

// Mapa de tentativas por URL para controle de retry (adaptado do ApplyPilot: attempts tracking)
const tentativasPorUrl = new Map<string, number>();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface CurriculoEntry {
  id: string;
  arquivo: string;
  foco: string;
  usar_quando: string;
}

interface CurriculosConfig {
  fallback: CurriculoEntry;
  curriculos: CurriculoEntry[];
}

function carregarCurriculos(): CurriculosConfig {
  const caminho = path.resolve(__dirname, '..', 'config', 'curriculos.json');
  return JSON.parse(readFileSync(caminho, 'utf-8'));
}

// ========== DEFINICAO DAS TOOLS ==========

export const customToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'obter_perfil_candidato',
    description:
      'Retorna todos os dados pessoais e profissionais do candidato para preencher formularios e gerar respostas personalizadas.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'verificar_ja_aplicou',
    description:
      'Verifica no banco de dados se o candidato ja se candidatou a uma vaga especifica pela URL. Retorna verdadeiro ou falso.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: {
          type: Type.STRING,
          description: 'URL completa da vaga para verificar',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'registrar_candidatura',
    description:
      'Registra no banco de dados que uma candidatura foi realizada com sucesso. Chamar APOS preencher e enviar o formulario.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        plataforma: {
          type: Type.STRING,
          description: 'Nome da plataforma (ex: Gupy, LinkedIn, Vagas.com)',
        },
        titulo_vaga: {
          type: Type.STRING,
          description: 'Titulo da vaga',
        },
        empresa: {
          type: Type.STRING,
          description: 'Nome da empresa',
        },
        url: {
          type: Type.STRING,
          description: 'URL da vaga',
        },
        mensagem_enviada: {
          type: Type.BOOLEAN,
          description: 'Se uma mensagem personalizada foi enviada ao recrutador',
        },
      },
      required: ['plataforma', 'titulo_vaga', 'empresa', 'url'],
    },
  },
  {
    name: 'contar_candidaturas_hoje',
    description:
      'Retorna quantas candidaturas ja foram feitas hoje. Use para verificar se atingiu o limite diario.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'listar_candidaturas_recentes',
    description:
      'Lista as ultimas candidaturas feitas para referencia e evitar duplicatas.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limite: {
          type: Type.NUMBER,
          description: 'Quantidade de candidaturas para retornar (padrao: 20)',
        },
      },
    },
  },
  {
    name: 'pontuar_vaga',
    description:
      'Avalia o quanto uma vaga combina com o perfil do candidato (score de 1 a 10). SEMPRE use ANTES de decidir se vai aplicar. Se o score for menor que o minimo configurado, PULE a vaga.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        titulo_vaga: {
          type: Type.STRING,
          description: 'Titulo da vaga',
        },
        empresa: {
          type: Type.STRING,
          description: 'Nome da empresa',
        },
        tecnologias_pedidas: {
          type: Type.STRING,
          description: 'Lista de tecnologias/requisitos que a vaga pede',
        },
        senioridade: {
          type: Type.STRING,
          description: 'Nivel de senioridade pedido (junior, pleno, senior, etc.)',
        },
        modelo_trabalho: {
          type: Type.STRING,
          description: 'Modelo de trabalho (remoto, hibrido, presencial)',
        },
        localizacao: {
          type: Type.STRING,
          description: 'Cidade/estado da vaga',
        },
      },
      required: ['titulo_vaga', 'tecnologias_pedidas'],
    },
  },
  {
    name: 'escolher_curriculo',
    description:
      'Escolhe o curriculo mais adequado para a vaga com base na descricao. Retorna o caminho do PDF correto para upload. SEMPRE use esta tool ANTES de fazer upload de curriculo.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        descricao_vaga: {
          type: Type.STRING,
          description: 'Resumo da descricao da vaga (tecnologias pedidas, tipo de cargo, area de atuacao)',
        },
      },
      required: ['descricao_vaga'],
    },
  },
  {
    name: 'aguardar',
    description:
      'Aguarda um tempo aleatorio entre acoes para simular comportamento humano. SEMPRE use entre acoes de navegacao.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        min_ms: {
          type: Type.NUMBER,
          description: 'Tempo minimo em milissegundos (padrao: 2000)',
        },
        max_ms: {
          type: Type.NUMBER,
          description: 'Tempo maximo em milissegundos (padrao: 5000)',
        },
      },
    },
  },
  {
    name: 'salvar_screenshot',
    description:
      'Salva o screenshot atual da pagina como prova da candidatura. Use APOS submeter (ou simular no dry-run) a candidatura. Passe os dados base64 do screenshot obtido via browser_take_screenshot.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url_vaga: {
          type: Type.STRING,
          description: 'URL da vaga para associar o screenshot',
        },
        screenshot_base64: {
          type: Type.STRING,
          description: 'Dados base64 do screenshot (obtido via browser_take_screenshot)',
        },
        empresa: {
          type: Type.STRING,
          description: 'Nome da empresa (para nomear o arquivo)',
        },
      },
      required: ['url_vaga', 'screenshot_base64', 'empresa'],
    },
  },
  {
    name: 'verificar_vaga_ja_vista',
    description:
      'Verifica se uma vaga ja foi vista/analisada anteriormente (mesmo que nao tenha sido aplicada). Evita perder tempo reanalisando vagas ja descartadas. Use ANTES de analisar uma vaga em detalhe.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: {
          type: Type.STRING,
          description: 'URL da vaga para verificar',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'registrar_vaga_vista',
    description:
      'Registra que uma vaga foi vista/analisada. Use para vagas que foram PULADAS (score baixo, localizacao errada, etc.) para nao reanalisar no futuro.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: {
          type: Type.STRING,
          description: 'URL da vaga',
        },
        titulo_vaga: {
          type: Type.STRING,
          description: 'Titulo da vaga',
        },
        empresa: {
          type: Type.STRING,
          description: 'Nome da empresa',
        },
        plataforma: {
          type: Type.STRING,
          description: 'Plataforma (Gupy, Vagas.com, etc.)',
        },
        score: {
          type: Type.NUMBER,
          description: 'Score calculado da vaga',
        },
        motivo_pulo: {
          type: Type.STRING,
          description: 'Motivo pelo qual a vaga foi pulada',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'obter_respostas_predefinidas',
    description:
      'Retorna as respostas pre-definidas do candidato para perguntas comuns em formularios (pretensao salarial, disponibilidade, pontos fortes, etc.). Use como BASE para variar as respostas.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'gerar_curriculo_tailored',
    description:
      'Gera um curriculo PDF personalizado para a vaga especifica. O curriculo e reescrito por IA para destacar as skills relevantes para ESTA vaga, mantendo APENAS dados reais do candidato. Use ANTES de fazer upload do curriculo. Se falhar, faca fallback para escolher_curriculo.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        descricao_vaga: {
          type: Type.STRING,
          description: 'Descricao COMPLETA da vaga (copie o maximo de detalhes: requisitos, responsabilidades, tecnologias, senioridade)',
        },
        titulo_vaga: {
          type: Type.STRING,
          description: 'Titulo da vaga (ex: Desenvolvedor Backend Java)',
        },
        empresa: {
          type: Type.STRING,
          description: 'Nome da empresa',
        },
      },
      required: ['descricao_vaga'],
    },
  },
  {
    name: 'gerar_cover_letter',
    description:
      'Gera uma carta de apresentacao personalizada para a vaga. Retorna texto pronto para colar no campo do formulario. Use quando o formulario pedir "carta de apresentacao", "cover letter", "por que voce quer trabalhar aqui" (campo longo), ou "apresente-se".',
    parameters: {
      type: Type.OBJECT,
      properties: {
        descricao_vaga: {
          type: Type.STRING,
          description: 'Descricao da vaga (requisitos, responsabilidades)',
        },
        titulo_vaga: {
          type: Type.STRING,
          description: 'Titulo da vaga',
        },
        empresa: {
          type: Type.STRING,
          description: 'Nome da empresa',
        },
      },
      required: ['descricao_vaga', 'empresa', 'titulo_vaga'],
    },
  },
  {
    name: 'buscar_resposta_cache',
    description:
      'Busca no cache se essa pergunta de formulario ja foi respondida antes. Use ANTES de gerar uma resposta nova. Se retornar um cache hit, use a resposta cacheada (pode variar levemente a forma). Economiza tokens e garante consistencia.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        pergunta: {
          type: Type.STRING,
          description: 'Texto da pergunta/label do campo do formulario',
        },
        tipo_campo: {
          type: Type.STRING,
          description: 'Tipo do campo: textbox, numeric, dropdown, radio, date, textarea',
        },
      },
      required: ['pergunta', 'tipo_campo'],
    },
  },
  {
    name: 'salvar_resposta_cache',
    description:
      'Salva uma resposta no cache para reutilizar em formularios futuros. Use APOS preencher um campo com uma resposta gerada. NAO salve: cover letters, respostas que mencionam o nome da empresa, ou campos de data especificos.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        pergunta: {
          type: Type.STRING,
          description: 'Texto da pergunta/label do campo',
        },
        tipo_campo: {
          type: Type.STRING,
          description: 'Tipo do campo: textbox, numeric, dropdown, radio, date, textarea',
        },
        resposta: {
          type: Type.STRING,
          description: 'Resposta que foi usada no campo',
        },
        empresa_atual: {
          type: Type.STRING,
          description: 'Nome da empresa da vaga atual (para validar se a resposta e generica o suficiente para cachear)',
        },
      },
      required: ['pergunta', 'tipo_campo', 'resposta'],
    },
  },
  {
    name: 'reportar_falha',
    description:
      'Reporta uma falha encontrada durante o processo de candidatura. Classifica automaticamente como PERMANENTE (nunca retentar) ou RETRIAVEL (tentar novamente). Use quando encontrar erros como: vaga expirada, CAPTCHA, timeout, erro de rede, formulario incompativel, etc. Codigos permanentes: vaga_expirada, captcha, sessao_expirada, localizacao_inelegivel, ja_aplicou, conta_necessaria, nao_e_vaga, sso_obrigatorio, site_bloqueado, cloudflare, formulario_incompativel, vaga_interna, idioma_incompativel. Codigos retriaveis: timeout, erro_rede, pagina_nao_carregou, erro_servidor, elemento_nao_encontrado, erro_upload, erro_mcp.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url_vaga: {
          type: Type.STRING,
          description: 'URL da vaga onde ocorreu a falha',
        },
        codigo_falha: {
          type: Type.STRING,
          description: 'Codigo da falha (ex: vaga_expirada, captcha, timeout, erro_rede)',
        },
        descricao: {
          type: Type.STRING,
          description: 'Descricao livre do que aconteceu',
        },
        titulo_vaga: {
          type: Type.STRING,
          description: 'Titulo da vaga (se disponivel)',
        },
        empresa: {
          type: Type.STRING,
          description: 'Nome da empresa (se disponivel)',
        },
        plataforma: {
          type: Type.STRING,
          description: 'Plataforma (Gupy, Vagas.com, etc.)',
        },
      },
      required: ['url_vaga', 'codigo_falha', 'descricao'],
    },
  },
  {
    name: 'resolver_captcha_telegram',
    description:
      'Envia screenshot de um CAPTCHA para o Telegram e aguarda o usuario humano resolver. Retorna a solucao digitada pelo usuario. Use quando encontrar um CAPTCHA que impede o progresso da candidatura. REQUER: Telegram configurado (.env). Timeout: 5 minutos.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        screenshot_base64: {
          type: Type.STRING,
          description: 'Screenshot do CAPTCHA em base64 (obtido via browser_take_screenshot)',
        },
        url_vaga: {
          type: Type.STRING,
          description: 'URL da pagina onde o CAPTCHA apareceu',
        },
      },
      required: ['screenshot_base64', 'url_vaga'],
    },
  },
  {
    name: 'gerar_mensagem_recrutador',
    description:
      'Gera uma mensagem personalizada para enviar ao recrutador/hiring manager da vaga via LinkedIn. A mensagem tem no maximo 280 caracteres (nota de conexao). Use SOMENTE quando: (1) a vaga tem score alto (>= 8), (2) voce identificou o recrutador na pagina da vaga, e (3) o recrutador NAO foi contatado antes. A mensagem usa dados REAIS do candidato e destaca intersecoes com a vaga.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        nome_recrutador: {
          type: Type.STRING,
          description: 'Nome do recrutador/hiring manager (encontrado na pagina da vaga ou perfil LinkedIn)',
        },
        cargo_recrutador: {
          type: Type.STRING,
          description: 'Cargo do recrutador (Recruiter, HR Manager, Tech Lead, etc.)',
        },
        empresa: {
          type: Type.STRING,
          description: 'Nome da empresa',
        },
        titulo_vaga: {
          type: Type.STRING,
          description: 'Titulo da vaga',
        },
        descricao_vaga: {
          type: Type.STRING,
          description: 'Descricao da vaga (requisitos, responsabilidades)',
        },
      },
      required: ['nome_recrutador', 'empresa', 'titulo_vaga', 'descricao_vaga'],
    },
  },
  {
    name: 'verificar_recrutador_ja_contatado',
    description:
      'Verifica se um recrutador ja foi contatado anteriormente (pelo URL do perfil LinkedIn). Use ANTES de gerar mensagem para evitar enviar mensagem duplicada.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url_perfil: {
          type: Type.STRING,
          description: 'URL do perfil LinkedIn do recrutador',
        },
      },
      required: ['url_perfil'],
    },
  },
  {
    name: 'registrar_mensagem_recrutador',
    description:
      'Registra no banco que uma mensagem foi enviada para um recrutador. Use APOS enviar o convite de conexao com sucesso no LinkedIn.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        nome_recrutador: {
          type: Type.STRING,
          description: 'Nome do recrutador',
        },
        cargo_recrutador: {
          type: Type.STRING,
          description: 'Cargo do recrutador',
        },
        empresa: {
          type: Type.STRING,
          description: 'Nome da empresa',
        },
        url_perfil: {
          type: Type.STRING,
          description: 'URL do perfil LinkedIn do recrutador',
        },
        url_vaga: {
          type: Type.STRING,
          description: 'URL da vaga associada',
        },
        titulo_vaga: {
          type: Type.STRING,
          description: 'Titulo da vaga',
        },
        mensagem: {
          type: Type.STRING,
          description: 'Texto da mensagem que foi enviada',
        },
        score_vaga: {
          type: Type.NUMBER,
          description: 'Score da vaga (1-10)',
        },
      },
      required: ['nome_recrutador', 'empresa', 'url_perfil', 'mensagem'],
    },
  },
];

// ========== EXECUTOR DAS TOOLS ==========

export function criarExecutorDeTools(perfil: Perfil, geminiApiKey?: string, geminiModel?: string) {
  if (geminiApiKey) _geminiApiKey = geminiApiKey;
  if (geminiModel) _geminiModel = geminiModel;
  return async function executarTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'obter_perfil_candidato': {
        return JSON.stringify(perfil, null, 2);
      }

      case 'verificar_ja_aplicou': {
        const url = args.url as string;
        const jaAplicou = verificarJaAplicou(url);
        return jaAplicou
          ? 'JA_APLICOU: O candidato ja se candidatou a esta vaga. Pule para a proxima.'
          : 'NOVA_VAGA: O candidato ainda nao se candidatou. Pode prosseguir.';
      }

      case 'registrar_candidatura': {
        const score = (args.score as number) || 0;
        const empresa = args.empresa as string;
        const tituloVaga = args.titulo_vaga as string;
        const isDryRun = !!args.dry_run;
        const sucesso = registrarCandidatura({
          plataforma: args.plataforma as string,
          titulo_vaga: tituloVaga,
          empresa,
          url: args.url as string,
          mensagem_enviada: args.mensagem_enviada ? 1 : 0,
          status: isDryRun ? 'dry-run' : 'aplicado',
          score,
        });
        if (sucesso) {
          log('AGENTE', `Candidatura registrada: ${tituloVaga} — ${empresa} (score: ${score})`);
          notificarCandidatura(empresa, tituloVaga, score, isDryRun).catch(() => {});
        }
        return sucesso
          ? 'REGISTRADO: Candidatura salva no banco de dados com sucesso.'
          : 'ERRO: Falha ao registrar candidatura (possivelmente duplicada).';
      }

      case 'contar_candidaturas_hoje': {
        const total = contarCandidaturasHoje();
        return `Total de candidaturas hoje: ${total}`;
      }

      case 'listar_candidaturas_recentes': {
        const limite = (args.limite as number) || 20;
        const candidaturas = listarCandidaturas(limite);
        return JSON.stringify(candidaturas, null, 2);
      }

      case 'pontuar_vaga': {
        const tecsPedidas = (args.tecnologias_pedidas as string).toLowerCase();
        const senioridade = ((args.senioridade as string) || '').toLowerCase();
        const localizacao = ((args.localizacao as string) || '').toLowerCase();
        const modelo = ((args.modelo_trabalho as string) || '').toLowerCase();

        let score = 5; // Base

        // Match de tecnologias (+1 por cada tech que o candidato tem)
        const minhasTechs = perfil.stack_principal.map(s => s.toLowerCase());
        for (const tech of minhasTechs) {
          if (tecsPedidas.includes(tech)) score += 1;
        }

        // Penalidades
        if (senioridade.includes('senior') || senioridade.includes('sênior')) score -= 2;
        if (senioridade.includes('pleno')) score += 1;
        if (senioridade.includes('junior') || senioridade.includes('júnior')) score += 1;

        // Localizacao
        if (localizacao.includes('uberlandia') || localizacao.includes('uberlândia')) {
          score += 1;
        } else if (modelo.includes('presencial') || modelo.includes('hibrido')) {
          score -= 3; // Fora de Uberlandia e nao remoto = penalidade forte
        }
        if (modelo.includes('remoto')) score += 1;

        // Clamp entre 1-10
        score = Math.max(1, Math.min(10, score));

        return JSON.stringify({
          score,
          veredicto: score >= 6 ? 'APLICAR' : 'PULAR',
          motivo: score >= 6
            ? `Score ${score}/10: boa compatibilidade com o perfil.`
            : `Score ${score}/10: baixa compatibilidade. Pule para a proxima vaga.`,
        });
      }

      case 'escolher_curriculo': {
        const descricao = (args.descricao_vaga as string).toLowerCase();
        const config = carregarCurriculos();

        // Mapeamento de palavras-chave para cada curriculo
        const mapeamento: Record<string, string[]> = {
          'backend-java': ['backend', 'back-end', 'back end', 'java', 'api rest', 'apis rest', 'microsservico', 'microservico', 'servidor'],
          'java-enterprise': ['corporativo', 'camunda', 'automacao de processos', 'integracao de sistemas', 'consultoria', 'gestao'],
          'full-stack-backend': ['full stack', 'fullstack', 'full-stack', 'backend', 'java', 'react'],
          'full-stack': ['full stack', 'fullstack', 'full-stack', 'ponta a ponta', 'end to end'],
          'mobile-react-native': ['mobile', 'react native', 'expo', 'ios', 'android', 'aplicativo', 'app mobile'],
        };

        let melhorMatch = '';
        let maiorScore = 0;

        for (const [id, keywords] of Object.entries(mapeamento)) {
          const score = keywords.reduce((acc, kw) => acc + (descricao.includes(kw) ? 1 : 0), 0);
          if (score > maiorScore) {
            maiorScore = score;
            melhorMatch = id;
          }
        }

        // Fallback: se nenhum score ou score muito baixo, usa o curriculo original
        if (maiorScore === 0) {
          const fallbackPath = path.resolve(__dirname, '..', config.fallback.arquivo);
          return JSON.stringify({
            curriculo_escolhido: 'original',
            foco: config.fallback.foco,
            caminho: fallbackPath,
            motivo: 'Nenhum curriculo especifico se encaixou. Usando curriculo original como fallback.',
          });
        }

        const curriculo = config.curriculos.find(c => c.id === melhorMatch);
        if (!curriculo) {
          const fallbackPath = path.resolve(__dirname, '..', config.fallback.arquivo);
          return JSON.stringify({
            curriculo_escolhido: 'original',
            foco: config.fallback.foco,
            caminho: fallbackPath,
            motivo: 'Curriculo especifico nao encontrado. Usando curriculo original como fallback.',
          });
        }

        const caminhoAbsoluto = path.resolve(__dirname, '..', curriculo.arquivo);
        return JSON.stringify({
          curriculo_escolhido: curriculo.id,
          foco: curriculo.foco,
          caminho: caminhoAbsoluto,
          motivo: `Escolhido "${curriculo.foco}" com score ${maiorScore} para a vaga descrita.`,
        });
      }

      case 'aguardar': {
        const min = (args.min_ms as number) || 2000;
        const max = (args.max_ms as number) || 5000;
        const tempo = Math.floor(Math.random() * (max - min + 1)) + min;
        await new Promise((resolve) => setTimeout(resolve, tempo));
        return `Aguardou ${tempo}ms com sucesso.`;
      }

      case 'salvar_screenshot': {
        const screenshotsDir = path.resolve(__dirname, '..', 'screenshots');
        if (!existsSync(screenshotsDir)) {
          mkdirSync(screenshotsDir, { recursive: true });
        }

        const empresaNome = (args.empresa as string).replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
        const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
        const nomeArquivo = `${timestamp}_${empresaNome}.png`;
        const caminhoCompleto = path.join(screenshotsDir, nomeArquivo);

        try {
          const base64Data = args.screenshot_base64 as string;
          const buffer = Buffer.from(base64Data, 'base64');
          writeFileSync(caminhoCompleto, buffer);
          atualizarScreenshot(args.url_vaga as string, caminhoCompleto);
          log('TOOL', `Screenshot salvo: ${nomeArquivo}`);
          return `Screenshot salvo com sucesso em: ${caminhoCompleto}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log('ERRO', `Falha ao salvar screenshot: ${msg}`);
          return `ERRO ao salvar screenshot: ${msg}`;
        }
      }

      case 'verificar_vaga_ja_vista': {
        const url = args.url as string;
        const jaVista = verificarVagaJaVista(url);
        return jaVista
          ? 'JA_VISTA: Esta vaga ja foi analisada anteriormente. Pule para a proxima.'
          : 'NOVA: Esta vaga ainda nao foi vista. Pode analisar.';
      }

      case 'registrar_vaga_vista': {
        const sucesso = registrarVagaVista({
          url: args.url as string,
          titulo_vaga: args.titulo_vaga as string | undefined,
          empresa: args.empresa as string | undefined,
          plataforma: args.plataforma as string | undefined,
          score: args.score as number | undefined,
          motivo_pulo: args.motivo_pulo as string | undefined,
        });
        return sucesso
          ? 'REGISTRADO: Vaga marcada como vista.'
          : 'ERRO: Falha ao registrar vaga vista.';
      }

      case 'obter_respostas_predefinidas': {
        try {
          const caminho = path.resolve(__dirname, '..', 'config', 'respostas.json');
          const conteudo = readFileSync(caminho, 'utf-8');
          const respostas = JSON.parse(conteudo) as RespostasPredefinidas;
          // Remove campos internos
          const { _comentario, _todo_preencher, ...respostasUteis } = respostas as Record<string, unknown>;
          return JSON.stringify(respostasUteis, null, 2);
        } catch {
          return 'ERRO: Arquivo config/respostas.json nao encontrado.';
        }
      }

      case 'buscar_resposta_cache': {
        const pergunta = args.pergunta as string;
        const tipoCampo = args.tipo_campo as string;

        // 1. Busca exact match / substring match
        const cacheHit = buscarRespostaCache(pergunta, tipoCampo);
        if (cacheHit) {
          log('TOOL', `Cache HIT (exact): "${pergunta.substring(0, 50)}..." → "${cacheHit.resposta.substring(0, 50)}..." (usada ${cacheHit.vezes_usada}x)`);
          return JSON.stringify({
            encontrado: true,
            metodo: 'exact',
            resposta: cacheHit.resposta,
            vezes_usada: cacheHit.vezes_usada,
            instrucao: 'Use esta resposta. Pode variar levemente a forma de escrever mas mantenha o conteudo.',
          });
        }

        // 2. Busca candidatas por palavras-chave para matching semântico
        const candidatas = buscarCandidatasCache(pergunta);
        if (candidatas.length > 0) {
          log('TOOL', `Cache: ${candidatas.length} candidata(s) encontrada(s) para matching semantico`);
          return JSON.stringify({
            encontrado: false,
            candidatas: candidatas.map(c => ({
              pergunta_original: c.pergunta_sanitizada,
              resposta: c.resposta,
              tipo: c.tipo_campo,
            })),
            instrucao: 'Nenhum match exato. Verifique se alguma candidata e semanticamente equivalente. Se sim, reutilize a resposta (variando a forma). Se nao, gere uma resposta nova e salve no cache.',
          });
        }

        log('TOOL', `Cache MISS: "${pergunta.substring(0, 50)}..."`);
        return JSON.stringify({
          encontrado: false,
          candidatas: [],
          instrucao: 'Nenhuma resposta no cache. Gere uma resposta nova e salve no cache apos preencher o campo.',
        });
      }

      case 'salvar_resposta_cache': {
        const pergunta = args.pergunta as string;
        const tipoCampo = args.tipo_campo as string;
        const resposta = args.resposta as string;
        const empresaAtual = (args.empresa_atual as string) || '';

        // Regra do AIHawk: não cachear respostas que mencionam o nome da empresa
        if (empresaAtual && resposta.toLowerCase().includes(empresaAtual.toLowerCase())) {
          log('TOOL', `Cache SKIP: resposta menciona "${empresaAtual}" (especifica demais para cachear)`);
          return 'NAO_CACHEADO: Resposta menciona o nome da empresa e e especifica demais para reutilizar em outras vagas.';
        }

        const sucesso = salvarRespostaCache(pergunta, tipoCampo, resposta);
        if (sucesso) {
          log('TOOL', `Cache SAVE: "${sanitizarPergunta(pergunta).substring(0, 50)}..." → "${resposta.substring(0, 50)}..."`);
          return 'CACHEADO: Resposta salva no cache para reutilizacao futura.';
        }
        return 'JA_EXISTE: Essa pergunta ja existe no cache.';
      }

      case 'reportar_falha': {
        const urlVaga = args.url_vaga as string;
        const codigoFalha = args.codigo_falha as string;
        const descricaoFalha = args.descricao as string;

        if (ehFalhaPermanente(codigoFalha)) {
          // Falha permanente: registra como vista e nunca mais tenta
          // (ApplyPilot usa attempts=99 como sentinela; nós registramos em vagas_vistas)
          registrarVagaVista({
            url: urlVaga,
            titulo_vaga: (args.titulo_vaga as string) || undefined,
            empresa: (args.empresa as string) || undefined,
            plataforma: (args.plataforma as string) || undefined,
            motivo_pulo: `PERMANENTE:${codigoFalha} — ${descricaoFalha}`,
          });
          tentativasPorUrl.delete(urlVaga);
          log('FALHA', `PERMANENTE [${codigoFalha}]: ${descricaoFalha} — ${urlVaga}`);

          return JSON.stringify({
            tipo: 'PERMANENTE',
            acao: 'PULAR',
            codigo: codigoFalha,
            mensagem: `Falha permanente (${codigoFalha}). Vaga registrada como vista — nunca sera retentada. Passe para a proxima vaga.`,
          });
        }

        if (ehFalhaRetriavel(codigoFalha)) {
          const tentativasAtuais = (tentativasPorUrl.get(urlVaga) || 0) + 1;
          tentativasPorUrl.set(urlVaga, tentativasAtuais);

          if (tentativasAtuais >= MAX_TENTATIVAS) {
            // Esgotou tentativas — trata como permanente
            registrarVagaVista({
              url: urlVaga,
              titulo_vaga: (args.titulo_vaga as string) || undefined,
              empresa: (args.empresa as string) || undefined,
              plataforma: (args.plataforma as string) || undefined,
              motivo_pulo: `ESGOTADO:${codigoFalha} — ${tentativasAtuais} tentativas — ${descricaoFalha}`,
            });
            tentativasPorUrl.delete(urlVaga);
            log('FALHA', `ESGOTADO [${codigoFalha}]: ${tentativasAtuais}/${MAX_TENTATIVAS} tentativas — ${urlVaga}`);

            return JSON.stringify({
              tipo: 'ESGOTADO',
              acao: 'PULAR',
              codigo: codigoFalha,
              tentativas: tentativasAtuais,
              mensagem: `Maximo de ${MAX_TENTATIVAS} tentativas atingido para esta vaga. Passe para a proxima.`,
            });
          }

          const backoffMs = calcularBackoff(tentativasAtuais);
          log('FALHA', `RETRIAVEL [${codigoFalha}]: tentativa ${tentativasAtuais}/${MAX_TENTATIVAS}, backoff ${backoffMs}ms — ${urlVaga}`);

          // Aguarda backoff antes de liberar o agente para retentar
          await new Promise(resolve => setTimeout(resolve, backoffMs));

          return JSON.stringify({
            tipo: 'RETRIAVEL',
            acao: 'RETENTAR',
            codigo: codigoFalha,
            tentativa_atual: tentativasAtuais,
            max_tentativas: MAX_TENTATIVAS,
            backoff_aplicado_ms: backoffMs,
            mensagem: `Falha retriavel (${codigoFalha}). Tentativa ${tentativasAtuais}/${MAX_TENTATIVAS}. Backoff de ${Math.round(backoffMs / 1000)}s ja aplicado. Tente novamente agora.`,
          });
        }

        // Código desconhecido — trata como permanente por segurança
        log('FALHA', `DESCONHECIDO [${codigoFalha}]: ${descricaoFalha} — ${urlVaga}`);
        registrarVagaVista({
          url: urlVaga,
          motivo_pulo: `DESCONHECIDO:${codigoFalha} — ${descricaoFalha}`,
        });

        return JSON.stringify({
          tipo: 'DESCONHECIDO',
          acao: 'PULAR',
          codigo: codigoFalha,
          mensagem: `Codigo de falha desconhecido (${codigoFalha}). Pule esta vaga por seguranca.`,
        });
      }

      case 'gerar_mensagem_recrutador': {
        const nomeRecrutador = args.nome_recrutador as string;
        const cargoRecrutador = (args.cargo_recrutador as string) || '';
        const empresa = args.empresa as string;
        const tituloVaga = args.titulo_vaga as string;
        const descricaoVaga = args.descricao_vaga as string;

        // Verifica limite diário de mensagens (max 5 por dia)
        const mensagensHoje = contarMensagensHoje();
        if (mensagensHoje >= 5) {
          return JSON.stringify({
            sucesso: false,
            motivo: 'LIMITE_DIARIO',
            mensagem: `Limite diario de mensagens a recrutadores atingido (${mensagensHoje}/5). Nao envie mais mensagens hoje.`,
          });
        }

        if (!_geminiApiKey || !_geminiModel) {
          return 'ERRO: Configuracao do Gemini nao disponivel para gerar mensagem.';
        }

        try {
          const resultado = await gerarMensagemRecrutador(
            _geminiApiKey,
            _geminiModel,
            perfil,
            nomeRecrutador,
            cargoRecrutador,
            empresa,
            tituloVaga,
            descricaoVaga,
          );

          log('TOOL', `Mensagem recrutador ${resultado.fonte === 'cache' ? '(cache)' : '(nova)'}: ${nomeRecrutador} — ${empresa}`);

          return JSON.stringify({
            sucesso: true,
            texto: resultado.texto,
            caracteres: resultado.texto.length,
            fonte: resultado.fonte,
            instrucao: 'Use este texto como nota ao enviar convite de conexao no LinkedIn. Passos: (1) va ao perfil do recrutador, (2) clique em "Conectar", (3) clique em "Adicionar nota", (4) cole o texto com browser_type, (5) clique em "Enviar". Apos sucesso, use registrar_mensagem_recrutador.',
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          log('ERRO', `Falha na mensagem recrutador: ${msg}`);
          return `ERRO: ${msg}. Pule o envio de mensagem para este recrutador.`;
        }
      }

      case 'verificar_recrutador_ja_contatado': {
        const urlPerfil = args.url_perfil as string;
        const jaContatado = verificarRecrutadorJaContatado(urlPerfil);
        return jaContatado
          ? 'JA_CONTATADO: Este recrutador ja recebeu uma mensagem anteriormente. Pule.'
          : 'NOVO: Este recrutador ainda nao foi contatado. Pode prosseguir.';
      }

      case 'registrar_mensagem_recrutador': {
        const sucesso = registrarMensagemRecrutador({
          nome_recrutador: args.nome_recrutador as string,
          cargo_recrutador: (args.cargo_recrutador as string) || undefined,
          empresa: args.empresa as string,
          url_perfil: args.url_perfil as string,
          url_vaga: (args.url_vaga as string) || undefined,
          titulo_vaga: (args.titulo_vaga as string) || undefined,
          mensagem: args.mensagem as string,
          score_vaga: (args.score_vaga as number) || undefined,
        });

        if (sucesso) {
          log('AGENTE', `Mensagem registrada: ${args.nome_recrutador} — ${args.empresa}`);
          return 'REGISTRADO: Mensagem para recrutador salva no banco de dados.';
        }
        return 'ERRO: Falha ao registrar (recrutador possivelmente ja contatado).';
      }

      case 'resolver_captcha_telegram': {
        const screenshotB64 = args.screenshot_base64 as string;
        const urlCaptcha = args.url_vaga as string;

        log('FALHA', `CAPTCHA detectado em: ${urlCaptcha}. Solicitando resolução via Telegram...`);

        try {
          const solucao = await solicitarResolucaoCaptcha(screenshotB64, urlCaptcha);

          if (solucao) {
            return JSON.stringify({
              sucesso: true,
              solucao,
              instrucao: 'Digite esta solucao no campo do CAPTCHA usando browser_type e depois submeta o formulario. Se o CAPTCHA rejeitar a solucao, tire outro screenshot e chame esta tool novamente (max 3 tentativas).',
            });
          }

          return JSON.stringify({
            sucesso: false,
            motivo: 'timeout',
            instrucao: 'Nenhuma solucao recebida em 5 minutos. Use reportar_falha com codigo "captcha" para pular esta vaga.',
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          log('ERRO', `CAPTCHA resolver: ${msg}`);
          return JSON.stringify({
            sucesso: false,
            motivo: msg,
            instrucao: 'Falha ao solicitar resolucao. Use reportar_falha com codigo "captcha" para pular esta vaga.',
          });
        }
      }

      case 'gerar_cover_letter': {
        const descricao = args.descricao_vaga as string;
        const empresa = args.empresa as string;
        const titulo = args.titulo_vaga as string;

        if (!_geminiApiKey || !_geminiModel) {
          return 'ERRO: Configuracao do Gemini nao disponivel para gerar cover letter.';
        }

        try {
          const resultado = await gerarCoverLetter(
            _geminiApiKey,
            _geminiModel,
            perfil,
            descricao,
            empresa,
            titulo,
          );

          log('TOOL', `Cover letter ${resultado.fonte === 'cache' ? '(cache)' : '(nova)'} para ${titulo} — ${empresa}`);

          return JSON.stringify({
            sucesso: true,
            texto: resultado.texto,
            fonte: resultado.fonte,
            instrucao: 'Cole este texto no campo de carta de apresentacao do formulario. Voce pode fazer pequenos ajustes de tom se necessario.',
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          log('ERRO', `Falha na cover letter: ${msg}`);
          return `ERRO: ${msg}. Escreva uma resposta curta baseada no perfil do candidato como fallback.`;
        }
      }

      case 'gerar_curriculo_tailored': {
        const descricao = args.descricao_vaga as string;
        const titulo = (args.titulo_vaga as string) || '';
        const empresa = (args.empresa as string) || '';

        if (!_geminiApiKey || !_geminiModel) {
          log('ERRO', 'Curriculo tailored: API key ou modelo nao configurados');
          return 'ERRO: Configuracao do Gemini nao disponivel. Use escolher_curriculo como fallback.';
        }

        try {
          const resultado = await gerarCurriculoTailored(
            _geminiApiKey,
            _geminiModel,
            perfil,
            descricao,
          );

          log('TOOL', `Curriculo tailored ${resultado.fonte === 'cache' ? '(cache)' : '(novo)'}: ${resultado.caminhoPDF}`);

          return JSON.stringify({
            sucesso: true,
            caminho: resultado.caminhoPDF,
            caminho_html: resultado.caminhoHTML,
            fonte: resultado.fonte,
            motivo: `Curriculo personalizado ${resultado.fonte === 'cache' ? 'recuperado do cache' : 'gerado com sucesso'} para: ${titulo || 'vaga'} ${empresa ? `na ${empresa}` : ''}.`,
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          log('ERRO', `Falha no curriculo tailored: ${msg}`);
          return `ERRO: ${msg}. Use escolher_curriculo como fallback.`;
        }
      }

      default:
        return `ERRO: Tool "${name}" nao reconhecida.`;
    }
  };
}
