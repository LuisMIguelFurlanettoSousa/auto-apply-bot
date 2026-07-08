# 🤖 Auto Apply Bot — AI-Powered Job Application Agent

**Agente inteligente que automatiza candidaturas a vagas de emprego usando IA (Gemini) + Browser Automation (Playwright MCP).**

O bot navega por portais de vagas (Gupy, Vagas.com, LinkedIn, Indeed), analisa cada vaga, preenche formulários automaticamente com respostas variadas e naturais, e gerencia todo o processo de candidatura — tudo usando seu navegador Chrome já logado.

---

## ⚠️ Status do Projeto: Em Desenvolvimento

> **Este projeto ainda não funciona de ponta a ponta de forma totalmente autônoma.** O principal obstáculo são os **sistemas anti-bot** (Cloudflare, reCAPTCHA, Turnstile, hCaptcha) que portais como Gupy e LinkedIn usam para bloquear automação — muitas vezes já na página de busca, antes de chegar às vagas.
>
> O bot **não tenta "resolver" CAPTCHA automaticamente** (isso não é possível para reCAPTCHA/Turnstile, cujo token depende do contexto do navegador). Quando encontra um, ele te avisa no **Telegram** e **você resolve manualmente** no Chrome aberto, respondendo **OK** para continuar. O caminho com mais chance é o **LinkedIn Easy Apply** e formulários simples; portais com muro anti-bot logo na entrada continuam inviáveis.
>
> Mesmo com o CAPTCHA resolvido à mão, o fluxo completo (preencher e enviar candidaturas reais em cada portal) **ainda não foi validado de ponta a ponta**. Use sempre o modo `DRY_RUN=true` primeiro. Contribuições e testes são bem-vindos.

---

## ✨ Features

| Feature | Descrição |
|---|---|
| **AI Agent (Gemini)** | Usa Google Gemini como cérebro — entende vagas, preenche formulários, toma decisões |
| **Playwright MCP** | Controla o Chrome real do usuário via CDP — reaproveita a sessão já logada |
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
| **Recovery** | Detecta execução anterior interrompida e avisa o agente; o anti-duplicata (SQLite) evita refazer o trabalho já concluído |
| **Sliding Window** | Gerencia contexto do Gemini descartando histórico antigo — evita estouro de tokens |
| **Pre-defined Q&A** | Respostas base para perguntas comuns em formulários |
| **Response Variation** | Varia respostas automaticamente para parecer humano |
| **Error Classification** | Classifica falhas como permanentes (pula) ou retriáveis (retenta com backoff) |
| **CAPTCHA via Telegram** | Envia screenshot do CAPTCHA pro Telegram — humano resolve, bot continua |
| **Recruiter Messaging** | Envia mensagem personalizada para recrutadores no LinkedIn (nota de conexão) |
| **Token Cost Tracking** | Registra tokens de cada chamada ao Gemini e calcula custo em USD |
| **Multi-LLM** | Adapter pattern: Gemini (padrão), Ollama (local/grátis) ou OpenAI-compatible como provider auxiliar |
| **PII Anonymization** | Anonimiza nome, email, telefone e links antes de enviar ao LLM — restaura no resultado final |

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
│  registrar_candidatura | reportar_falha          │
├─────────────────────────────────────────────────┤
│              Playwright MCP                      │
│        (browser automation via CDP)              │
├─────────────────────────────────────────────────┤
│          Chrome (--remote-debugging-port)        │
│         Já logado nos sites de vagas             │
└─────────────────────────────────────────────────┘
```

**Stack:** TypeScript · Google Gemini API · Playwright MCP · SQLite · Node.js · Multi-LLM (Ollama/OpenAI)

---

## 🚀 Quick Start

### 1. Pré-requisitos

- **Node.js** 18+
- **Google Chrome** instalado
- **Chave da API do Gemini** ([Google AI Studio](https://aistudio.google.com/apikey))

> ⚠️ **Importante**: O plano gratuito do Gemini tem limites muito baixos (ex: 20 requests/dia no Flash, limites ainda menores no Pro). O bot consome muitas chamadas por execução (cada iteração do agente = 1 request), então o tier gratuito **não é suficiente** para uso real. É necessário [ativar o billing](https://aistudio.google.com/apikey) na sua API key para ter limites adequados (2000 req/min no plano pago). O custo do `gemini-2.5-flash` é muito baixo (~$0.15/milhão de tokens de input).

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
cp config/respostas.example.json config/respostas.json

# Edite com seus dados
nano .env                    # Chave do Gemini + configs
nano config/perfil.json      # Seus dados pessoais/profissionais
nano config/sites.json       # Sites e URLs de busca
nano config/respostas.json   # Respostas pré-definidas para formulários
```

