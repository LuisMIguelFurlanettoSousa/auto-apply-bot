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
} from './database.js';
import { log } from './logger.js';
import { notificarCandidatura } from './notificacoes.js';
import type { Perfil, RespostasPredefinidas } from './types.js';

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
];

// ========== EXECUTOR DAS TOOLS ==========

export function criarExecutorDeTools(perfil: Perfil) {
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

      default:
        return `ERRO: Tool "${name}" nao reconhecida.`;
    }
  };
}
