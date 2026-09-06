APP := "kdb"

# restart 는 start 와 동작이 같다. ecosystem 파일을 다시 읽으므로 설정 변경도 반영된다.
alias restart := start

list:
  just -l

# pm2 로 백그라운드 기동. 이미 떠 있으면 재시작한다.
start:
  pm2 startOrRestart ecosystem.config.cjs --update-env
  pm2 save
  pm2 status {{APP}}

# 중지. 프로세스 정의는 목록에 남아 있어 start 로 다시 올릴 수 있다.
stop:
  pm2 stop {{APP}}

# pm2 목록에서 완전히 제거. 재부팅 후 자동 복구도 안 되도록 저장까지 갱신한다.
delete:
  pm2 delete {{APP}}
  pm2 save

status:
  pm2 status {{APP}}

# 로그 따라가기. Ctrl-C 로 빠져나온다.
logs lines="100":
  pm2 logs {{APP}} --lines {{lines}}

# 누적된 로그 파일 비우기
flush:
  pm2 flush {{APP}}

# 포그라운드 실행. pm2 인스턴스가 떠 있으면 포트가 겹치니 먼저 just stop 할 것.
dev:
  node server.js

# .env 의 PORT 를 읽어 헬스체크.
# 한 줄로 둔 이유: just 는 줄마다 새 셸을 띄우고, 이 시스템은 임시 디렉터리가
# noexec 이라 shebang 레시피를 쓸 수 없다.
health:
  @port=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' | tail -1); curl -fsS "http://localhost:${port:-3000}/health" && echo