### 4. Prepare o Chrome

```bash
# Abra o Chrome com porta de debug habilitada (requer --user-data-dir separado)
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-debug-profile"

# Faça login manualmente nos sites de vagas (Gupy, LinkedIn, etc.)
# Na primeira vez o Chrome abrirá "limpo" — as sessões ficam salvas nesse perfil separado
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
| `CDP_ENDPOINT` | Endpoint CDP do Chrome (use `127.0.0.1`, não `localhost`, p/ evitar `ECONNREFUSED ::1`) | `http://127.0.0.1:9222` |
| `GEMINI_MODEL` | Modelo do Gemini (flash é ~16x mais barato) | `gemini-2.5-flash` |
| `LIMITE_DIARIO` | Max candidaturas por dia | `10` |
| `MAX_POR_EXECUCAO` | Teto de envios reais por execução (anti-rajada) | `5` |
| `DELAY_MIN` | Delay mínimo entre ações (ms) | `2000` |
| `DELAY_MAX` | Delay máximo entre ações (ms) | `5000` |
| `SCORE_MINIMO` | Score mínimo para aplicar (1-10) | `6` |
| `CUSTO_MAX_USD` | Teto de custo por execução em USD (0 = desativado) | `0` |
| `DRY_RUN` | Modo teste — checkpoint bloqueia envio e registro grava como `dry-run` | `true` |
| `DASHBOARD_PORT` | Porta do dashboard web | `3000` |
| `TELEGRAM_BOT_TOKEN` | Token do bot Telegram | *opcional* |
| `TELEGRAM_CHAT_ID` | Chat ID do Telegram | *opcional* |
| `SMTP_HOST` | Servidor SMTP | `smtp.gmail.com` |
| `SMTP_USER` | Email SMTP | *opcional* |
| `SMTP_PASS` | Senha de app SMTP | *opcional* |
| `EMAIL_DESTINATARIO` | Email para relatórios | *opcional* |
| `CRON_ATIVO` | Ativar agendamento | `false` |
| `CRON_HORARIO` | Horário da execução | `09:00` |
| `LLM_AUX_PROVIDER` | Provider auxiliar: `gemini`, `ollama`, `openai` | `gemini` |
| `LLM_AUX_MODEL` | Modelo do provider auxiliar | `gemini-2.5-flash` |
| `OLLAMA_URL` | URL do servidor Ollama | `http://localhost:11434` |
| `OPENAI_API_KEY` | Chave da API OpenAI (ou compatível) | *opcional* |
| `OPENAI_BASE_URL` | Base URL da API OpenAI-compatible | `https://api.openai.com/v1` |

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

**Critérios eliminatórios** (forçam PULAR, independente do score):
- **Idioma** — a vaga exige inglês acima do seu `nivel_ingles` do perfil.
- **Localização** — vaga presencial/híbrida fora da sua cidade quando você só aceita remoto.
- **Blacklist** — empresa ou termo de título que você listou em `blacklist_empresas` / `blacklist_termos_titulo`.

---

## 🎛️ Controle e Segurança (copiloto, não autopiloto)

A filosofia: o **código** garante o que a arquitetura permite garantir (a gravação), e os demais pontos de risco passam por checkpoints explícitos — em vez de deixar tudo na "boa vontade" de um prompt de 200 linhas.

