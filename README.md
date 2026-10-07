# Hosting Panel

Render 무료 서버 하나를 기반으로 여러 프로젝트를 관리하고 실행하기 위한 기본 프로젝트입니다.

> 현재 버전은 공개 GitHub 저장소를 프로젝트 소스로 사용하는 관리 패널입니다. 프로젝트 소스와 설정은 Render 로컬 디스크에 저장되며, R2/S3와 DB는 아직 연결되지 않았습니다.

---

## 1. 이 프로젝트가 하는 일

이 프로젝트의 최종 목표는 다음과 같습니다.

```text
사용자
  │
  ▼
Hosting Panel
  │
  ├── 프로젝트 관리
  ├── 파일 관리
  ├── 실행 / 중지 / 재시작
  ├── CPU / RAM 모니터링
  └── 로그 확인
          │
          ▼
      Render 서버
          │
          ├── Project A
          ├── Project B
          └── Project C
```

즉, 하나의 Render 서버에서 여러 프로그램을 관리할 수 있는 작은 호스팅 패널을 만드는 것입니다.

---

## 2. 현재 구현된 기능

현재 기본 버전에는 다음 기능이 들어 있습니다.

### 프로젝트 관리

- 프로젝트 생성
- 프로젝트 목록 조회
- 프로젝트별 Build Command 저장
- 프로젝트별 Start Command 저장
- 프로젝트 실행
- 프로젝트 중지
- 프로젝트 상태 확인
- 공개 GitHub 저장소에서 프로젝트 소스 가져오기
- 파일 트리 조회 및 파일 다운로드·삭제 (파일 추가는 GitHub 연결로만 가능)
- GitHub 커밋 선택 배포 (파일 교체 → 빌드 → 실행)
- 프로젝트별 로그 보기
- 확인 모달을 통한 프로젝트 삭제
- 프로젝트 이름 중복 방지
- 프로젝트 정보 상세 보기
- 프로젝트별 환경변수 관리 (`.env`)

### 서버 모니터링

관리 페이지에서 기본적인 서버 상태를 확인할 수 있습니다.

- 프로세스 CPU 사용량
- 서버 전체 메모리 사용량
- 전체 메모리
- 사용 중인 메모리
- 프로젝트 개수

화면은 주기적으로 API를 호출하여 데이터를 갱신합니다.

---

## 3. 프로젝트 구조

```text
hosting-panel/
│
├─ package.json
├─ .env.example
├─ .gitignore
│
├─ src/
│  ├─ server.js
│  │
│  ├─ config/
│  │  └─ env.js
│  │
│  ├─ routes/
│  │  ├─ projects.js
│  │  ├─ files.js
│  │  ├─ github.js
│  │  ├─ environment.js
│  │  ├─ logs.js
│  │  └─ system.js
│  │
│  ├─ services/
│  │  ├─ fileManager.js
│  │  ├─ discordSync.js
│  │  ├─ githubImporter.js
│  │  ├─ deploymentManager.js
│  │  ├─ projectEnvironment.js
│  │  ├─ projectLogs.js
│  │  ├─ projectManager.js
│  │  └─ resourceMonitor.js
│  │
│  └─ utils/
│     ├─ processManager.js
│     └─ projectOperationLock.js
│
├─ public/
│  ├─ index.html
│  ├─ css/
│  │  └─ style.css
│  └─ js/
│     └─ app.js
│
└─ storage/
   ├─ projects/
   └─ logs/
```

---

## 4. 각 파일의 역할

### `src/server.js`

프로그램의 시작점입니다.

Express 서버를 실행하고 다음 기능을 연결합니다.

- 웹 페이지
- 프로젝트 API
- 시스템 상태 API
- 저장소 초기화
- 리소스 모니터

---

### `src/routes/projects.js`

프로젝트 관련 API입니다.

현재 제공하는 API:

```text
GET  /api/projects
POST /api/projects

GET  /api/projects/:id
DELETE /api/projects/:id

POST /api/projects/:id/start
POST /api/projects/:id/stop
GET  /api/projects/:id/logs
```

### `src/routes/files.js`

프로젝트 파일 목록, 다운로드, 삭제 API입니다. 파일 추가와 폴더 생성은 GitHub 저장소를 통해서만 가능합니다.

```text
GET    /api/projects/:id/files
GET    /api/projects/:id/files/download?path=...
DELETE /api/projects/:id/files?path=...
```

