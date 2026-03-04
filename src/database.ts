import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Candidatura } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'data', 'candidaturas.db');

let db: Database.Database;

export function inicializarBanco(): Database.Database {
  db = new Database(DB_PATH);

  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS candidaturas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plataforma TEXT NOT NULL,
      titulo_vaga TEXT NOT NULL,
      empresa TEXT NOT NULL,
      url TEXT UNIQUE NOT NULL,
      data_aplicacao TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      mensagem_enviada INTEGER DEFAULT 0,
      status TEXT DEFAULT 'aplicado',
      score INTEGER DEFAULT 0
    )
  `);

  // Migracoes (adicionar colunas novas em bancos existentes)
  const migracoes = [
    'ALTER TABLE candidaturas ADD COLUMN score INTEGER DEFAULT 0',
    'ALTER TABLE candidaturas ADD COLUMN screenshot_path TEXT',
  ];
  for (const sql of migracoes) {
    try { db.exec(sql); } catch { /* Coluna ja existe */ }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS vagas_vistas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      titulo_vaga TEXT,
      empresa TEXT,
      plataforma TEXT,
      score INTEGER DEFAULT 0,
      motivo_pulo TEXT,
      data_vista TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_respostas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo_campo TEXT NOT NULL,
      pergunta_sanitizada TEXT NOT NULL,
      resposta TEXT NOT NULL,
      vezes_usada INTEGER DEFAULT 1,
      data_criacao TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      data_ultimo_uso TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cache_pergunta ON cache_respostas(pergunta_sanitizada);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mensagens_recrutadores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome_recrutador TEXT NOT NULL,
      cargo_recrutador TEXT,
      empresa TEXT NOT NULL,
      url_perfil TEXT UNIQUE NOT NULL,
      url_vaga TEXT,
      titulo_vaga TEXT,
      mensagem TEXT NOT NULL,
      plataforma TEXT DEFAULT 'linkedin',
      score_vaga INTEGER DEFAULT 0,
      data_envio TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS log_execucoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_execucao TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      total_candidaturas INTEGER DEFAULT 0,
      sites_processados TEXT,
      erros TEXT
    )
  `);

  return db;
}

export function verificarJaAplicou(url: string): boolean {
  const row = db.prepare('SELECT id FROM candidaturas WHERE url = ?').get(url);
  return !!row;
}

export function registrarCandidatura(candidatura: Omit<Candidatura, 'id' | 'data_aplicacao'>): boolean {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO candidaturas (plataforma, titulo_vaga, empresa, url, mensagem_enviada, status, score, screenshot_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidatura.plataforma,
      candidatura.titulo_vaga,
      candidatura.empresa,
      candidatura.url,
      candidatura.mensagem_enviada,
      candidatura.status,
      candidatura.score ?? 0,
      candidatura.screenshot_path ?? null
    );
    return true;
  } catch {
    return false;
  }
}

export function registrarVagaVista(dados: {
  url: string;
  titulo_vaga?: string;
  empresa?: string;
  plataforma?: string;
  score?: number;
  motivo_pulo?: string;
}): boolean {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO vagas_vistas (url, titulo_vaga, empresa, plataforma, score, motivo_pulo)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      dados.url,
      dados.titulo_vaga ?? null,
      dados.empresa ?? null,
      dados.plataforma ?? null,
      dados.score ?? 0,
      dados.motivo_pulo ?? null
    );
    return true;
  } catch {
    return false;
  }
}

export function verificarVagaJaVista(url: string): boolean {
  const row = db.prepare('SELECT id FROM vagas_vistas WHERE url = ?').get(url);
  return !!row;
}

export function atualizarScreenshot(url: string, screenshotPath: string): void {
  db.prepare('UPDATE candidaturas SET screenshot_path = ? WHERE url = ?').run(screenshotPath, url);
}

export function obterEstatisticas() {
  const hoje = db.prepare(`
    SELECT COUNT(*) as total, AVG(score) as score_medio
    FROM candidaturas WHERE date(data_aplicacao) = date('now', 'localtime')
  `).get() as { total: number; score_medio: number | null };

  const total = db.prepare('SELECT COUNT(*) as total FROM candidaturas').get() as { total: number };

  const porPlataforma = db.prepare(`
    SELECT plataforma, COUNT(*) as total, AVG(score) as score_medio
    FROM candidaturas GROUP BY plataforma ORDER BY total DESC
  `).all() as Array<{ plataforma: string; total: number; score_medio: number | null }>;

  const porStatus = db.prepare(`
    SELECT status, COUNT(*) as total
    FROM candidaturas GROUP BY status
  `).all() as Array<{ status: string; total: number }>;

  return { hoje, total: total.total, porPlataforma, porStatus };
}

export function contarCandidaturasHoje(): number {
  const row = db.prepare(`
    SELECT COUNT(*) as total FROM candidaturas
    WHERE date(data_aplicacao) = date('now', 'localtime')
  `).get() as { total: number };
  return row.total;
}

export function listarCandidaturas(limite: number = 50): Candidatura[] {
  return db.prepare(`
    SELECT * FROM candidaturas ORDER BY data_aplicacao DESC LIMIT ?
  `).all(limite) as Candidatura[];
}