- **Gate de registro (garantia real, determinística)** — `registrar_candidatura` recusa **no código** qualquer vaga abaixo do `SCORE_MINIMO` ou em blacklist, e em `DRY_RUN=true` grava sempre como `dry-run` (nunca `aplicado`), aconteça o que acontecer com o LLM. Essa é a salvaguarda final.
- **Checkpoint de envio (`confirmar_envio`)** — o agente passa por ele antes de cada clique de envio; em dry-run responde "bloqueado" e aplica o `MAX_POR_EXECUCAO`. É **cooperativo**: o clique em si é uma ação de browser que o agente controla, então o checkpoint reduz risco e conta envios, mas não é uma barreira física. (Reforçá-lo com mais código não ajudaria — a arquitetura LLM+browser não permite uma trava física do clique; por isso o gate de registro é o que de fato protege.)
- **Teto de custo** — `CUSTO_MAX_USD` interrompe o loop se o gasto passar do limite.
- **Abandono de portal** — se um portal bloqueia na entrada (Cloudflare), o bot abandona aquele portal e segue para o próximo, em vez de insistir.

> ⚠️ **Risco de conta**: o bot usa seu Chrome **logado** e automatizar portais viola os ToS (especialmente o LinkedIn). Comece em `DRY_RUN=true`, use volumes baixos e, de preferência, uma conta não-principal.

---

## 📈 Acompanhamento de Resultados

A candidatura não morre em "aplicado": você registra o desfecho e o dashboard mostra **métricas de retorno** (taxa de resposta, entrevistas) em vez de só volume.

```bash
npm run resultado                      # lista candidaturas com seus ids
npm run resultado 42 entrevista        # marca o desfecho da candidatura 42
```

Resultados válidos: `aguardando`, `respondido`, `entrevista`, `oferta`, `rejeitado`, `sem_resposta`.

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

## 🛡️ Classificação de Falhas

