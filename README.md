# iyagimusic-js

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
| 재생 라이브러리 | 있음 |
| 프런트엔드 플레이어 | 있음 (`../github-pages/`) |

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

## 쓰는 법

```js
import { IyagiMusic } from "./src/player.js";

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

브라우저에서는 `github-pages/`의 플레이어가 이것을 AudioWorklet 안에서
돌립니다. 워크릿은 ES 모듈을 못 불러오므로 한 파일로 이어 붙인 번들이
필요한데, `tools/build-pages.mjs`가 그것과 `lib/` 복사본을 함께 만듭니다.

```
node tools/build-pages.mjs        # github-pages/ 를 최신 소스로 갱신
node tools/render.mjs song.ims bank.bnk out.wav 30   # WAV로 뽑기
```

## 조합형 변환기

```js
import { decodeJohab } from "./src/johab2unicode.js";

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
node --test 'test/*.test.js'
python3 test/test_johab.py
```

## 시험

`test/`는 세 가지를 봅니다. 조합형 변환기는 CPython의 `johab` 코덱을 기준으로
맞춰 보고, OPL2는 공식(주파수 · 감쇠 · 엔벨로프 배가 법칙)을 기준으로 재며,
플레이어는 참조 코퍼스의 실제 파일을 읽고 소리를 냅니다. 코퍼스가 없으면
해당 시험은 건너뜁니다.

## 만드는 방법

빌드 단계가 없습니다. 순수한 ES 모듈이고 외부 의존성도 없습니다.
`tools/gen_johab_table.py`만이 생성기이며, 조합형 기호·한자 표를 다시
만들어 냅니다.

## 라이선스

MIT.
