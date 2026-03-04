# 🤖 Auto Apply Bot — AI-Powered Job Application Agent

**Agente inteligente que automatiza candidaturas a vagas de emprego usando IA (Gemini) + Browser Automation (Playwright MCP).**

O bot navega por portais de vagas (Gupy, Vagas.com, LinkedIn, Indeed), analisa cada vaga, preenche formulários automaticamente com respostas variadas e naturais, e gerencia todo o processo de candidatura — tudo usando seu navegador Chrome já logado.

---

## ✨ Features

| Feature | Descrição |
|---|---|
| **AI Agent (Gemini)** | Usa Google Gemini como cérebro — entende vagas, preenche formulários, toma decisões |
| **Playwright MCP** | Controla o Chrome real do usuário via CDP — sem logins, sem CAPTCHAs |
| **Tailored Resume** | Gera currículo personalizado por vaga via IA — destaca skills relevantes, converte HTML→PDF |
| **Cover Letter** | Gera carta de apresentação personalizada por vaga com validação anti-fabricação |
| **Answer Cache** | Cacheia respostas de formulário no SQLite — economiza tokens e acelera execuções futuras |
| **Multi-Curriculum** | Fallback: seleciona entre currículos pré-prontos se o tailored falhar |
| **Smart Scoring** | Pontua vagas de 1-10 antes de aplicar — só aplica em vagas compatíveis |
| **Dry-Run Mode** | Testa todo o fluxo sem enviar candidaturas de verdade |
| **Location Filter** | Filtra por localização e modelo de trabalho (remoto/híbrido/presencial) |
| **Anti-Duplicate** | Banco de dados SQLite rastreia vagas já vistas e candidaturas feitas |
| **Auto Pagination** | Navega automaticamente pelas páginas de resultados |
| **Screenshots** | Captura screenshot como prova de cada candidatura |
| **Web Dashboard** | Dashboard em tempo real para acompanhar candidaturas |
| **Telegram Notifications** | Receba notificações no Telegram a cada candidatura |
| **Email Reports** | Relatório HTML por email ao final de cada execução |
| **File Logging** | Log completo de cada execução salvo em arquivo |
| **Cron Scheduling** | Agende execuções automáticas diárias |
| **Recovery** | Recupera o estado em caso de falha/interrupção |
| **Sliding Window** | Gerencia contexto do Gemini descartando histórico antigo — evita estouro de tokens |
| **Pre-defined Q&A** | Respostas base para perguntas comuns em formulários |
| **Response Variation** | Varia respostas automaticamente para parecer humano |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────┐
│                    index.ts                      │
│            (orquestrador principal)              │
├──────────┬──────────┬──────────┬────────────────┤
│ agente   │ dashboard│ telegram │ email / cron   │
│ (Gemini) │ (HTTP)   │ (HTTPS)  │ (SMTP)         │
├──────────┴──────────┴──────────┴────────────────┤
│                   tools.ts                       │
│  pontuar_vaga | gerar_curriculo_tailored         │
│  gerar_cover_letter | buscar_resposta_cache      │
│  registrar_candidatura | salvar_screenshot       │
├─────────────────────────────────────────────────┤
│              Playwright MCP                      │
│        (browser automation via CDP)              │
├─────────────────────────────────────────────────┤
│          Chrome (--remote-debugging-port)        │
│         Já logado nos sites de vagas             │
└─────────────────────────────────────────────────┘
```

**Stack:** TypeScript · Google Gemini API · Playwright MCP · SQLite · Node.js

---

## 🚀 Quick Start

### 1. Pré-requisitos

- **Node.js** 18+
- **Google Chrome** instalado
- **Chave da API do Gemini** ([console.cloud.google.com](https://console.cloud.google.com))

### 2. Instalação

```bash
git clone https://github.com/LuisMIguelFurlanettoSousa/auto-apply-bot.git
cd auto-apply-bot
npm install
```

### 3. Configuração

```bash
# Copie os arquivos de exemplo
cp .env.example .env
cp config/perfil.example.json config/perfil.json
cp config/curriculos.example.json config/curriculos.json