export function registrarExecucao(totalCandidaturas: number, sitesProcessados: string[], erros: string[]): void {
  db.prepare(`
    INSERT INTO log_execucoes (total_candidaturas, sites_processados, erros)
    VALUES (?, ?, ?)
  `).run(totalCandidaturas, JSON.stringify(sitesProcessados), JSON.stringify(erros));
}

// ========== MENSAGENS PARA RECRUTADORES ==========

export function verificarRecrutadorJaContatado(urlPerfil: string): boolean {
  const row = db.prepare('SELECT id FROM mensagens_recrutadores WHERE url_perfil = ?').get(urlPerfil);
  return !!row;
}

export function registrarMensagemRecrutador(dados: {
  nome_recrutador: string;
  cargo_recrutador?: string;
  empresa: string;
  url_perfil: string;
  url_vaga?: string;
  titulo_vaga?: string;
  mensagem: string;
  plataforma?: string;
  score_vaga?: number;
}): boolean {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO mensagens_recrutadores
        (nome_recrutador, cargo_recrutador, empresa, url_perfil, url_vaga, titulo_vaga, mensagem, plataforma, score_vaga)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      dados.nome_recrutador,
      dados.cargo_recrutador ?? null,
      dados.empresa,
      dados.url_perfil,
      dados.url_vaga ?? null,
      dados.titulo_vaga ?? null,
      dados.mensagem,
      dados.plataforma ?? 'linkedin',
      dados.score_vaga ?? 0,
    );
    return true;
  } catch {
    return false;
  }
}

export function contarMensagensHoje(): number {
  const row = db.prepare(`
    SELECT COUNT(*) as total FROM mensagens_recrutadores
    WHERE date(data_envio) = date('now', 'localtime')
  `).get() as { total: number };
  return row.total;
}

// ========== CACHE DE RESPOSTAS ==========

export interface CacheResposta {
  id: number;
  tipo_campo: string;
  pergunta_sanitizada: string;
  resposta: string;
  vezes_usada: number;
}

export function sanitizarPergunta(texto: string): string {
  return texto
    .toLowerCase()
    .trim()
    .replace(/['"\\]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .replace(/,\s*$/, '');
}

export function buscarRespostaCache(pergunta: string, tipoCampo: string): CacheResposta | null {
  const sanitizada = sanitizarPergunta(pergunta);

  // 1. Exact match (como o AIHawk)
  const exata = db.prepare(
    'SELECT * FROM cache_respostas WHERE pergunta_sanitizada = ? AND tipo_campo = ?',
  ).get(sanitizada, tipoCampo) as CacheResposta | undefined;

  if (exata) {
    // Atualizar contador e data de uso
    db.prepare(
      'UPDATE cache_respostas SET vezes_usada = vezes_usada + 1, data_ultimo_uso = datetime("now", "localtime") WHERE id = ?',
    ).run(exata.id);
    return exata;
  }

  // 2. Substring match (para dropdowns/radios, como o AIHawk usa 'in')
  if (tipoCampo === 'dropdown' || tipoCampo === 'radio') {
    const todas = db.prepare(
      'SELECT * FROM cache_respostas WHERE tipo_campo = ?',
    ).all(tipoCampo) as CacheResposta[];

    for (const item of todas) {
      if (sanitizada.includes(item.pergunta_sanitizada) || item.pergunta_sanitizada.includes(sanitizada)) {
        db.prepare(
          'UPDATE cache_respostas SET vezes_usada = vezes_usada + 1, data_ultimo_uso = datetime("now", "localtime") WHERE id = ?',
        ).run(item.id);
        return item;
      }
    }
  }

  return null;
}

export function buscarCandidatasCache(pergunta: string, limite: number = 10): CacheResposta[] {
  const sanitizada = sanitizarPergunta(pergunta);
  // Busca perguntas que compartilham palavras-chave para matching semântico via LLM
  const palavras = sanitizada.split(' ').filter(p => p.length > 3);
  if (palavras.length === 0) return [];

  const condicoes = palavras.map(() => 'pergunta_sanitizada LIKE ?').join(' OR ');
  const params = palavras.map(p => `%${p}%`);

  return db.prepare(
    `SELECT * FROM cache_respostas WHERE ${condicoes} ORDER BY vezes_usada DESC LIMIT ?`,
  ).all(...params, limite) as CacheResposta[];
}

export function salvarRespostaCache(pergunta: string, tipoCampo: string, resposta: string): boolean {
  const sanitizada = sanitizarPergunta(pergunta);

  // Verificar se já existe
  const existe = db.prepare(
    'SELECT id FROM cache_respostas WHERE pergunta_sanitizada = ? AND tipo_campo = ?',
  ).get(sanitizada, tipoCampo);

  if (existe) return false;

  try {
    db.prepare(
      'INSERT INTO cache_respostas (tipo_campo, pergunta_sanitizada, resposta) VALUES (?, ?, ?)',
    ).run(tipoCampo, sanitizada, resposta);
    return true;
  } catch {
    return false;
  }
}

export function contarCacheRespostas(): number {
  const row = db.prepare('SELECT COUNT(*) as total FROM cache_respostas').get() as { total: number };
  return row.total;
}

export function fecharBanco(): void {
  if (db) {
    db.close();
  }
}
