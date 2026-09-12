# IyagiMusic.js

이야기 뮤직 사운드(`.ims`)와 애드립 ROL(`.rol`) 음악을 웹 브라우저에서
재생하기 위한 라이브러리와 포맷 문서입니다.

`.ims`는 1990년대 초 PC통신 접속기 **이야기**가 애드립 카드로 음악을
재생하기 위해 쓰던 파일 형식입니다. 애드립의 ROL 포맷을 고쳐 만든 것이고, 곡
제목과 가사는 2바이트 조합형 한글로 들어 있습니다.

## 상태

`.ims`와 `.rol`을 브라우저에서 재생합니다. 가사(`.iss`)도 박자에 맞춰 보여
줍니다.

| | 상태 |
|---|---|
| 포맷 명세 (`.ims` / `.bnk` / `.rol` / `.iss`) | 있음 |
| 재생 엔진 명세 | 있음 |
| 조합형 → 유니코드 변환기 (JS / Python) | 있음, 검증됨 |
| OPL2(YM3812) 에뮬레이터 | 있음, 자체 구현 |
| 재생 라이브러리 | 있음 (npm `iyagimusic`) |
| 프런트엔드 플레이어 | 있음 (`IyagiMusic-web`) |

## 문서

명세는 한국어와 영어 두 벌로 씁니다. 내용은 같습니다.

| 문서 | 내용 |
|---|---|
| [`docs/FILE_FORMATS.ko.md`](docs/FILE_FORMATS.ko.md) · [en](docs/FILE_FORMATS.en.md) | `.ims`, `.bnk`, `.rol`, `.iss`의 바이트 배치 |
| [`docs/ENGINE_SPEC.ko.md`](docs/ENGINE_SPEC.ko.md) · [en](docs/ENGINE_SPEC.en.md) | 이벤트를 OPL2 레지스터 쓰기로 바꾸는 방법 |
| [`docs/JOHAB_ENCODING.ko.md`](docs/JOHAB_ENCODING.ko.md) · [en](docs/JOHAB_ENCODING.en.md) | 2바이트 조합형 한글 인코딩 |
| [`docs/OPL2_NOTES.en.md`](docs/OPL2_NOTES.en.md) | 이 저장소의 OPL2 에뮬레이터에서 무엇이 정확하고 무엇이 근사인지 |

명세는 공개된 포맷 설명에서 출발해, `.ims` 1128개 · `.bnk` 450개 · `.iss`
680개 · `.rol` 2개로 이루어진 코퍼스를 직접 측정하여 고치고 보강한 것입니다.
*(측정)* 표시가 붙은 서술은 그 코퍼스의 모든 파일에서 확인했습니다. 알려진
자료와 실제 데이터가 어긋나는 곳은 본문에 그대로 적어 두었습니다.

## 설치

```
npm install iyagimusic
```

의존성은 없습니다. 순수한 ES 모듈이라 Node 20 이상과 브라우저에서 그대로
돌아가고, JSDoc에서 뽑아낸 타입스크립트 선언이 함께 들어 있습니다.

진입점은 이렇게 나뉩니다. 필요한 것만 가져다 쓰면 됩니다.

| 진입점 | 내용 |
|---|---|
| `iyagimusic` | `IyagiMusic`과 자주 쓰는 것들 |
| `iyagimusic/formats` | `.ims` · `.bnk` · `.rol` · `.iss` 판독기 |
| `iyagimusic/johab` | 조합형 → 유니코드 |
| `iyagimusic/opl` · `/opl/constants` · `/opl/tables` | OPL2 에뮬레이터 |
| `iyagimusic/driver` · `/sequencer` | 이벤트를 레지스터 쓰기로, 그리고 클럭 |
| `iyagimusic/worklet` | 워크릿용 한 파일 번들(클래식 스크립트) |
| `iyagimusic/worklet/url` | 그 번들의 URL과 `createIyagiNode` |

## 쓰는 법

```js
import { IyagiMusic } from "iyagimusic";

const music = new IyagiMusic({
  song: imsBytes,          // .ims 또는 .rol
  bank: bnkBytes,          // 곡 전용 음색 뱅크 (있으면)
  fallbackBank: stdBytes,  // 없을 때 쓸 범용 뱅크
  lyrics: issBytes,        // 가사 (선택)
  sampleRate: 48000,
});

music.title;               // "검은 고양이 네로"
music.missing;             // 뱅크에서 못 찾은 음색 이름들
music.render(float32Array); // 모노 샘플을 채웁니다
```

