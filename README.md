# 🤖 리코셰 로봇 온라인 (클래식 에디션)

Robot Reboot(robotreboot.com) 스타일의 **리코셰 로봇** 멀티플레이 웹 게임입니다.
- 클래식 규칙: 16×16 보드, 로봇 4대, 목표 칩 17개(16색 + 소용돌이), **대각선(90도 꺾임) 장애물 없음**
- **방 하나당 최대 30명** 동시 접속 (환경변수 `MAX_PLAYERS`로 변경 가능)
- Node.js + Express + Socket.IO / GitHub + Render 무료 플랜으로 배포

## 게임 흐름
1. 닉네임과 방 코드를 입력해 입장합니다. 처음 들어온 사람이 👑 호스트가 됩니다.
2. 호스트가 [게임 시작] → 목표 칩이 공개됩니다. (로봇 1번 이동으로 풀리는 목표는 나오지 않습니다)
3. 각자 **자기 화면에서** 로봇을 움직여 풉니다. 목표에 도착하면 해답이 자동 제출되고 서버가 검증합니다.
4. 첫 해답이 나오면 카운트다운(기본 60초)이 시작되며, 그동안 더 짧은 해답으로 갱신할 수 있습니다. 최고 기록이 깨지면 채팅창에 즉시 알림이 뜹니다.
5. 종료 시 **가장 적은 수**(동점이면 먼저 제출한 사람)가 칩을 획득하고, 우승 해답이 모두의 화면에서 재생됩니다.
   로봇은 그 위치에 그대로 남아 다음 라운드로 이어집니다(원작 규칙). 컴퓨터가 계산한 최적해도 함께 공개됩니다.
6. 결과 화면은 자동으로 넘어가지 않으며, 호스트가 [다음 라운드 ▶]를 눌러 진행합니다.
7. 아무도 못 풀면 과반수 '건너뛰기 투표' 또는 호스트가 건너뛸 수 있습니다. 칩 17개가 끝나면 최종 순위 발표!

## 조작
| 동작 | PC | 모바일 |
|---|---|---|
| 로봇 선택 | 로봇 클릭 / 1~4 / R·G·B·Y / Tab | 로봇 터치 / 하단 버튼 |
| 이동 | 방향키·WASD / 화살표 표시 클릭 | 로봇을 잡고 스와이프 / 방향 버튼 |
| 되돌리기 / 처음으로 | Z(Backspace) / Esc | 버튼 |

## 로컬 실행
```bash
npm install
npm start
# http://localhost:3000 접속 (탭을 여러 개 열면 여러 명으로 테스트 가능)
```

## 배포 (GitHub → Render)
1. 이 폴더를 GitHub 저장소에 올립니다. (`node_modules`는 .gitignore로 제외됨)
   ```bash
   git init && git add . && git commit -m "ricochet robots"
   git branch -M main
   git remote add origin https://github.com/<아이디>/<저장소>.git
   git push -u origin main
   ```
2. https://render.com → **New + → Web Service** → GitHub 저장소 연결
3. 설정
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free
   - (선택) Health Check Path: `/healthz`
4. Deploy → 발급된 `https://<이름>.onrender.com` 주소를 공유하면 끝!
   - 같은 방에서 하려면 `https://<이름>.onrender.com/?room=반이름` 형태로 링크를 공유하세요.

> `render.yaml`이 포함되어 있어 **New + → Blueprint**로도 한 번에 배포할 수 있습니다.

## 환경변수 (선택)
| 이름 | 기본값 | 설명 |
|---|---|---|
| `MAX_PLAYERS` | 30 | 방 하나당 최대 동시 접속 인원 |
| `COUNTDOWN_SECONDS` | 60 | 첫 해답 후 카운트다운 기본값(호스트가 게임 중 변경 가능) |
| `SOLVER_TIME_MS` | 6000 | 최적해 계산 시간 제한 |

## 주의사항
- Render 무료 플랜은 **15분간 접속이 없으면 잠들고**, 첫 접속 시 깨어나는 데 30~60초 걸립니다. 수업/모임 시작 전에 미리 한 번 접속해 두세요.
- 게임 상태는 서버 메모리에 저장되므로 재배포·재시작 시 진행 중인 게임이 초기화됩니다.
- 인스턴스는 1개로 운영하세요(여러 개로 늘리면 방 상태가 공유되지 않습니다).

## 파일 구조
```
server.js          # 방/라운드/점수 관리, 해답 검증 (Socket.IO)
solverWorker.js    # 최적해 계산 워커 스레드
public/engine.js   # 보드 생성·로봇 이동·검증·솔버 (서버/브라우저 공용)
public/index.html  # 화면
public/client.js   # 클라이언트 로직
public/style.css   # 스타일
render.yaml        # Render 블루프린트
```
