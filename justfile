# kdb 운영 레시피
#
# 주의: 이 시스템은 임시 디렉터리가 noexec 으로 마운트돼 있어 just 의 shebang 레시피
# (`#!/usr/bin/env bash`) 가 Permission denied 로 실패한다. 여러 명령을 한 셸에서
# 실행해야 하면 세미콜론으로 한 줄에 이어 붙여야 한다.

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

# pm2 목록에서 완전히 제거한다.
delete:
  pm2 delete {{APP}}
  pm2 save

status:
  pm2 status {{APP}}

# 로그 따라가기. Ctrl-C 로 빠져나온다. 예) just logs 500
logs lines="100":
  pm2 logs {{APP}} --lines {{lines}}

# 누적된 로그 파일 비우기
flush:
  pm2 flush {{APP}}

# 포그라운드 실행. pm2 인스턴스가 떠 있으면 포트가 겹치니 먼저 just stop 할 것.
dev:
  pnpm dev

# 서버 헬스체크
health:
  @port=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' | tail -1); curl -fsS "http://localhost:${port:-3000}/health" && echo

# 인덱스 정보. 생략하면 .env 의 DEFAULT_INDEX 를 본다. 예) just info other_idx
info index="":
  @port=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' | tail -1); curl -fsS "http://localhost:${port:-3000}/api/index/info?index={{index}}" | python3 -m json.tool

# 검색. 인덱스를 생략하면 .env 의 DEFAULT_INDEX 를 본다. 예) just search "검색어" my_docs 20
search q index="" limit="10":
  @port=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' | tail -1); python3 -c 'import json,sys; b={"q":sys.argv[1],"limit":int(sys.argv[3])}; b.update({"index":sys.argv[2]} if sys.argv[2] else {}); print(json.dumps(b))' {{quote(q)}} {{quote(index)}} {{quote(limit)}} | curl -fsS -X POST "http://localhost:${port:-3000}/api/search" -H 'Content-Type: application/json' -d @- | python3 -m json.tool

# 문서 전체 삭제. 실수 방지를 위해 인덱스명을 직접 넘겨야 한다. 예) just reset my_docs
reset index:
  @port=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' | tail -1); curl -fsS -X POST "http://localhost:${port:-3000}/api/index/reset" -H 'Content-Type: application/json' -d '{"index":"{{index}}","confirm":"{{index}}"}' | python3 -m json.tool

# 인덱스 자체를 삭제한다. 설정까지 사라지고 다음 업로드 때 재생성된다. 예) just drop my_docs
drop index:
  @port=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' | tail -1); curl -fsS -X POST "http://localhost:${port:-3000}/api/index/reset" -H 'Content-Type: application/json' -d '{"index":"{{index}}","confirm":"{{index}}","mode":"drop"}' | python3 -m json.tool