PUT 파일 업로드와 POST 폴더 생성 요청은 `405`로 거부합니다.

### `src/routes/github.js`

공개 GitHub 저장소를 현재 프로젝트로 가져오는 API입니다.

```text
POST /api/projects/:id/github/import
GET  /api/projects/:id/github/commits
POST /api/projects/:id/github/deploy
```

저장소 연결은 `{ "repositoryUrl": "https://github.com/owner/repository" }` 형식입니다. 최근 커밋 목록은 기본 브랜치에서 최대 30개를 가져옵니다. 선택한 커밋을 프로젝트 파일에 적용한 뒤 Build Command를 실행하고, 성공하면 Start Command로 시작합니다. 저장소당 최대 1,000개 파일, 총 100MB까지 지원합니다.

### `src/routes/logs.js`

`GET /api/projects/:id/logs?lines=1000`은 해당 프로젝트의 최근 빌드·실행 로그를 반환합니다. 로그 파일은 `storage/logs/`에 보관하며 2MB로 제한합니다.

---

### `src/routes/environment.js`

프로젝트 카드의 **환경변수** 버튼에서 루트 `.env`를 관리합니다. 변수 이름은 영문자 또는 밑줄로 시작하는 영문자·숫자·밑줄 조합이어야 하며, 최대 100개·64KB까지 저장할 수 있습니다.

```text
GET /api/projects/:id/environment
PUT /api/projects/:id/environment
```

프로젝트명·빌드 커맨드·실행 커맨드·환경변수는 프로젝트 폴더의 `project.json`에 JSON으로 저장됩니다. 환경변수는 호환을 위해 같은 폴더에 `.env` 파일로도 기록되어 새 프로세스에 전달됩니다. 이미 실행 중인 프로세스에는 적용되지 않으므로 중지 후 다시 실행하세요. 루트 `.env`는 파일 트리·다운로드·일반 업로드·GitHub 가져오기에서 제외됩니다.

### Discord 설정 동기화

패널 루트의 `.env`에 아래 항목을 설정하세요. `.env.example`을 참고하면 됩니다.

```env
DISCORD_BOT_TOKEN=봇_토큰
DISCORD_CHANNEL_ID=대상_채널_ID
```

봇은 대상 채널에서 메시지 보내기, 채널 보기, 메시지 기록 보기 권한이 필요합니다. Discord Developer Portal에서 Message Content Intent도 켜야 시작 시 스냅샷 메시지와 첨부 파일을 찾을 수 있습니다.

프로젝트를 만들거나 설정·저장소·배포·삭제에 변경이 생길 때 전체 프로젝트 설정 JSON을 파일 첨부로 봇이 채널에 게시합니다. 여기에는 `.env` 전체 값도 평문으로 포함됩니다. 서버 시작 시 해당 봇이 작성한 최신 패널 스냅샷을 찾아 로컬 프로젝트 설정과 각 프로젝트의 `.env`에 반영합니다. 파일·코드 디렉터리는 유지합니다. Discord 연결에 실패해도 서버는 로컬 설정으로 시작하며 실패 내용은 서버 로그에 기록됩니다.

### `src/routes/system.js`

서버 리소스 정보를 제공하는 API입니다.

```text
GET /api/system/resources
```

---

### `src/services/projectManager.js`

프로젝트 메타데이터를 관리하고 프로세스 관리자와 연결하는 서비스입니다.

현재 담당하는 기능:

- 프로젝트 생성
- 프로젝트 조회
- 프로젝트 목록
- 프로젝트 실행
- 프로젝트 중지
- 프로젝트 상태 저장

### `src/services/fileManager.js`

프로젝트 디렉터리 안에서 파일 목록, 다운로드 대상 확인, 파일 삭제를 처리합니다. 경로 이동과 심볼릭 링크 접근을 거부하며 내부 `project.json`과 `.env`는 목록에서 숨기고 변경을 차단합니다.

### `src/services/githubImporter.js`

GitHub API로 공개 저장소의 커밋 기록과 트리를 읽습니다. 선택 커밋의 파일은 임시 위치에서 검증한 뒤 프로젝트 소스와 교체합니다. GitHub API 비인증 요청 한도에 도달하면 잠시 후 다시 시도해야 합니다.

### `src/utils/processManager.js`

현재 실행 중인 자식 프로세스를 메모리에서 추적하고 시작·중지합니다. 서버가 재시작되면 이 추적 정보는 복구되지 않습니다.

