import 'dotenv/config';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { conectarPlaywrightMCP, desconectarMCP } from './mcp-client.js';
import { inicializarBanco, fecharBanco, registrarExecucao, contarCandidaturasHoje } from './database.js';
import { executarAgente } from './agente.js';
import { iniciarDashboard } from './dashboard.js';
import { inicializarLogger, log } from './logger.js';
import { configurarTelegram, notificarResumo, notificarErro } from './notificacoes.js';
import { configurarEmail, enviarRelatorioEmail, gerarHTMLRelatorio } from './email.js';
import { iniciarCron, pararCron } from './cron.js';
import { exibirResumoTokens, obterCustoTotal, obterTokensTotal, obterTotalChamadas, resetarTracker } from './token-tracker.js';
import type { Perfil, SitesConfig, AgenteConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function carregarConfig<T>(arquivo: string): T {
  const caminho = path.resolve(__dirname, '..', 'config', arquivo);
  try {
    const conteudo = readFileSync(caminho, 'utf-8');
    return JSON.parse(conteudo) as T;
  } catch (error) {
    console.error(`\nERRO: Nao foi possivel carregar ${caminho}`);
    console.error('Verifique se o arquivo existe e esta no formato JSON correto.\n');
    process.exit(1);
  }
}

function validarEnv(): AgenteConfig {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    console.error('\nERRO: GEMINI_API_KEY nao definida.');
    console.error('Copie .env.example para .env e preencha sua chave.\n');
    process.exit(1);
  }

  return {
    geminiApiKey,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
    cdpEndpoint: process.env.CDP_ENDPOINT || 'http://localhost:9222',
    limiteDiario: parseInt(process.env.LIMITE_DIARIO || '10', 10),
    delayMin: parseInt(process.env.DELAY_MIN || '2000', 10),
    delayMax: parseInt(process.env.DELAY_MAX || '5000', 10),
    dryRun: process.env.DRY_RUN === 'true',
    scoreMinimo: parseInt(process.env.SCORE_MINIMO || '6', 10),
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3000', 10),
    // Telegram
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    // Email
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: process.env.SMTP_PASS || '',
    emailDestinatario: process.env.EMAIL_DESTINATARIO || '',
    // Cron
    cronAtivo: process.env.CRON_ATIVO === 'true',
    cronHorario: process.env.CRON_HORARIO || '09:00',
  };
}