재생 중인 칩 상태는 성부 단위로 읽을 수 있습니다. 스펙트럼은 없습니다 —
OPL2가 내놓는 것은 모노 한 줄뿐이고, 대신 성부마다 무엇을 어떻게 울리고
있는지가 있습니다. `IyagiMusic-web`의 막대 표시가 이것을 씁니다.

```js
const meter = IyagiMusic.meterBuffer();
music.readMeters(meter);   // 성부마다 METER_STRIDE개: 피크, 변조기 감쇠(dB),
                           // 음 높이(MIDI), 키온, 포락선 단계, 음량, 음색 비트
music.voiceCount;          // 9, 리듬 모드면 11 (멜로디 6 + 드럼 5)
music.chipFlags;           // 리듬 모드 · 트레몰로 · 비브라토 · 파형 선택
music.patchNames;          // 성부마다 지금 걸려 있는 뱅크 음색 이름
```

읽을 때마다 피크 누산기가 비워지므로 한 화면에 한 번씩만 부르면 됩니다.

### 브라우저에서

워크릿은 ES 모듈을 못 불러오므로 한 파일로 이어 붙인 번들을 URL로 넘겨야
합니다. 그 번들이 `dist/`에 함께 들어 있고, `createIyagiNode`가 그것을
얹은 노드를 만들어 줍니다.

```js
import { createIyagiNode } from "iyagimusic/worklet/url";

const ctx = new AudioContext();
const node = await createIyagiNode(ctx);
node.connect(ctx.destination);

node.port.onmessage = (e) => { /* loaded · position · ended · error */ };
node.port.postMessage({ type: "load", song: imsBytes, bank: bnkBytes });
node.port.postMessage({ type: "play" });
```

번들 URL만 필요하면 `workletURL`을 쓰면 됩니다. 메인 스레드에서 직접 돌릴
때는 `iyagimusic`을 평범한 모듈로 가져다 쓰면 되고, 워크릿 번들은 필요
없습니다.

### 명령줄에서

```
npx iyagi-render song.ims bank.bnk out.wav 30   # WAV로 뽑기
```

## 조합형 변환기

```js
import { decodeJohab } from "iyagimusic/johab";

decodeJohab(bytes);                       // "검은 고양이 네로"
decodeJohab(bytes, { userGlyph: (c) => "♪" });   // 이야기 전용 글자 처리
```

```python
from johab2unicode import decode_johab
decode_johab(data)
```

두 구현은 CPython의 `johab` 코덱과 2바이트 코드 32 768개 전부를 맞춰 보고,
서로 간에도 맞춰 봅니다.

```
npm test
python3 test/test_johab.py
```

## 시험

`test/`는 네 가지를 봅니다. 조합형 변환기는 CPython의 `johab` 코덱을 기준으로
맞춰 보고, OPL2는 공식(주파수 · 감쇠 · 엔벨로프 배가 법칙)을 기준으로 재며,
플레이어는 참조 코퍼스의 실제 파일을 읽고 소리를 내고, 워크릿 번들은 가짜
`AudioWorkletGlobalScope` 안에서 실제로 돌려 봅니다. 코퍼스가 없으면 해당
시험은 건너뜁니다 — **건너뛴 시험은 통과한 시험과 똑같이 보이므로**, 초록불을
믿기 전에 `# SKIP` 수를 확인하십시오.

## 만드는 방법

라이브러리 자체에는 빌드 단계가 없습니다. 쓰여 있는 그대로의 ES 모듈이 그대로
실려 나가고, 외부 의존성도 없습니다. 만들어 내는 것은 두 가지뿐입니다.

```
npm run build          # dist/iyagi-processor.bundle.js -- 워크릿용 번들
npm run build:types    # types/**.d.ts -- JSDoc에서 뽑은 타입 선언
npm run build:pages    # IyagiMusic-web을 최신 소스로 갱신
```

앞의 둘은 `prepack`이 알아서 돌리므로 `npm pack`과 `npm publish`에서 신경 쓸
것이 없고, `dist/`와 `types/`는 저장소에 넣지 않습니다. 타입스크립트는 이
선언을 뽑는 데에만 쓰는 개발 의존성이며, 설치해 쓰는 쪽에는 따라가지
않습니다.

표 생성기는 둘입니다. `tools/gen_johab_table.py`가 조합형 기호·한자 표를,
`tools/gen_user_glyphs.py`가 이야기 전용 글자 표를 다시 만들어 냅니다.

## 라이선스

MIT.