프로젝트 설정은 프로젝트별 `project.json`에 다음과 같은 형태로 저장됩니다.

```json
{
  "id": "project-id",
  "name": "My Project",
  "buildCommand": "npm install",
  "startCommand": "node index.js",
  "status": "stopped",
  "createdAt": "2026-10-07T00:00:00.000Z"
}
```

---

### `src/services/resourceMonitor.js`

서버의 리소스를 확인합니다.

현재 확인하는 값:

```text
CPU
Memory
Uptime
```

향후 여기에서 프로젝트별 리소스 사용량까지 관리할 예정입니다.

현재 CPU 수치는 관리 패널 프로세스의 사용량이며, 프로젝트 프로세스 전체의 합계나 프로젝트별 수치가 아닙니다.

---

### `public/index.html`

관리자 웹페이지의 기본 HTML입니다.

---

### `public/js/app.js`

관리 페이지의 JavaScript입니다.

API를 호출하여:

- 프로젝트 목록
- CPU
- RAM
- 프로젝트 상태

등을 화면에 표시합니다.

---

### `public/css/style.css`

관리 페이지의 기본 디자인입니다.

---

## 5. 실행 방법

Node.js가 설치되어 있어야 합니다.

프로젝트 폴더에서:

```bash
npm install
```

설치가 끝나면:

```bash
npm start
```

개발 중에는:

```bash
npm run dev
```

를 사용할 수 있습니다.

서버가 실행되면:

```text
http://localhost:3000
```

으로 접속합니다.

---

## 6. 프로젝트 생성

관리 페이지에서 프로젝트를 생성할 수 있습니다.

예:

```text
프로젝트 이름
my-discord-bot

Build Command
npm install

Start Command
node index.js
```

생성하면 프로젝트가 다음과 같은 형태로 만들어집니다.

```text
storage/
└─ projects/
   └─ 프로젝트ID/
      ├─ project.json
      ├─ .env
      └─ GitHub에서 가져온 소스 파일
```

프로젝트 카드의 화살표를 누르면 GitHub 저장소, 배포 커밋, 빌드·실행 커맨드와 `.env` 버튼이 펼쳐집니다. **소스 파일**에서 공개 GitHub 저장소를 연결하고, **배포하기**에서 커밋을 선택하면 파일 교체 후 빌드와 실행을 진행합니다. **로그 보기**는 빌드와 실행 출력을 갱신해 보여줍니다. **삭제**는 확인 모달에서 한 번 더 확인한 뒤 프로젝트 설정과 파일을 삭제합니다.

---

## 7. 프로젝트 실행 방식

프로젝트의 Start Command를 Node.js의 child process로 실행합니다. **배포하기**에서 커밋을 선택하면 소스 파일을 해당 커밋으로 교체하고, Build Command가 있으면 실행합니다. 빌드 성공 후 Start Command를 실행합니다. 빌드가 실패하면 새 소스는 유지되고 프로젝트 상태는 `build_failed`가 됩니다. 배포 로그에서 원인을 확인한 뒤 다시 배포할 수 있습니다.

예:

```text
Start Command
node index.js
```

실행 버튼을 누르면 내부적으로 프로젝트 프로세스를 실행합니다.

```text
Hosting Panel
      │
      └── child process
              │
              └── node index.js
```

프로젝트마다 별도의 프로세스로 실행하는 구조입니다.

프로젝트 파일은 Render 로컬 디스크에 저장하므로 인스턴스 재생성이나 디스크 초기화 시 사라질 수 있습니다. 서버 재시작 뒤에는 자식 프로세스와의 추적 연결이 복구되지 않아 저장된 상태가 실제 실행 상태와 다를 수 있습니다.

---

## 8. 앞으로 만들 구조

최종적으로는 다음 구조를 목표로 합니다.

```text
                    Hosting Panel
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
       DB              R2/S3          Resource
   프로젝트 정보      프로젝트 파일       Monitor
        │                │                │
        └────────────────┼────────────────┘
                         │
                         ▼
                    Render 서버
                         │
             ┌───────────┼───────────┐
             ▼           ▼           ▼
         Project A   Project B   Project C
```

---

## 9. 다음에 추가할 기능

### 다음 단계 — 외부 파일 저장소

---

Render 서버의 디스크에 프로젝트 파일을 영구적으로 저장하지 않고 외부 저장소를 사용합니다.

