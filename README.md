# family-hub (우리집 허브)

하루노트 · 오늘저녁뭐먹지 · 눈을뜨자, 세 가족 앱을 하나로 잇는 **공용 설계 저장소**입니다.
앱 화면 코드는 각 앱 저장소에 있고, 여기에는 같이 쓰는 것만 둡니다.

| 파일 | 내용 |
| --- | --- |
| [docs/FAMILY_HUB.md](docs/FAMILY_HUB.md) | 가족 연결 계획: 방향, 설계 원칙, 단계별 할 일 |
| [supabase/schema.sql](supabase/schema.sql) | 공용 서버(Supabase)의 표와 보안 규칙. SQL Editor에서 실행 |
| [docs/family-chat-spec.md](docs/family-chat-spec.md) | 가족방(가족 전용 채팅) 설계와 단계 |
| [apps/family-chat/](apps/family-chat/) | 가족방 웹앱 (빌드 없음, Vercel 배포). 공개 설정값은 `config.js` |

| 앱 | 저장소 | 연결 순서 |
| --- | --- | --- |
| 오늘저녁뭐먹지 | `fridge-to-family-feast` | 1단계 |
| 하루노트 (초등) | `harunote` | 2단계 |
| 눈을뜨자 (중등) | `MS-today-note` [확인 필요] | 3단계 |
