# senpi-accounts 실행 계획

## 현재 상태 (2026-07-31, v0.2.4 배포 완료)

| 항목 | 상태 | 근거 |
|---|---|---|
| npm 배포 | **완료** | `@eddieparc/senpi-accounts@0.2.4` public, `npm view` latest=0.2.4 |
| 태그 푸시 무인 배포 | **완료** | run 30596450530 (`event=push`, `v0.2.4`) 전 스텝 success, provenance 서명 |
| 발행 멱등 가드 | **완료** | `scripts/publish-guard.mjs`, 이미 발행된 버전이면 publish 스텝을 건너뜀 |
| CI 게이트 | **완료** | `.github/workflows/ci.yml` — push/PR에서 typecheck·test·build |
| 결함 버전 차단 | **완료** | 0.2.0·0.2.1 `npm deprecate` (도구 호출 순서 버그) |
| Kiro 계정 3개 | **완료** | `jgp3620`, `jgplabs`, `jgplabs01` (auth.json 계정 풀) |
| Kiro opus-5 실호출 | **동작** | 격리 샌드박스에서 레지스트리 설치본으로 `ULW_REGISTRY_OK_20260731` 응답 |
| 실시간 스트리밍 | **동작** | 첫 visible delta까지만 버퍼, 이후 live iterator |
| 429/인증 실패 자동 전환 | **실API 검증** | 전환·차단 상태가 모든 전이에서 디스크에 영속 |
| 도구 스키마 호환 | **동작** | object union flatten, const→enum, additionalProperties 제거 |
| 모델 카탈로그 | **19개** | Kiro CLI 2.15.2 기준, override dedupe |
| 진단 로그 | **opt-in** | `KIRO_DEBUG=1`, 자격증명 리댁션 확인 |
| OpenGateway 프로바이더 | **동작** | `/login` API-key 경로, `moonshotai/kimi-k3-ultrafast` |
| `/usage` 대시보드 | **동작** | kiro 3계정 잔여량 집계 |
| 테스트 | 211개 통과 | `npm test` (23 files) |
| 타입체크 | 통과 | `npm run typecheck` |
| README 실행 검증 | 통과 | `node scripts/check-readme.mjs` |
| `/fast` 업스트림 버그 | PR 제출 | senpi#499→#503 후, 정정 이슈 #545/#548 · PR #547/#549 (OPEN) |

senpi `2026.7.30` 기준으로 검증했다. 증거는
`Eddie-Personal-Space/evidence/ulw-senpi-accounts-publish/`,
`Eddie-Personal-Space/evidence/ulw-accounts-followup/`.

### 남은 작업

저장소 자체에는 없다. 아래는 의도적으로 열어둔 항목이며, 각자 조건이 갖춰질 때 착수한다.

| 항목 | 왜 지금 안 하는가 |
|---|---|
| `codex-pool` 실API 검증 | opt-in(`SENPI_ACCOUNTS_CODEX_POOL=1`)이고 ChatGPT가 쿼터 엔드포인트를 주지 않아 배치가 어피니티로만 동작한다. 실사용 시점에 검증한다 |
| `alibaba-token-plan` 종단 검증 | 이 머신에 키가 없다. 순정 프로바이더이므로 키만 넣으면 동작한다 |
| 릴리스에서 `npm ci` 사용 | `@code-yeongyu/senpi`가 번들한 의존성(`https-proxy-agent`, `@hono/node-server`, `agent-base`)을 npm이 lockfile 누락으로 보고한다. 업스트림이 풀릴 때까지 `npm install` 유지 |

---


조사 근거는 `DESIGN.md` 참조. 이 문서는 "무엇을 어떤 순서로 만들 것인가"만 다룬다.

## 1. 레이어 분리 — 충돌 방지의 핵심

senpi에는 이미 **모델 단위** 폴백이 있다 (`core/retry-fallback/`):
- `SelectorCooldowns` — 실패한 `provider/model` 셀렉터를 런타임 동안 억제.
  429는 30초, quota/billing은 **30분**, 그 외 기본 5분.
- `chains.ts` — 셀렉터가 억제되면 다음 모델로 넘어가는 폴백 체인.

우리 애드온은 **계정 단위** 폴백이다. 두 계층은 이렇게 겹치지 않게 둔다:

```
요청
 └─ [우리 계층] 계정 선택 → 429면 다음 계정으로 재시도 (senpi는 이걸 못 봄)
     └─ 모든 계정 소진 시에만 에러를 위로 던짐
         └─ [순정 계층] SelectorCooldowns가 모델 억제 → 다음 모델로 폴백
```

계정 로테이션이 성공하는 한 senpi는 실패를 아예 관측하지 않으므로 충돌이 없다.

**결정적 통합 포인트**: `SelectorCooldowns.durationFor()`는 `retryAfterMs`가 있으면
그 값을 **최우선**으로 쓴다. 따라서 모든 계정이 막혔을 때 우리가 던지는 에러에
`retryAfterMs = (가장 빨리 풀리는 계정의 blockedUntil - now)`를 실어 보내면,
senpi의 억제 시간이 우리 failback 시점과 **정확히 일치**한다. 이걸 안 하면
quota 문자열이 섞였을 때 senpi가 30분을 통째로 억제해서, 5분 뒤 풀리는 계정을
놀리게 된다. → 회귀 테스트로 고정한다.