예:

```text
R2
└─ projects/
   ├─ project-a/
   ├─ project-b/
   └─ project-c/
```

Render가 프로젝트를 실행할 때 필요한 파일을 가져옵니다.

---

### 3단계 — 데이터베이스

프로젝트 정보를 DB에 저장합니다.

예:

```text
projects
├─ id
├─ name
├─ build_command
├─ start_command
├─ status
├─ storage_path
├─ created_at
└─ updated_at
```

Render가 재시작되어도 프로젝트 설정을 잃지 않게 만드는 것이 목적입니다.

---

### 4단계 — 실시간 리소스 모니터링

현재 기본 모니터링에서 발전시켜:

```text
전체 CPU
전체 RAM

Project A
├─ CPU
└─ RAM

Project B
├─ CPU
└─ RAM

Project C
├─ CPU
└─ RAM
```

형태로 표시합니다.

---

### 5단계 — 자원 제한

프로젝트별로 제한을 설정할 수 있도록 합니다.

예:

```text
Project A
RAM 제한: 150MB

Project B
RAM 제한: 100MB
```

프로젝트가 제한을 지속적으로 초과하면 자동으로 종료합니다.

---

### 6단계 — 서버 보호

전체 서버가 위험한 상태가 되면 새로운 프로젝트 실행을 막습니다.

예:

```text
RAM 80%
→ 정상

RAM 90%
→ 경고

RAM 95%
→ 새 프로젝트 실행 차단

RAM 98%
→ 보호 로직 실행
```

단, 실제 기준값은 사용하는 Render 서비스의 실제 자원 한도와 측정 방식에 맞춰 정해야 합니다.

---

### 7단계 — 로그 확장

현재 프로젝트별 빌드·실행 로그를 저장하고 로그 보기 버튼에서 확인할 수 있습니다. 이후에는 로그 보존 기간이나 다운로드 같은 기능을 확장할 수 있습니다.

```text
Project A

[12:01:02] Starting...
[12:01:03] npm install
[12:01:08] Starting application
[12:01:09] Bot logged in
```

웹페이지에서 최근 로그를 주기적으로 갱신해 보여줍니다.

---

### 8단계 — 자동 재시작

프로그램이 비정상적으로 종료되었을 때:

```text
Project A
    ↓
프로세스 종료
    ↓
종료 원인 확인
    ↓
자동 재시작
```

하도록 만들 수 있습니다.

---

## 10. 중요한 보안 사항

현재 프로젝트의 `startCommand` 실행 방식은 **기본 개발용 구현**입니다. 관리 API에는 인증이 없고 서버가 shell 명령을 직접 실행하므로, 신뢰할 수 있는 사용자만 접근하는 로컬 또는 사설 환경에서 사용하세요. 인터넷에 공개하면 안 됩니다.

최종적으로 공개 호스팅 서비스로 만들려면 프로젝트 실행을 별도의 격리 환경에서 실행하는 구조를 고려해야 합니다.

예:

```text
Hosting Panel
      │
      ▼
Execution Manager
      │
      ├── Sandbox / Container
      │      └── Project A
      │
      ├── Sandbox / Container
      │      └── Project B
      │
      └── Sandbox / Container
             └── Project C
```

개인적으로 신뢰할 수 있는 프로젝트만 실행하는 초기 단계에서는 현재 구조로 기능을 먼저 개발할 수 있습니다.

---

## 11. 현재 개발 단계

현재는 **GitHub 커밋 배포, 프로젝트 로그, 프로젝트 설정 Discord 동기화 단계**입니다.

```text
[완료]
프로젝트 생성
프로젝트 목록
GitHub 저장소 연결과 커밋 선택 배포
파일 트리, 다운로드
프로젝트별 빌드·실행 로그
프로젝트 삭제 확인 모달
공개 GitHub 저장소 가져오기
프로젝트 이름 중복 방지와 상세 정보 모달
프로젝트별 `.env` 관리
프로젝트 설정 JSON 저장 및 Discord 봇 스냅샷 동기화
프로젝트 실행
프로젝트 중지
기본 CPU/RAM 표시
기본 관리자 UI

[다음]
R2 연결
DB 연결
Build Command 실행
프로젝트별 리소스
실시간 로그
자동 종료
자동 재시작
```

한 번에 모든 기능을 넣기보다는 위 순서대로 하나씩 구현하는 것을 권장합니다.
