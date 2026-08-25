# TIMC — V0

Repozitoriyaga bog'langan, uzilishga chidamli injiniring pipeline'i.
A durable, resumable engineering pipeline attached to a Git repository.

TIMC runtime emas — **protokol**: `.timc/` artefaktlari + deterministik `timc` CLI +
yupqa Claude Code plugin qatlami. Enforcement CLI, Git va hook'larda yashaydi,
promptda emas — shuning uchun protokolni buzish uchun modelni ishontirish yetarli emas.

To'liq arxitektura: `compensation/.claude/plans/timc-agentic-pipeline-v1.md`

---

## V0 nima qiladi / what V0 does

| | |
|---|---|
| `timc init` | `.timc/` ni yaratadi, **o'zining git repo'si** sifatida (D-2), kod repo'sining `.git/info/exclude` ga qo'shadi, stack'ni aniqlaydi |
| `timc new "<title>"` | Task yaratadi, track'ni deterministik skorlaydi (trivial / standard / high_risk) |
| `timc next` | Hozir nima qilish kerakligining yagona manbasi (`--json` bilan agent uchun) |
| `timc ask / answer / frontier` | Interview = **design tree, rounds bo'yicha**: frontier bo'shamaguncha faza yopilmaydi; har savol tavsiya bilan |
| `timc brief` | Fazaga mos, token-budjetli kontekst paketi (SessionStart hook shuni inject qiladi) |
| `timc phase advance` | Gate tekshiruvi bilan faza almashtirish; nima yetishmayotganini aniq aytadi |
| `timc step add/start/complete` | **Evidence bo'lmasa yopilmaydi** |
| `timc run -- <cmd>` | Buyruqni ishga tushiradi va haqiqiy exit kodini yozib qo'yadi |
| `timc checkpoint` | Holat + iflos worktree snapshot'i (branch'ga commit qilmasdan) |
| `timc resume` | task.yaml ↔ event log ↔ evidence ↔ git ni solishtiradi, aniq tavsiya beradi |
| `timc doctor --rebuild` | `runtime/` ni committed haqiqatdan qayta quradi |
| `timc drift` | O'zgargan fayllarni reja `touches[]` bilan solishtiradi |

## O'rnatish / install

```bash
claude plugin install /path/to/timc --scope project
```

yoki bir sessiya uchun: `claude --plugin-dir /path/to/timc`

Keyin loyihada:

```bash
timc init
```

`init` `.timc/` ni yaratadi va uni kod repo'sidan **lokal** chiqaradi
(`.git/info/exclude`) — shared `.gitignore` ga tegilmaydi.

## Nega bu ishonchli / why this holds

- **Evidence'ni harness yozadi.** `PostToolUse` hook har Bash buyrug'ini
  `runtime/evidence.ndjson` ga yozadi; modelga `.timc/runtime/**` ga yozish
  **deny** qilingan. `echo "dotnet build"`, `dotnet build || true`,
  `dotnet build | tail -5` — uchalasi ham dalil sifatida rad etiladi.
- **Orchestrator kod yozmaydi.** Hook input'da `agent_id` faqat subagent'da
  bo'ladi — shu bilan asosiy sessiya mexanik ajratiladi (standard/high_risk).
- **Yangi sessiya kontekstsiz davom etadi.** `SessionStart` hook `timc brief` ni
  inject qiladi; model "qarab qo'yishni eslashi" shart emas.
- **Cache hech qachon yutmaydi.** `task.yaml` (committed) > `events.ndjson` >
  `state.json`. Nomuvofiqlikda `doctor --rebuild`.
- **Interview o'lchanadi.** Savollar `depends_on` bilan daraxt hosil qiladi;
  gate = **frontier bo'sh**. "Yetarli so'radim" degan qaror modelda emas.
- **Steplar vertikal.** `--delivers` majburiy: har step — tracer bullet, o'zi
  demo qilinadigan. Layer-shaped ("Domain model", "API controller") belgilanadi.
  Keng refaktoring uchun `expand → migrate* → contract` tartibi majburlanadi.

Interview / spec / slicing mexanikasi [mattpocock/skills](https://github.com/mattpocock/skills)
dagi `grilling`, `to-spec`, `to-tickets` skill'laridan olingan; TIMC ularni
**tekshiriladigan** ma'lumotga aylantiradi.

## Testlar / tests

```bash
npm test
```

24 ta test, jumladan V0 acceptance stsenariylari:

- `cold start` — `runtime/` o'chirilgan → yangi sessiya to'g'ri stepda davom etadi
- `kill mid-step` — uzilgan ish hech qachon "tugagan" ko'rinmaydi
- `fake report` — echo / `|| true` / pipe / eski evidence — hammasi rad etiladi
- `orchestrator deny` — standard trackda asosiy sessiya prod kod yoza olmaydi
- `gates` — bo'sh interview shabloni gate'dan o'tmaydi

## Struktura

```
bin/            timc shim (PATH ga qo'shiladi)
src/            CLI — LLM yo'q, toza funksiyalar
  machine.js    fazalar, gate'lar, next() — hammasi deterministik
  evidence.js   dalil yozish va tekshirish (invariant 13)
  brief.js      token-budjetli kontekst paketi
  commands/     har buyruq alohida modul
skills/timc/    /timc skill (orchestrator qoidalari)
hooks/          SessionStart · PreToolUse · PostToolUse · Stop · PreCompact …
test/           acceptance + unit
```

## V0 da yo'q (V1 rejasida)

Interview / spec / planner / tester subagentlari · `PreCompact` flush ·
`timc lint` (dictionary, fabricated approval, secrets) · `final --render` ·
`timc adopt` · usage/cost hisobi · Codex host adapter.