## 2. 계정 라우팅 3계층 (우선순위 순)

| 순위 | 계층 | 동작 |
|---|---|---|
| 1 | **캐시 어피니티** | 한 대화는 한 계정에 고정. 프리픽스 캐시를 지킨다 |
| 2 | **사용량 기반 배치** | 캐시가 어차피 콜드일 때(새 대화)만 잔여 쿼터 여유분에 배치 |
| 3 | **429 페일오버** | 최후 안전망 (구현·검증 완료) |

- 대화 지문은 **첫 사용자 메시지만** 해시 (Antigravity `session_manager.rs` 방식).
  모델명·타임스탬프를 섞지 않아야 턴이 진행돼도 앵커가 흔들리지 않는다.
- 배치는 **P2C**(상위 N개 중 2개 무작위 → 잔여량 큰 쪽). 항상 "제일 빈 계정"을
  고르면 몰림이 생긴다.
- Kiro 잔여량은 `getUsageLimits`(`usedCount`/`limitCount`)로 조회.

스케줄링 모드는 Antigravity를 벤치마크해 사용자가 고르게 한다:

| 모드 | 동작 |
|---|---|
| `cache-first` (기본) | 계정 고정 우선, 429면 짧게 대기(상한 있음). 캐시 히트 최대 |
| `balanced` | 계정 고정하되 429면 즉시 전환 |
| `spread` | 순수 라운드로빈. 부하 균등, 캐시 포기 |

## 3. /login · /logout 통합 (요구사항 10)

순정 `claude-agent-sdk/oauth-login.ts`가 이미 정답을 보여준다: `/login`의
`login()`이 기존 자격증명을 읽어 **`addAccount`로 계정을 추가**하고, 두 번째
계정부터는 이름을 물어본다(`promptAccountName`). 우리도 동일 패턴을 따른다.

- **`/login kiro`** → 계정 관리 메뉴를 띄운다:
  `추가 / 제거 / 고정(pin) / 고정해제 / 목록`.
  - 추가: Google·GitHub·AWS Builder ID 중 선택 → OAuth → 이름 입력
    (첫 계정은 자동으로 `default`, 이후 기본값 `account-N` 제시)
  - 제거: 등록된 계정 목록에서 선택
  - 이렇게 하면 **등록·삭제가 전부 `/login`에서 가능**하다. senpi 본체를
    수정하지 않고 요구사항을 만족하는 유일하게 깔끔한 방법.
- **`/logout kiro`** → 순정 동작 그대로: 해당 프로바이더 자격증명 전체 삭제
  (= 모든 계정 제거). 우리 풀이 그 자격증명 안에 살기 때문에 자동으로 일관됨.
- `/kiro-account ...` 서브커맨드는 스크립트·비대화형용으로 유지.

UX 원칙: 목록에 계정별 상태를 함께 보여준다 —
`jgplabs <메일> — available, google` / `jgp3620 — blocked 12m (rate_limit)`.

## 4. 구현 순서 — 결과

**Phase A — Kiro (완료)**
1. `retryAfterMs` 전파 + senpi 쿨다운 정합 — 완료. `src/core/failover.ts`, `test/core-failover.test.ts`
2. 대화 지문 기반 어피니티 + 스케줄링 모드 — 완료. `src/core/affinity.ts`, `test/core-affinity.test.ts`
3. `/login` 계정 관리 메뉴 — 완료. `src/providers/kiro/index.ts`
4. 3계정 등록 → opus-5 실호출 — 완료. 격리 샌드박스에서 레지스트리 설치본으로 검증
5. 429 전환·failback — 완료. 전환/차단 상태가 모든 전이에서 디스크에 영속

**Phase B — 나머지 프로바이더**
6. Codex 다중계정 — `codex-pool`로 구현(opt-in). 순정 스트리머를 런타임에 해석해 재사용
7. Anthropic — 순정 `/claude-account`가 이미 다중계정이므로 재구현하지 않음(의도적 미구현)
8. Alibaba Token Plan / OpenCode Go — 순정이 API 키로 처리하므로 애드온 불필요(의도적 미구현).
   순정에 없던 TokenRouter·OpenGateway만 프로바이더로 추가

**Phase C — 마감 (완료)**
9. 키체인 옵션 + 라운드트립 — 완료. `test/core-keychain.test.ts`, `test/core-keychain-probe.test.ts`
10. 프로바이더 1개 고장 시 격리 — 완료. `test/extension.test.ts`

## 5. 결정 사항 — 확정됨

- **D1**: `/logout kiro`는 순정과 동일하게 전체 삭제. 개별 삭제는 `/login kiro` 메뉴의
  `Log out of one account`가 담당한다(`src/providers/kiro/index.ts`).
- **D2**: 기본 스케줄링 모드는 `cache-first`. 개인 사용은 프리픽스 캐시 히트가
  잔여량 균등보다 이득이 크다(`src/core/affinity.ts` `DEFAULT_SCHEDULING_MODE`).
