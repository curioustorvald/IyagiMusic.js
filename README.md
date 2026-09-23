# IyagiMusic.js

이야기 뮤직 사운드(`.ims`), 노트(`.sop`), 애드립 ROL(`.rol`) 음악을 웹 브라우저에서
재생하기 위한 라이브러리와 포맷 문서입니다.

`.ims`는 1990년대 초 PC통신 접속기 **이야기**가 애드립 카드로 음악을
재생하기 위해 쓰던 파일 형식입니다. 애드립의 ROL 포맷을 고쳐 만든 것이고, 곡
제목과 가사는 2바이트 조합형 한글로 들어 있습니다.

`.sop`은 같은 시절 같은 게시판에서 돌던 Note라는 시퀀서의 형식으로, 이야기 것이 아니고 OPL2 것도 아닙니다.
성부 스무 개, 4연산자 음색, 좌우 정위를 쓰는 OPL3 포맷이라 OPL3로 재생합니다. 

## 상태

`.ims`, `.rol`, `.sop`을 브라우저에서 재생합니다. 가사(`.iss`)도 박자에 맞춰 보여
줍니다. 가사의 색칠은 이야기의 재생기 IMPLAY가 칠하던 규칙 그대로입니다.

| | 상태 |
|---|---|
| 포맷 명세 (`.ims` / `.bnk` / `.rol` / `.iss` / `.sop`) | 있음 |
| 재생 엔진 명세 | 있음 |
| 조합형 → 유니코드 변환기 (JS / Python) | 있음, 검증됨 |
| OPL2(YM3812) · OPL3(YMF262) 에뮬레이터 | 있음, 자체 구현 |
| 재생 라이브러리 | 있음 (npm `iyagimusic`) |
| 프런트엔드 플레이어 | 있음 (`IyagiMusic-web`) |

## 문서

명세는 한국어와 영어 두 벌로 씁니다. 내용은 같습니다.

| 문서 | 내용 |
|---|---|
| [`docs/FILE_FORMATS.ko.md`](docs/FILE_FORMATS.ko.md) · [en](docs/FILE_FORMATS.en.md) | `.ims`, `.bnk`, `.rol`, `.iss`의 바이트 배치 |
| [`docs/ENGINE_SPEC.ko.md`](docs/ENGINE_SPEC.ko.md) · [en](docs/ENGINE_SPEC.en.md) | 이벤트를 OPL2 레지스터 쓰기로 바꾸는 방법, 그리고 IMPLAY가 OPL3로 스테레오를 만든 방법 |
| [`docs/JOHAB_ENCODING.ko.md`](docs/JOHAB_ENCODING.ko.md) · [en](docs/JOHAB_ENCODING.en.md) | 2바이트 조합형 한글 인코딩 |
| [`docs/SOP_FORMAT.ko.md`](docs/SOP_FORMAT.ko.md) · [en](docs/SOP_FORMAT.en.md) | `.sop`의 바이트 배치. 이야기 것이 아닌 OPL3 시퀀서 포맷 |
| [`docs/OPL2_NOTES.en.md`](docs/OPL2_NOTES.en.md) | 이 저장소의 OPL 에뮬레이터에서 무엇이 정확하고 무엇이 근사인지 |
| [`docs/OPL3_NOTES.en.md`](docs/OPL3_NOTES.en.md) | 그중 OPL3가 더한 부분 — 둘째 뱅크, 4오퍼레이터, 스테레오, 파형 4–7 |

명세는 공개된 포맷 설명에서 출발해, `.ims` 1128개 · `.bnk` 450개 · `.iss`
680개 · `.rol` 2개로 이루어진 코퍼스를 직접 측정하여 고치고 보강한 것입니다.
*(측정)* 표시가 붙은 서술은 그 코퍼스의 모든 파일에서 확인했습니다. 코퍼스는
그 뒤 `.ims` 1725개 · `.bnk` 475개 · `.iss` 1031개 · `.sop` 347개로 늘었고,
늘어난 코퍼스에서 다시 잰 서술에는 *(측정, 1725)*처럼 그때의 파일 수를 함께
적었습니다.

이 중 `.ims`, `.iss`, `.sop`은 이 파일들을 실제로 만들고 재생하던 프로그램 —
재생기 IMPLAY.EXE 3.1과 시퀀서 NOTE.EXE — 를 디스어셈블하여 추가로
보강하였습니다. 그렇게 알아낸 서술에는 *(IMPLAY.EXE)*, *(NOTE.EXE)* 표시를
붙였습니다. 코퍼스를 잰 것이 아니라 그 프로그램이 어떻게 동작하는지를 읽어 낸
것입니다. 알려진 자료와 실제 데이터, 또는 원래 프로그램과 이 라이브러리가
어긋나는 곳은 본문에 그대로 적어 두었습니다.

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
| `iyagimusic/formats` | `.ims` · `.bnk` · `.rol` · `.iss` · `.sop` 판독기 |
| `iyagimusic/johab` | 조합형 → 유니코드 |
| `iyagimusic/opl` · `/opl/constants` · `/opl/tables` | OPL2 · OPL3 에뮬레이터 |
| `iyagimusic/driver` · `/sequencer` | 이벤트를 레지스터 쓰기로, 그리고 클럭 |
| `iyagimusic/worklet` | 워크릿용 한 파일 번들(클래식 스크립트) |
| `iyagimusic/worklet/url` | 그 번들의 URL과 `createIyagiNode` |

## 쓰는 법

