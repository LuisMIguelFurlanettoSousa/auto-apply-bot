import http from 'http';
import { listarCandidaturas, obterEstatisticas } from './database.js';

function gerarHTML(): string {
  const stats = obterEstatisticas();
  const candidaturas = listarCandidaturas(100);

  const linhasTabela = candidaturas.map(c => `
    <tr>
      <td>${c.data_aplicacao}</td>
      <td>${c.plataforma}</td>
      <td>${c.empresa}</td>
      <td>${c.titulo_vaga}</td>
      <td><span class="score ${c.score && c.score >= 7 ? 'high' : c.score && c.score >= 5 ? 'mid' : 'low'}">${c.score || '-'}</span></td>
      <td><span class="status ${c.status}">${c.status}</span></td>
      <td><a href="${c.url}" target="_blank">Ver</a></td>
    </tr>
  `).join('');

  const plataformasRows = stats.porPlataforma.map(p => `
    <div class="stat-card">
      <div class="stat-value">${p.total}</div>
      <div class="stat-label">${p.plataforma}</div>
      <div class="stat-sub">Score medio: ${p.score_medio ? p.score_medio.toFixed(1) : '-'}</div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="30">
<title>Job Bot - Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 24px; margin-bottom: 24px; color: #f8fafc; }
  .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat-card { background: #1e293b; border-radius: 12px; padding: 20px; min-width: 150px; }
  .stat-value { font-size: 32px; font-weight: 700; color: #38bdf8; }
  .stat-label { font-size: 14px; color: #94a3b8; margin-top: 4px; }
  .stat-sub { font-size: 12px; color: #64748b; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
  th { background: #334155; padding: 12px 16px; text-align: left; font-size: 13px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 10px 16px; border-top: 1px solid #334155; font-size: 14px; }
  tr:hover { background: #334155; }
  a { color: #38bdf8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .score { display: inline-block; width: 28px; height: 28px; line-height: 28px; text-align: center; border-radius: 50%; font-size: 12px; font-weight: 700; }
  .score.high { background: #166534; color: #4ade80; }
  .score.mid { background: #854d0e; color: #fbbf24; }
  .score.low { background: #991b1b; color: #fca5a5; }
  .status { padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .status.aplicado { background: #166534; color: #4ade80; }
  .status.dry-run { background: #1e40af; color: #93c5fd; }
  .empty { text-align: center; padding: 48px; color: #64748b; }
</style>
</head>
<body>
  <h1>Job Bot - Dashboard</h1>

  <div class="stats">
    <div class="stat-card">
      <div class="stat-value">${stats.hoje.total}</div>
      <div class="stat-label">Hoje</div>
      <div class="stat-sub">Score medio: ${stats.hoje.score_medio ? stats.hoje.score_medio.toFixed(1) : '-'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.total}</div>
      <div class="stat-label">Total</div>
    </div>
    ${plataformasRows}
  </div>

  ${candidaturas.length > 0 ? `
  <table>
    <thead>
      <tr>
        <th>Data</th>
        <th>Plataforma</th>
        <th>Empresa</th>
        <th>Vaga</th>
        <th>Score</th>
        <th>Status</th>
        <th>Link</th>
      </tr>
    </thead>
    <tbody>
      ${linhasTabela}
    </tbody>
  </table>
  ` : '<div class="empty">Nenhuma candidatura registrada ainda.</div>'}

</body>
</html>`;
}

export function iniciarDashboard(port: number): void {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(gerarHTML());
  });

  server.listen(port, () => {
    console.log(`[DASHBOARD] Rodando em http://localhost:${port}`);
  });
}