# Edite com seus dados
nano .env                    # Chave do Gemini + configs
nano config/perfil.json      # Seus dados pessoais/profissionais
nano config/sites.json       # Sites e URLs de busca
nano config/respostas.json   # Respostas pré-definidas para formulários
```

### 4. Prepare o Chrome

```bash
# Abra o Chrome com porta de debug habilitada
google-chrome --remote-debugging-port=9222

# Faça login manualmente nos sites de vagas (Gupy, LinkedIn, etc.)
```

### 5. Execute

```bash
# Modo dry-run (recomendado para testar)
DRY_RUN=true npm start

# Modo produção
npm start
```

---

## ⚙️ Configuração Detalhada

### `.env` — Variáveis de Ambiente

| Variável | Descrição | Padrão |
|---|---|---|
| `GEMINI_API_KEY` | Chave da API do Google Gemini | *obrigatório* |
| `CDP_ENDPOINT` | Endpoint CDP do Chrome | `http://localhost:9222` |
| `GEMINI_MODEL` | Modelo do Gemini | `gemini-2.5-pro` |
| `LIMITE_DIARIO` | Max candidaturas por execução | `10` |
| `SCORE_MINIMO` | Score mínimo para aplicar (1-10) | `6` |
| `DRY_RUN` | Modo teste (não envia de verdade) | `true` |
| `DASHBOARD_PORT` | Porta do dashboard web | `3000` |
| `TELEGRAM_BOT_TOKEN` | Token do bot Telegram | *opcional* |
| `TELEGRAM_CHAT_ID` | Chat ID do Telegram | *opcional* |
| `SMTP_HOST` | Servidor SMTP | `smtp.gmail.com` |
| `SMTP_USER` | Email SMTP | *opcional* |
| `SMTP_PASS` | Senha de app SMTP | *opcional* |
| `EMAIL_DESTINATARIO` | Email para relatórios | *opcional* |
| `CRON_ATIVO` | Ativar agendamento | `false` |
| `CRON_HORARIO` | Horário da execução | `09:00` |

### `config/perfil.json` — Perfil do Candidato

Seus dados pessoais e profissionais que o agente usa para preencher formulários. Veja `perfil.example.json` para a estrutura completa.

### `config/sites.json` — Sites de Vagas

Configure quais sites o bot deve navegar e quais URLs de busca usar. Cada site pode ter múltiplas URLs de busca.

### `config/respostas.json` — Respostas Pré-definidas

Respostas base para perguntas comuns (pretensão salarial, pontos fortes, etc.). O agente usa como base e varia a forma de escrever.

### `config/curriculos.json` — Mapeamento de Currículos

Configure múltiplos currículos otimizados para diferentes tipos de vaga. O agente escolhe automaticamente o mais adequado.

---

## 📊 Dashboard

Acesse `http://localhost:3000` durante a execução para ver em tempo real:

- Total de candidaturas (hoje e geral)
- Candidaturas por plataforma
- Score médio
- Tabela detalhada com empresa, vaga, score, status e link

---

## 🔧 Sistema de Scoring

O bot avalia cada vaga antes de aplicar:

| Critério | Impacto |
|---|---|
| Tech match (cada tecnologia) | +1 |
| Senioridade júnior/pleno | +1 |
| Senioridade sênior | -2 |
| Localização na sua cidade | +1 |
| Modelo remoto | +1 |
| Presencial/híbrido fora da cidade | -3 |

Score final entre 1-10. Só aplica se `score >= SCORE_MINIMO`.

---

## 📄 Currículo Tailored + Cover Letter

Diferente de outros bots que enviam o mesmo currículo para todas as vagas, o Auto Apply Bot **gera um currículo e carta de apresentação personalizados para cada vaga**:

