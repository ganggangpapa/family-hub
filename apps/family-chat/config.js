// 가족방 공개 설정값 (공개돼도 괜찮은 값만. RLS 규칙이 데이터를 지킵니다)
// Secret(service_role) 키와 데이터베이스 비밀번호는 절대 여기에 넣지 않습니다.
window.FAMILY_CHAT_CONFIG = {
  supabaseUrl: 'https://ckagqcbnzrgiiqufixqe.supabase.co',
  supabaseKey: 'sb_publishable_eDXZcsccvUyZ2vjbS_bQTA_QyASaSyH',   // Publishable 키 (공개용)
  // 가족 홈 메뉴가 여는 앱 주소. 비워 두면 "준비 중"으로 보입니다.
  apps: {
    dinner: '',             // 오늘저녁뭐먹지
    harunote: '',           // 하루노트 (초등학습)
    nuneul: '',             // 눈을뜨자 (중등학습)
  },
};
