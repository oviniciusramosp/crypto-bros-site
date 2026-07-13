# Crypto Bros Site — Claude Code Knowledge Base

## Idioma de Comunicação (OBRIGATÓRIO)

**Comunicação com o usuário**: Sempre em **Português (BR)**.
**Código e commits**: Sempre em **inglês** (variáveis, funções, comentários, commits, nomes de arquivo, strings de log).

---

## O que é este repo

Site estático de **crypto-bros.com** — Feed gated por login Google, com paridade visual com o Feed do app.

**Sem build step.** HTML/CSS/JS vanilla servido direto pelo GitHub Pages (`.github/workflows/deploy-site.yml` publica a raiz do repo a cada push na `main`).

Repo é **público** porque o GitHub Pages no plano Free exige repo público — o do app é privado.

## Ecossistema Crypto Bros — onde aplicar cada mudança (OBRIGATÓRIO)

> **Regra**: antes de editar, confirme que está no repo certo. Mudança de **API/backend nunca vai neste repo** — aqui só vive o cliente web.

| Repo                    | O que é                                                              | Onde mexer                                                       |
| ----------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **crypto-bros-site**    | ⬅️ **este repo**. Site crypto-bros.com — estático, GitHub Pages       | HTML/CSS/JS, Feed web, i18n do site, PWA/service worker          |
| **crypto-bros-api**     | Cloudflare Worker — API deste site **e** do app (privado)             | Endpoint, auth/sessão, `/web/*`, schema D1, KV, cron de Web Push  |
| **crypto-bros-app**     | App iOS/Android — Expo + React Native (privado)                      | UI do app. **Fonte de verdade do design system**                  |
| **crypto-bros-legal**   | Privacy Policy + Terms — GitHub Pages (público)                      | Textos legais (URLs do OAuth consent screen)                     |
| **crypto-bros-content** | Conteúdo estático app-native via `raw.githubusercontent` (público)   | Migração Notion → formato estático                                |

**Este site não tem backend próprio.** Todo dado vem do Worker (`crypto-bros-api`) via HTTP:

| Rota            | O que traz                                     |
| --------------- | ---------------------------------------------- |
| `GET /web/feed` | Feed gated por sessão (requer login Google)    |
| `GET /web/post` | Detalhe do post (blocos completos)             |
| `GET /web/mvrv` | MVRV Z-Score (proxy CoinMetrics — CORS)        |
| `GET /web/fng`  | Fear & Greed (proxy alternative.me — CORS)     |

**Precisa de um dado novo, ou mudar o shape de um existente?** A mudança é em **`crypto-bros-api`** primeiro (`wrangler deploy`), e só depois aqui. Não tente contornar no cliente.

## Design system

Os tokens são **espelhados à mão** de `crypto-bros-app/src/theme/*`. **O app é a fonte de verdade** — ao divergir, ajuste o site para bater com o app, nunca o contrário.

## Arquivos

| Arquivo                  | Responsabilidade                                        |
| ------------------------ | ------------------------------------------------------- |
| `index.html`             | Estrutura: marquee, widgets, tag filter, feed, modal    |
| `styles.css`             | Design system espelhado do app (light/dark)             |
| `app.js`                 | Lógica: login, feed, filtros, modal, renderer de blocos |
| `i18n.js`                | Strings PT/EN + toggle + datas relativas                |
| `sw.js`                  | Service worker (cache/offline)                          |
| `scripts/`               | Geração das páginas `/p/<id>` (rich link previews)      |
| `CNAME`                  | crypto-bros.com                                         |
| `.nojekyll`              | Desliga o Jekyll no Pages                               |

## Preview local

```bash
python3 -m http.server 5173   # → http://localhost:5173
```

`app.js` tem modo preview em localhost (posts mock, widgets de mercado reais) — o login é bypassado.

## Gotchas

- **Google login exige origem HTTPS.** Em `http://` dá `origin_mismatch` — por isso o preview local tem bypass.
- **Assets são cacheados agressivamente pelo Pages.** Ao mudar `styles.css`/`app.js`, bumpar o `?v=N` no `index.html`.
- **Share URL precisa de trailing slash** em `/p/<id>/` — sem ele o Pages responde 301 e o crawler de preview perde o OG.

---

## Histórico

Este repo viveu por engano num scratchpad temporário do Claude Code (`/private/tmp/...`) até jul/2026, quando foi movido para `~/Documents/Apps/crypto-bros-site`. Nunca mais trabalhe nele a partir de `/tmp` — o diretório é descartável.