1. O agente lê a descrição completa da vaga
2. Faz uma chamada separada ao Gemini com prompt ultra-restritivo
3. O Gemini **reorganiza e reescreve** o currículo destacando skills relevantes
4. **Validação anti-fabricação**: escaneia o HTML gerado buscando tecnologias que o candidato não possui — rejeita se encontrar
5. Converte HTML → PDF via Chrome headless (`--print-to-pdf`)
6. Cache por hash da descrição — vagas similares reutilizam o mesmo PDF

A cover letter segue a mesma lógica: personalizada por vaga, máximo 150 palavras, sem clichês, com validação + retry se fabricar skills.

Se a geração falhar, cai automaticamente nos currículos pré-prontos (fallback).

---

## 💾 Cache de Respostas

Inspirado no AIHawk (29k stars), o bot cacheia respostas de formulário no SQLite:

- **Primeira execução**: gera respostas via Gemini e salva no cache
- **Execuções seguintes**: busca no cache antes de gerar — economiza tokens
- **Matching**: exact match (sanitizado) + substring match para dropdowns
- **Regra inteligente**: respostas que mencionam o nome da empresa não são cacheadas (são específicas demais)
- Cover letters nunca são cacheadas (sempre personalizadas)

---

## 📁 Estrutura do Projeto

```
auto-apply-bot/
├── src/
│   ├── index.ts          # Entry point + orquestração
│   ├── agente.ts         # Loop do agente Gemini
│   ├── tools.ts          # Custom tools (scoring, CV, screenshot, cache...)
│   ├── curriculo-tailored.ts  # Geração de currículo personalizado por vaga
│   ├── cover-letter.ts   # Geração de carta de apresentação por vaga
│   ├── database.ts       # SQLite (candidaturas, vagas vistas, cache)
│   ├── dashboard.ts      # Dashboard web
│   ├── mcp-client.ts     # Conexão Playwright MCP
│   ├── logger.ts         # Log em arquivo
│   ├── notificacoes.ts   # Telegram
│   ├── email.ts          # Relatórios por email
│   ├── cron.ts           # Agendamento
│   └── types.ts          # Interfaces TypeScript
├── config/
│   ├── perfil.example.json       # Template do perfil
│   ├── curriculos.example.json   # Template dos currículos
│   ├── sites.json                # Sites de vagas
│   └── respostas.json            # Respostas pré-definidas
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 🔐 Segurança

- **Seus dados pessoais NUNCA são commitados** (protegidos pelo `.gitignore`)
- O bot usa **seu Chrome já logado** — nenhuma senha é armazenada no código
- Modo **dry-run** para testar com segurança antes de ativar
- Screenshots salvos apenas localmente
- Notificações via HTTPS (Telegram API)

---

## 🛣️ Roadmap

- [ ] Suporte a mais plataformas (Catho, Trampos, etc.)
- [ ] CAPTCHA handling via Telegram (humano resolve, bot continua)
- [ ] Blacklist de empresas/títulos
- [ ] Mensagem automática para recrutadores
- [ ] Multi-LLM (Gemini + Ollama local como fallback)
- [ ] Anonimização de dados antes de enviar ao LLM
- [ ] Docker support
- [ ] Tracking de custo de tokens

---

## 🤝 Contributing

Contribuições são bem-vindas! Abra uma issue ou pull request.

1. Fork o repositório
2. Crie uma branch (`git checkout -b feature/minha-feature`)
3. Commit suas mudanças (`git commit -m 'feat: adiciona minha feature'`)
4. Push (`git push origin feature/minha-feature`)
5. Abra um Pull Request

---

## ⚠️ Disclaimer

Este projeto é para fins educacionais e de automação pessoal. Use com responsabilidade:
- Respeite os termos de serviço de cada plataforma
- Não faça spam ou candidaturas em massa sem critério
- Use o modo dry-run para testar antes
- O autor não se responsabiliza pelo uso indevido

---

## 📄 License

MIT License — veja [LICENSE](LICENSE) para detalhes.