async function executarFluxoPrincipal(config: AgenteConfig): Promise<void> {
  // Carrega configuracoes
  const perfil = carregarConfig<Perfil>('perfil.json');
  log('INFO', `Perfil carregado: ${perfil.nome} (${perfil.titulo_profissional})`);

  const sites = carregarConfig<SitesConfig>('sites.json');
  const sitesAtivos = sites.sites.filter(s => s.ativo);
  log('INFO', `Sites: ${sitesAtivos.length} ativo(s) de ${sites.sites.length} total`);

  // Inicializa banco de dados
  inicializarBanco();
  const candidaturasHoje = contarCandidaturasHoje();
  log('INFO', `Candidaturas hoje: ${candidaturasHoje}/${config.limiteDiario}`);

  if (candidaturasHoje >= config.limiteDiario && !config.dryRun) {
    log('WARN', 'Limite diario de candidaturas ja atingido. Tente novamente amanha.');
    fecharBanco();
    return;
  }

  // Inicia dashboard web
  iniciarDashboard(config.dashboardPort);

  // Conecta ao Playwright MCP (que conecta ao Chrome)
  let mcpClient;
  try {
    mcpClient = await conectarPlaywrightMCP(config.cdpEndpoint);
  } catch (error) {
    log('ERRO', 'Nao foi possivel conectar ao Chrome.');
    log('ERRO', 'Certifique-se de que o Chrome esta aberto com: google-chrome --remote-debugging-port=9222');
    await notificarErro('Falha ao conectar ao Chrome. Verifique se o CDP esta ativo.');
    fecharBanco();
    process.exit(1);
  }

  // Executa o agente
  const erros: string[] = [];
  let resultado = '';

  try {
    resultado = await executarAgente(mcpClient, perfil, sites, config);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    erros.push(msg);
    log('ERRO', `ERRO FATAL: ${msg}`);
    await notificarErro(msg);
  }

  // Registra execucao
  const candidaturasDepois = contarCandidaturasHoje();
  const novasCandidaturas = candidaturasDepois - candidaturasHoje;

  registrarExecucao(
    novasCandidaturas,
    sitesAtivos.map(s => s.nome),
    erros,
  );

  // Resumo final
  log('INFO', '='.repeat(60));
  log('INFO', config.dryRun ? '  RESUMO DA EXECUCAO (DRY-RUN)' : '  RESUMO DA EXECUCAO');
  log('INFO', '='.repeat(60));
  log('INFO', `  Modo: ${config.dryRun ? 'DRY-RUN (simulacao)' : 'PRODUCAO'}`);
  log('INFO', `  Novas candidaturas: ${novasCandidaturas}`);
  log('INFO', `  Total hoje: ${candidaturasDepois}/${config.limiteDiario}`);
  log('INFO', `  Sites processados: ${sitesAtivos.map(s => s.nome).join(', ')}`);
  log('INFO', `  Erros: ${erros.length > 0 ? erros.join('; ') : 'Nenhum'}`);
  log('INFO', `  Custo tokens:      $${obterCustoTotal().toFixed(4)} USD (${obterTokensTotal().toLocaleString('pt-BR')} tokens, ${obterTotalChamadas()} chamadas)`);
  log('INFO', `  Dashboard: http://localhost:${config.dashboardPort}`);

  // Resumo detalhado de tokens
  exibirResumoTokens();

  if (resultado) {
    log('AGENTE', `Relatorio:\n${resultado}`);
  }

  // Notificacoes
  await notificarResumo(novasCandidaturas, erros.length, config.dryRun);

  // Relatorio por email
  await enviarRelatorioEmail(
    `Job Bot — ${novasCandidaturas} candidatura(s) ${config.dryRun ? '(DRY-RUN)' : ''}`,
    gerarHTMLRelatorio({
      total: novasCandidaturas,
      empresas: [], // O agente registra no banco, aqui só o resumo
      erros,
      dryRun: config.dryRun,
      scoresMedio: 0,
    }),
  );

  // Cleanup
  await desconectarMCP();
  fecharBanco();
  log('INFO', 'Agente finalizado com sucesso.');
}

async function main() {
  // Inicializa logger antes de tudo
  inicializarLogger();

  log('INFO', '='.repeat(60));
  log('INFO', '  JOB BOT - Agente Inteligente de Candidaturas');
  log('INFO', '='.repeat(60));

  // Valida ambiente
  const config = validarEnv();
  log('INFO', `Modelo: ${config.geminiModel}`);
  log('INFO', `CDP: ${config.cdpEndpoint}`);
  log('INFO', `Limite diario: ${config.limiteDiario}`);
  log('INFO', `Score minimo: ${config.scoreMinimo}/10`);

  if (config.dryRun) {
    log('WARN', '*** MODO DRY-RUN ATIVO — nenhuma candidatura sera enviada de verdade ***');
  }

  // Configura notificacoes (opcionais)
  configurarTelegram(config.telegramBotToken, config.telegramChatId);
  configurarEmail(config.smtpHost, config.smtpPort, config.smtpUser, config.smtpPass, config.emailDestinatario);

  // Verifica se é modo cron ou execução única
  if (config.cronAtivo) {
    log('INFO', `Modo CRON ativado. Horario: ${config.cronHorario}`);
    log('INFO', 'O bot ficara rodando e executara automaticamente no horario configurado.');
    log('INFO', 'Pressione Ctrl+C para parar.');

    iniciarCron(config.cronHorario, () => {
      resetarTracker();
      return executarFluxoPrincipal(config);
    });

    // Mantém o processo vivo
    process.on('SIGINT', () => {
      log('INFO', 'Recebido SIGINT. Parando cron...');
      pararCron();
      fecharBanco();
      process.exit(0);
    });
  } else {
    // Execução única
    await executarFluxoPrincipal(config);
  }
}

main().catch((error) => {
  log('ERRO', `Erro inesperado: ${error}`);
  fecharBanco();
  process.exit(1);
});