Adaptado do [ApplyPilot](https://github.com/nicognaW/ApplyPilot), o bot classifica erros automaticamente para decidir se deve pular ou retentar:

### Falhas Permanentes (nunca retenta)
| Código | Descrição |
|---|---|
| `vaga_expirada` | Vaga não está mais disponível |
| `captcha` | CAPTCHA detectado na página |
| `sessao_expirada` | Sessão expirou, precisa relogar |
| `ja_aplicou` | Candidato já se candidatou (detectado pelo site) |
| `sso_obrigatorio` | Requer login SSO |
| `site_bloqueado` | Site bloqueou acesso |
| `cloudflare` | Proteção anti-bot ativa |
| `formulario_incompativel` | Formulário não suportado |

### Falhas Retriáveis (max 3 tentativas com backoff exponencial)
| Código | Descrição |
|---|---|
| `timeout` | Página demorou para carregar |
| `erro_rede` | Erro de conexão |
| `erro_servidor` | HTTP 500/502/503 |
| `elemento_nao_encontrado` | Elemento sumiu da página |
| `erro_upload` | Falha no upload de arquivo |

**Melhoria sobre o ApplyPilot**: backoff exponencial (5s → 15s → 45s) em vez de retry imediato.

---

## 🔒 CAPTCHA: checkpoint humano (não "resolução automática")

Seja realista: reCAPTCHA, Turnstile e hCaptcha **não têm "solução de texto"** que alguém possa digitar remotamente — o token é gerado no contexto do navegador a partir de sinais comportamentais. Então o bot **não resolve** CAPTCHA; ele te chama para resolver:

1. O agente detecta o CAPTCHA/desafio e tira screenshot
2. Envia a foto para o Telegram pedindo que você resolva **manualmente no Chrome aberto**
3. Você resolve no Chrome e responde **OK** (ou **PULAR**) — polling, timeout 5 min
4. Em `OK`, o bot **reverifica a página** (browser_snapshot) e só continua se o desafio sumiu
5. Em `PULAR`/timeout, a vaga é pulada (`captcha`); se o bloqueio foi na página de busca, o portal inteiro é abandonado (`portal_bloqueado`)

**Requisitos**: `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` no `.env`. Sem Telegram, o bot pula a vaga.

---

## 💬 Mensagem para Recrutadores

Adaptado do [beatwad](https://medium.com/@beatwad): após se candidatar a uma vaga com **score alto (>= 8)** no LinkedIn, o bot tenta contatar o recrutador/hiring manager:

1. Identifica o recrutador na página da vaga
2. Verifica se já foi contatado anteriormente (banco SQLite)
3. Gera mensagem personalizada via Gemini (max 280 chars — limite do LinkedIn)
4. Navega até o perfil do recrutador
5. Envia convite de conexão com nota personalizada
6. Registra no banco para não recontatar

**Limites**: máximo 5 mensagens/dia. Candidatura sempre tem prioridade — a mensagem é um bônus.

---

## 🔐 Anonimização de PII

Adaptado do [beatwad](https://medium.com/@beatwad): antes de enviar dados ao LLM, o bot substitui informações pessoais por placeholders. Após receber a resposta, restaura os dados reais.

| Campo | Placeholder |
|---|---|
| Nome completo | `[CANDIDATO]` |
| Email | `candidato@email.example` |
| Telefone | `(00) 00000-0000` |
| LinkedIn | `https://linkedin.com/in/candidato` |
| GitHub | `https://github.com/candidato` |
| Portfolio | `https://candidato.dev` |

**Onde é aplicado:**
- Cover letter (prompt + de-anonimização do resultado)
- Currículo tailored (HTML template + prompt + de-anonimização antes de gerar PDF)
- Mensagem para recrutadores (prompt + de-anonimização)
- System prompt do agente principal (PII de contato removido, disponível via tool sob demanda)

**Dados profissionais** (stack, experiências, resumo) continuam visíveis no prompt — são necessários para gerar conteúdo relevante.

> **Limitação importante (seja realista):** a anonimização cobre os **módulos auxiliares** (cover letter, currículo, mensagem ao recrutador). O **agente principal** recebe o nome real no system prompt e, ao preencher formulários, obtém email/telefone/links via a tool `obter_perfil_candidato` — ou seja, esses dados de contato chegam ao LLM principal (Gemini). Se quiser manter os módulos auxiliares 100% locais (sem enviar nada a provedores externos), use o provider **Ollama**.

---

## 🔀 Multi-LLM (Adapter Pattern)

Adaptado do [AIHawk](https://github.com/feder-cr/Auto_Jobs_Applier_AIHawk): o agente principal sempre usa **Gemini** (precisa do SDK de function calling), mas as tarefas auxiliares (cover letter, currículo tailored, mensagem para recrutador) podem usar **qualquer provider**:

| Provider | Config | Custo | Observação |
|---|---|---|---|
| **Gemini** (padrão) | `LLM_AUX_PROVIDER=gemini` | Pago (API key) | Mesmo modelo do agente |
| **Ollama** (local) | `LLM_AUX_PROVIDER=ollama` | Grátis | Roda na sua máquina, sem enviar dados |
| **OpenAI-compatible** | `LLM_AUX_PROVIDER=openai` | Varia | OpenAI, Groq, Together AI, Mistral, vLLM |

### Setup Ollama (custo zero)

```bash
# Instale: https://ollama.com
curl -fsSL https://ollama.com/install.sh | sh

# Baixe um modelo
ollama pull llama3

# Configure no .env
LLM_AUX_PROVIDER=ollama
LLM_AUX_MODEL=llama3
OLLAMA_URL=http://localhost:11434
```

### Setup OpenAI-compatible

```bash
# Funciona com: OpenAI, Groq, Together AI, Mistral, vLLM
LLM_AUX_PROVIDER=openai
LLM_AUX_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
```

**Fallback automático**: se o provider auxiliar falhar, o bot retenta automaticamente com Gemini.

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
│   ├── erros.ts          # Classificação de falhas (permanentes vs retriáveis)
│   ├── mensagem-recrutador.ts  # Mensagem personalizada para recrutadores
│   ├── token-tracker.ts  # Tracking de custo de tokens (USD)
│   ├── llm-adapter.ts   # Multi-LLM adapter (Gemini/Ollama/OpenAI)
│   ├── anonimizacao.ts  # Anonimização de PII (nome, email, telefone, links)
│   ├── database.ts       # SQLite (candidaturas, vagas vistas, cache, mensagens)
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
- [x] ~~CAPTCHA handling via Telegram (humano resolve, bot continua)~~
- [x] ~~Blacklist de empresas/títulos~~
- [x] ~~Loop de feedback de resultados (entrevista/oferta/rejeição) + métricas de funil~~
- [x] ~~Critérios eliminatórios de fit (idioma, localização)~~
- [x] ~~Mensagem automática para recrutadores~~
- [x] ~~Multi-LLM (Gemini + Ollama local como fallback)~~
- [x] ~~Anonimização de dados antes de enviar ao LLM~~
- [ ] Docker support
- [x] ~~Tracking de custo de tokens~~

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
