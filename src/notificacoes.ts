import https from 'https';
import { log } from './logger.js';

let telegramConfig: { botToken: string; chatId: string } | null = null;

export function configurarTelegram(botToken: string, chatId: string): void {
  if (!botToken || !chatId) {
    log('WARN', 'Telegram: BOT_TOKEN ou CHAT_ID não configurados. Notificações desativadas.');
    return;
  }
  telegramConfig = { botToken, chatId };
  log('INFO', 'Telegram: Notificações configuradas com sucesso.');
}

export function enviarTelegram(mensagem: string): Promise<boolean> {
  if (!telegramConfig) return Promise.resolve(false);

  return new Promise((resolve) => {
    const payload = JSON.stringify({
      chat_id: telegramConfig!.chatId,
      text: mensagem,
      parse_mode: 'Markdown',
    });

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${telegramConfig!.botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          log('INFO', 'Telegram: Mensagem enviada com sucesso.');
          resolve(true);
        } else {
          log('ERRO', `Telegram: Erro ${res.statusCode} — ${data}`);
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      log('ERRO', `Telegram: Erro de rede — ${err.message}`);
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

// Notificações pré-formatadas
export async function notificarCandidatura(empresa: string, vaga: string, score: number, dryRun: boolean): Promise<void> {
  const modo = dryRun ? '🔵 DRY-RUN' : '🟢 APLICADO';
  const msg = `${modo}\n*${vaga}* — ${empresa}\nScore: ${score}/10`;
  await enviarTelegram(msg);
}

export async function notificarResumo(total: number, erros: number, dryRun: boolean): Promise<void> {
  const modo = dryRun ? '(DRY-RUN)' : '';
  const msg = `📊 *Resumo da Execução* ${modo}\nCandidaturas: ${total}\nErros: ${erros}`;
  await enviarTelegram(msg);
}

export async function notificarErro(mensagem: string): Promise<void> {
  await enviarTelegram(`🔴 *ERRO*\n${mensagem}`);
}

// ========== CAPTCHA HANDLING VIA TELEGRAM ==========
// Adaptado do beatwad: envia screenshot do CAPTCHA pro Telegram,
// aguarda humano resolver e retorna a solução.

/**
 * Envia uma foto (Buffer) para o Telegram via multipart/form-data.
 * Retorna true se enviou com sucesso.
 */
export function enviarFotoTelegram(foto: Buffer, caption: string): Promise<boolean> {
  if (!telegramConfig) return Promise.resolve(false);

  return new Promise((resolve) => {
    const boundary = `----FormBoundary${Date.now()}`;

    // Monta o body multipart manualmente (sem dependências externas)
    const partes: Buffer[] = [];

    // Campo: chat_id
    partes.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${telegramConfig!.chatId}\r\n`,
    ));

    // Campo: caption
    partes.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`,
    ));

    // Campo: parse_mode
    partes.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nMarkdown\r\n`,
    ));

    // Campo: photo (arquivo binário)
    partes.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="captcha.png"\r\nContent-Type: image/png\r\n\r\n`,
    ));
    partes.push(foto);
    partes.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(partes);

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${telegramConfig!.botToken}/sendPhoto`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          log('INFO', 'Telegram: Foto do CAPTCHA enviada com sucesso.');
          resolve(true);
        } else {
          log('ERRO', `Telegram: Erro ao enviar foto — ${res.statusCode} ${data}`);
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      log('ERRO', `Telegram: Erro de rede ao enviar foto — ${err.message}`);
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

/**
 * Faz uma chamada à API getUpdates do Telegram.
 * Retorna os updates ou array vazio em caso de erro.
 */
function getUpdates(offset: number): Promise<Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }>> {
  if (!telegramConfig) return Promise.resolve([]);

  return new Promise((resolve) => {
    const params = new URLSearchParams({
      offset: String(offset),
      timeout: '5',
      allowed_updates: JSON.stringify(['message']),
    });

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${telegramConfig!.botToken}/getUpdates?${params.toString()}`,
      method: 'GET',
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data) as { ok: boolean; result: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }> };
          resolve(parsed.ok ? parsed.result : []);
        } catch {
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.end();
  });
}

/**
 * Envia screenshot do CAPTCHA e aguarda solução do humano via Telegram.
 * Polling com timeout de 5 minutos.
 *
 * @returns Texto da solução ou null se timeout/erro
 */
export async function solicitarResolucaoCaptcha(
  screenshotBase64: string,
  urlVaga: string,
): Promise<string | null> {
  if (!telegramConfig) {
    log('ERRO', 'CAPTCHA: Telegram não configurado — não é possível solicitar resolução humana.');
    return null;
  }

  const chatIdNumero = parseInt(telegramConfig.chatId, 10);

  // 1. Limpa updates pendentes para pegar apenas respostas novas
  let offset = 0;
  const updatesAntigos = await getUpdates(-1);
  if (updatesAntigos.length > 0) {
    offset = updatesAntigos[updatesAntigos.length - 1].update_id + 1;
    // Confirma leitura dos antigos
    await getUpdates(offset);
  }

  // 2. Envia foto do CAPTCHA
  const fotoBuffer = Buffer.from(screenshotBase64, 'base64');
  const caption = `🔒 *CAPTCHA DETECTADO*\n\nURL: ${urlVaga}\n\nResolva o CAPTCHA na imagem e *responda com a solução* (texto ou código).`;

  const enviou = await enviarFotoTelegram(fotoBuffer, caption);
  if (!enviou) {
    log('ERRO', 'CAPTCHA: Falha ao enviar screenshot para o Telegram.');
    return null;
  }

  // 3. Polling por resposta (timeout: 5 minutos)
  const TIMEOUT_MS = 5 * 60 * 1000;
  const inicio = Date.now();

  log('INFO', `CAPTCHA: Aguardando solução via Telegram (timeout: ${TIMEOUT_MS / 1000}s)...`);
  await enviarTelegram('⏳ Aguardando sua resposta... (timeout: 5 minutos)');

  while (Date.now() - inicio < TIMEOUT_MS) {
    const updates = await getUpdates(offset);

    for (const update of updates) {
      offset = update.update_id + 1;

      // Filtra: só aceita mensagens de texto do nosso chat_id
      if (
        update.message &&
        update.message.chat.id === chatIdNumero &&
        update.message.text
      ) {
        const solucao = update.message.text.trim();

        // Ignora comandos do Telegram (ex: /start)
        if (solucao.startsWith('/')) continue;

        log('INFO', `CAPTCHA: Solução recebida via Telegram: "${solucao}"`);
        await enviarTelegram(`✅ Solução recebida: *${solucao}*\nInserindo no formulário...`);
        return solucao;
      }
    }

    // Aguarda 2s entre cada poll (o getUpdates já tem long-polling de 5s)
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Timeout
  log('WARN', 'CAPTCHA: Timeout — nenhuma solução recebida em 5 minutos.');
  await enviarTelegram('⏰ *Timeout!* Nenhuma solução recebida em 5 minutos. Pulando vaga...');
  return null;
}