```js
import { IyagiMusic } from "iyagimusic";

const music = new IyagiMusic({
  song: imsBytes,          // .ims, .rol 또는 .sop
  bank: bnkBytes,          // 곡 전용 음색 뱅크 (있으면; .sop은 필요 없음)
  fallbackBank: stdBytes,  // 없을 때 쓸 범용 뱅크
  lyrics: issBytes,        // 가사 (선택)
  sampleRate: 48000,
});

music.title;               // "검은 고양이 네로"
music.missing;             // 뱅크에서 못 찾은 음색 이름들
music.chipKind;            // "opl2" 또는 "opl3" -- 포맷이 정합니다
music.render(float32Array); // 모노 샘플을 채웁니다
music.renderStereo(l, r);   // OPL3면 진짜 스테레오, 아니면 같은 줄 두 벌
```

곡 형식이 칩을 정합니다. `.ims`와 `.rol`은 YM3812, `.sop`은 YMF262입니다.
`chip: "opl2"`를 넘기면 `.sop`도 아홉 성부로 줄여 재생할 수 있습니다
(SOP_FORMAT §8). 음량은 `volume`으로 조절하십시오. 칩이 감당하는 폭을 1로 놓은
비율이라, 성부가 스물인 곡과 아홉인 곡에 같은 값을 써도 됩니다.

IMPLAY처럼 듣고 싶다면 `implayStereo: true`를 넘기십시오. `.ims`와 `.rol`을
IMPLAY가 OPL3에서 하던 대로 스테레오로 울립니다 — 모든 멜로디 성부를 두 뱅크에
한 번씩, 채널마다 정해진 자리로 벌려서(ENGINE_SPEC §11.1). `mono`를 켜면 곡을 다시
읽지 않고도 YM3812 한 개의 소리와 샘플 단위로 같아집니다.

```js
const music = new IyagiMusic({ song, bank, implayStereo: true, tone: "standard" });

music.mono = true;         // 재생 중에 바로 바뀝니다
music.tone = "raw";        // "raw"는 칩 그대로(기본값), "standard"는 되먹임을
                           // 1/8 줄이고 12 kHz에 1극 저역 통과를 겁니다
music.speed = 0.9;         // 곡 템포의 배수. IMPLAY는 5%씩 움직입니다
music.transpose = -2;      // 반음 단위, 다음 음부터. 드럼은 옮기지 않습니다
music.duration;            // 곡 길이(초), 원래 빠르기 기준
music.position;            // 지금 위치(초), 같은 기준
music.seek(60);            // 처음부터 소리 없이 따라가서 60초 지점에 섭니다
music.instrumentCount;     // IMPLAY의 "사용 악기"
```

빠르기 · 키 · 위치 옮기기가 IMPLAY에서 어떻게 동작했는지, 그리고 이
라이브러리가 어디서 다른지는 ENGINE_SPEC §13에 있습니다.

재생 중인 칩 상태는 성부 단위로 읽을 수 있습니다. 스펙트럼은 없습니다 — 칩이
내놓는 것은 소리뿐이고, 대신 성부마다 무엇을 어떻게 울리고 있는지가 있습니다.
`IyagiMusic-web`의 막대 표시가 이것을 씁니다.

```js
const meter = IyagiMusic.meterBuffer();
music.readMeters(meter);   // 성부마다 METER_STRIDE개: 피크, 변조기 감쇠(dB),
                           // 음 높이(MIDI), 키온, 포락선 단계, 음량, 음색 비트,
                           // 좌우 정위
music.voiceCount;          // OPL2면 9 또는 11, OPL3면 18 또는 20
music.chipFlags;           // 리듬 모드 · 트레몰로 · 비브라토 · 파형 선택 ·
                           // OPL3 · 4오퍼레이터
music.patchNames;          // 성부마다 지금 걸려 있는 뱅크 음색 이름
```

읽을 때마다 피크 누산기가 비워지므로 한 화면에 한 번씩만 부르면 됩니다.

가사를 직접 그리려면 `iyagimusic/formats`의 `parseIss`와 `resolveIssSpans`를
쓰십시오. `resolveIssSpans`는 레코드마다 그 순간 켜져 있는 칸을
`{line, runs}`로 돌려줍니다. `runs`는 `[from, to)` 칸 범위의 목록이고, 범위 사이의
틈은 꺼진 칸입니다 — IMPLAY는 레코드가 덮지 않는 괄호나 점을 끝내 칠하지
않습니다(FILE_FORMATS §4.2). 예전의 `{line, from, to}` 한 구간은 더 이상
돌려주지 않습니다.

```js
import { parseIss, resolveIssSpans } from "iyagimusic/formats";

const iss = parseIss(issBytes);   // 옛 형식 헤더면 틱 단위도 알아서 맞춥니다
const spans = resolveIssSpans(iss);
// iss.cues[i].tick이 지나면 spans[i]를 그립니다
```

성부 수는 칩과 모드가 정하지만 규칙은 하나입니다. **리듬 성부는 언제나 맨 뒤
다섯 개**입니다 — 열하나 중 6–10이든 스물 중 15–19든 마찬가지라, 표시하는 쪽은
어느 칩인지 몰라도 됩니다.

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
npx iyagi-render song.sop "" out.wav 30         # .sop은 뱅크 없이, 스테레오로
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
맞춰 보고, OPL은 공식(주파수 · 감쇠 · 엔벨로프 배가 법칙)과 칩이 문서로 밝힌
규칙을 기준으로 재며, 플레이어는 참조 코퍼스의 실제 파일을 읽고 소리를 내고,
워크릿 번들은 가짜 `AudioWorkletGlobalScope` 안에서 실제로 돌려 봅니다.
OPL3가 0x105를 쓰기 전까지 OPL2와 샘플 단위로 같아야 한다는 것도 그중
하나입니다 — 코어가 하나뿐이라, 서지 말아야 할 분기가 섰다면 거기서 드러납니다. 코퍼스가 없으면 해당
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
