# 가족방 (Family Chat) 설계 문서

> 위치: `family-hub/docs/family-chat-spec.md`
> 목적: 오늘저녁 · 하루노트 · 중학노트 세 웹앱을 잇는 **가족 전용 채팅 웹앱("가족 홈")** 설계와 단계별 로드맵
> 작업 규칙: Claude Code는 이 문서를 기준으로 작업하고, 단계가 끝날 때마다 "진행 현황"을 갱신한다.

---

## 1. 목표

- 우리 가족만 들어올 수 있는 채팅방을 만든다.
- 일반 채팅에 더해 **세 앱에서 생긴 일이 채팅방에 자동으로 카드 형태로 올라오게** 해서 가족 소통의 중심(가족 홈)으로 쓴다.
- 처음에는 우리 가족 전용으로 테스트하고, 나중에 지인 가족이 요청하면 확장할 수 있는 구조로 만든다.

## 2. 기술 스택

| 항목 | 선택 |
|---|---|
| 백엔드 / DB | Supabase (`FAMILY_HUB` 프로젝트) |
| 실시간 | Supabase Realtime (`messages` 테이블 INSERT 구독) |
| 로그인 | 세 앱과 같은 Supabase Auth 가족 계정을 재사용 (새로 가입하지 않음) |
| 파일 | Supabase Storage 비공개 버킷 `family-photos` (3단계) |
| 프론트엔드 | 기존 세 앱과 같은 방식의 웹앱 + PWA (홈 화면 추가) |
| 배포 | Vercel |
| 저장소 | `family-hub/apps/family-chat` (빌드 없는 HTML+JS, supabase-js는 CDN에서 불러옴) |

> 기존에 만들어 둔 가족 연동 테이블(가족, 구성원 등)이 있으면 **그 구조를 먼저 확인하고 재사용**한다. 아래 테이블 이름은 예시이고, 기존 이름과 겹치면 기존 쪽에 맞춘다.

> **1단계에서 확인한 실제 이름 (2026-11-20)** — `supabase/schema.sql` 기준
> | 이 문서 | 실제 서버 |
> |---|---|
> | `family_members` | `members` (`display_name` → `nickname`, `role`은 같음) |
> | `messages.id` uuid | `messages.id` 숫자(bigint, 늘어나는 번호) |
> | `messages.sender_id` | `messages.from_member` (members.id). 받는 사람 `to_member`(비우면 가족 모두) |
> | `messages.type` | `messages.kind` — 기존 `cheer`·`sticker`·`show`·`meal_request`에 **`text`(가족방 채팅) 추가** |
> | `messages.content` | `messages.body` (1~500자) |
> | `source_app`, `payload` | 아직 없음. 2단계(앱 연동 카드)에서 추가 |
>
> 아이 폰은 이메일이 없고 익명 로그인 + 6자리 연결 코드로 가족에 붙는다. 기존 구조는 아이 한 명당 연결된 로그인이 하나뿐이라
> 가족방을 연결하면 같은 폰의 오늘저녁이 끊겼다. 그래서 `member_logins` 표와 `link_extra_app(코드)` 함수를 추가해 **앱마다 따로 연결해도 서로 끊기지 않게** 했다.
> 코드는 부모가 오늘저녁의 "우리 가족" 화면에서 만든다.

## 3. 화면 구성

1. **로그인**: 기존 가족 계정으로 로그인
2. **가족방 (메인)**
   - 상단: 가족 이름, 고정 공지 1개
   - 가운데: 메시지 목록 (최신이 아래, 위로 스크롤하면 이전 메시지 불러오기)
   - 하단: 입력창 + 보내기 (3단계에서 사진 버튼 추가)
   - 메시지 종류별 카드 표시 (일반 말풍선 / 저녁 투표 카드 / 학습 완료 카드 등)
3. **바로가기 메뉴**: 오늘저녁 · 하루노트 · 중학노트로 이동하는 버튼
4. **설정**: 내 표시 이름, 알림 켜기(4단계), 초대 코드 보기(부모만)

세 앱에는 **"가족방" 버튼 + 안 읽은 메시지 개수 배지**만 추가한다.

## 4. 데이터 구조 (초안)

### `families` (기존 테이블이 있으면 재사용)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | 가족 ID |
| name | text | 가족 이름 |
| invite_code | text unique | 가족 초대 코드 |
| created_at | timestamptz | |

### `family_members` (기존 테이블이 있으면 재사용)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| family_id | uuid FK | |
| user_id | uuid FK → auth.users | |
| display_name | text | 채팅에 보일 이름 (예: 아빠, 엄마, 큰애) |
| role | text | `parent` / `child` |

### `messages`
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| family_id | uuid FK | |
| sender_id | uuid FK, null 허용 | 사람이 보내면 user_id, 앱 자동 메시지는 null |
| type | text | `text` / `dinner_vote` / `study_done` / `study_report` / `notice` / `photo` |
| source_app | text, null 허용 | `dinner` / `harunote` / `middle_note` / null |
| content | text | 본문 |
| payload | jsonb | 카드용 추가 데이터 (투표 후보, 점수 등) |
| created_at | timestamptz | |

### `message_reactions` (3단계)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| message_id | uuid FK | |
| user_id | uuid FK | |
| emoji | text | ❤️ 👍 🎉 등 |

### `message_reads` (3단계)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| family_id | uuid FK | |
| user_id | uuid FK | |
| last_read_at | timestamptz | 이 시각 이후 메시지 = 안 읽음 |

