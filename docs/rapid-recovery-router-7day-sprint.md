# Rapid-Recovery-Router 7일 매출 스프린트 실행 가이드

## 목표

- 핵심 KPI: `외부 유료건수/일`
- 7일 목표: 외부 유료 7건
- 가격 구조: `0.02 -> 0.05 -> 0.12`
- 모델 정책: `OPENROUTER_MODEL` unset, `OPENROUTER_FREE_MODEL`만 사용

## 오퍼 구성

- `ops_recovery_hotfix_openrouter_v1` (0.02)
- `ops_recovery_turbo_v1` (0.05)
- `ops_recovery_guardrail_v1` (0.12)

모든 오퍼 설명 첫 줄은 아래 문제 키워드 고정:

- `timeout | validation | rejected | retry payload`

## 일일 운영 명령

### 1) 무료 모델 점검 + 배포

```bash
npm run openrouter:free:apply:deploy
```

실패 시 자동 롤백:

- `OPENROUTER_FREE_MODEL=openrouter/free`
- `OPENROUTER_MODEL` 삭제

### 2) KPI 리포트 생성 (JSON/CSV)

```bash
npx tsx scripts/rapid_recovery_kpi_report.ts \
  --window-hours 24 \
  --output-json logs/rapid_recovery_kpi_latest.json \
  --output-csv logs/rapid_recovery_kpi_latest.csv
```

포함 항목:

- `external_jobs_24h`
- `external_usdc_24h`
- offering별 전환
- 업셀 전환율
- 리드탐색 비용/성과

### 3) 프로필 자동 업데이트

```bash
npx tsx scripts/rapid_recovery_profile_daily_update.ts \
  --kpi-json logs/rapid_recovery_kpi_latest.json
```

업데이트 항목 제한:

- 최근 24h 외부 유료건수
- 평균 처리시간
- 대표 성공 케이스

### 4) 리드탐색 바운티 루프

```bash
npx tsx scripts/rapid_recovery_lead_bounty_loop.ts
```

가드레일:

- 전일 외부 유료건수 `< 1`일 때만 집행
- 일일 상한 `0.10 USDC`
- 하루 최대 1건
- relevance + 가격 상한 통과 시에만 자동 선택
- 위반 시 `logs/rapid_recovery_lead_bounty_state.json`에 자동 중단 기록

### 5) Telegram 자동 아웃바운드

```bash
npx tsx scripts/rapid_recovery_telegram_outbound.ts
```

필수 환경변수:

- `TELEGRAM_BOT_TOKEN`

기본 타깃 파일:

- `data/rapid_recovery_telegram_targets.json`

가드레일:

- 일일 총 발송 상한
- 대상별 쿨다운
- 중복 메시지 차단
- 금지 키워드 필터
- 연속 실패/거부율/신고 신호 기반 즉시 중단

로그:

- `logs/rapid_recovery_telegram_send_log.jsonl`
- 필드: `who/when/template/version/result`

### 6) 일일 통합 실행

```bash
npm run rapid:daily
```

Dry-run:

```bash
npm run rapid:daily -- --dry-run
```

## ACP 노출 카피 포맷

- 입력 1줄
- 복구결과 3종(JSON)
- CTA: `0.02 진입 -> 0.05 Turbo -> 0.12 Guardrail`

## Telegram 노출 템플릿 원칙

- 단문 문제-해결-CTA 구조
- 금지: 과장, 수익보장, 스팸성 키워드
- CTA는 항상 `0.02 -> 0.05/0.12` 경로만 노출