### `dinner_votes` (2단계)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| message_id | uuid FK | 투표 카드 메시지 |
| user_id | uuid FK | |
| choice | text | 선택한 메뉴 |

## 5. 보안 규칙 (가장 중요)

아이들이 쓰는 앱이므로 **외부인이 절대 읽거나 쓸 수 없어야 한다.**

- 모든 테이블에 RLS(행 단위 접근 제한)를 켠다.
- `messages` 등은 **로그인한 사용자가 `family_members`에 속한 `family_id`의 행만** 읽기/쓰기 가능하게 한다.
- 메시지를 보낼 때 `sender_id`는 반드시 본인(`auth.uid()`)이어야 한다.
- 앱 자동 메시지(`sender_id` null)도 같은 가족 구성원의 로그인 세션에서만 쓸 수 있게 한다.
- 공개 회원가입은 막고, **초대 코드로만** 가족에 들어온다. 초대 코드는 부모만 볼 수 있다.
- Storage 버킷은 비공개로 두고, 같은 가족만 접근할 수 있게 한다.
- Supabase `service_role` 키는 프론트엔드 코드에 절대 넣지 않는다.

**필수 검증 (각 단계 완료 조건):**
- [ ] 테스트용 "다른 가족" 계정을 만들어, 우리 가족 메시지가 **보이지 않는지** 확인
- [ ] 로그인하지 않은 상태에서 메시지를 읽을 수 없는지 확인
- [ ] 다른 사람 이름(sender_id)으로 메시지를 보낼 수 없는지 확인

## 6. 앱 연동 이벤트 규칙

세 앱은 아래 형식으로 `messages`에 한 줄을 써넣는다.

| 앱 | 언제 | type | 예시 content | payload 예시 |
|---|---|---|---|---|
| 오늘저녁 | 저녁 투표를 시작할 때 | `dinner_vote` | 오늘 저녁 뭐 먹을까? | `{"options":["김치찌개","카레","치킨"],"closes_at":"18:00"}` |
| 오늘저녁 | 메뉴가 정해졌을 때 | `notice` | 오늘 저녁은 카레! 🍛 | `{"menu":"카레"}` |
| 하루노트 | 아이가 오늘 문제를 다 풀었을 때 | `study_done` | ○○이 오늘 수학 10문제 완료! 🎉 | `{"subject":"수학","solved":10,"correct":9}` |
| 중학노트 | 주간 학습 요약 | `study_report` | 이번 주 학습 요약 | `{"days":5,"weak":["일차함수"]}` |

- 학습 요약 카드(`study_report`)는 **부모에게만** 보이게 할지 2단계에서 결정한다.
- 같은 이벤트가 중복으로 올라오지 않게 한다(예: 하루 1회).

## 7. 단계별 로드맵

### 1단계: 기본 채팅 (MVP)
- [x] 기존 가족 연동 테이블 확인 → 기존 `messages`에 `text` 종류 추가 + RLS 보강 (내용 수정 금지, 읽음 표시만 수정) + Realtime 켜기
- [x] 기존 가족 계정으로 로그인 (부모: 이메일 코드 / 아이: 연결 코드, `member_logins`로 오늘저녁 연결 유지)
- [x] 텍스트 메시지 보내기 / 실시간 받기 (Realtime)
- [x] 이전 메시지 불러오기 (최근 50개 + 위로 스크롤)
- [x] 보낸 사람 이름 · 시간 표시, 내 메시지는 오른쪽 정렬
- [x] 핸드폰 화면에 맞는 반응형 UI
- [ ] 부모가 SQL Editor에서 `schema.sql` 다시 실행
- [ ] Vercel 배포 → 가족 핸드폰에서 테스트
- [ ] 5장 보안 검증 통과 — 로컬 데이터베이스에서는 3개 모두 통과(2026-11-20). 실제 서버에서 한 번 더 확인

### 2단계: 앱 연동 카드
- [ ] 오늘저녁: 저녁 투표 카드 + 투표 집계 + 결과 공지
- [ ] 하루노트: 학습 완료 자동 메시지
- [ ] 중학노트: 주간 학습 요약 카드
- [ ] 세 앱에 "가족방" 버튼 추가

### 3단계: 생활 기능
- [ ] 사진 보내기 (Storage, 업로드 전 용량 줄이기)
- [ ] 이모지 반응 (❤️ 👍 🎉)
- [ ] 공지 고정
- [ ] 읽음 표시 + 세 앱의 안 읽은 메시지 배지

### 4단계: 알림
- [ ] PWA 설정 (manifest, service worker, 홈 화면 추가 안내)
- [ ] 웹 푸시 알림 (아이폰은 홈 화면에 추가한 경우에만 동작하므로 안내 문구 포함)
- [ ] 알림 켜기/끄기 설정

### 5단계 (선택): AI 가족 도우미
- [ ] "@도우미" 호출 시 저녁 메뉴 추천, 일정 정리 등
- [ ] API 비용 확인 후 진행 여부 결정

## 8. 나중에 확장할 때 (지인 가족)

- `family_id` 구조 그대로 새 가족을 추가하면 된다.
- 가족 만들기 → 초대 코드 발급 → 구성원 가입 흐름을 추가한다.
- 확장 전에 보안 검증(5장)을 다시 한다.

## 9. 진행 현황

| 날짜 | 단계 | 내용 |
|---|---|---|
| 2026-11-20 | 설계 | 설계 문서 작성 |
| 2026-11-20 | 1단계 | 서버 SQL(`text` 종류, `member_logins`, Realtime), `apps/family-chat` 화면. 로컬 보안 검증 통과. 실제 서버 실행·배포 대기 |
