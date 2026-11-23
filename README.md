# Captura 360 guiada

Um app web de página única que guia você na captura, com o celular, de um conjunto de 38 fotos
girando no mesmo lugar: **5 níveis de inclinação** (+90°, +45°, 0°, -45°, -90°) com **1, 10, 16,
10, 1 fotos**, distribuídas por igual em cada nível. Pontos fixos na cena marcam onde vai cada
foto, e uma seta saindo do anel central aponta para a próxima: mire o anel central nela. No final, ele junta todas as fotos em um único `.zip`.

Todas as fotos saem em **retrato 3:4**.

## Deploy

https://rpfacco.github.io/guided-360-capture/

## Como rodar

A câmera e o giroscópio só funcionam em um **contexto seguro**, então a página precisa ser
servida por HTTPS (ou `localhost`). Abrir o `index.html` direto do sistema de arquivos não
funciona, e um endereço de rede local `http://192.168.x.x` também não.

```bash
python -m http.server 8000
```

Na mesma máquina, `http://localhost:8000` basta: `localhost` conta como seguro.
Para acessar pelo celular você precisa de um túnel HTTPS, por exemplo:

```bash
cloudflared tunnel --url http://localhost:8000
```

## Como a captura funciona

Um caminho, com o tamanho da prévia escolhido por plataforma:

| Plataforma | Prévia | Foto |
|---|---|---|
| Android / desktop | 1440 no lado menor (a costura reduz toda foto a 1440×1920) | captura do quadro da prévia num canvas |
| iOS | até 3024×4032 | captura do quadro da prévia num canvas |

O `takePhoto()` reconfigura a sessão de captura a cada foto: no iOS a prévia fica preta e
cada foto aloca um buffer do tamanho do sensor, o que derruba a aba depois de algumas fotos;
no Android a prévia congela por até um segundo. Por isso o app desenha o quadro da prévia
num canvas, o que significa que a prévia precisa ser grande: a foto *é* o quadro da prévia.

Com o stream ativo, o app congela a exposição e o balanço de branco (single-shot, ou a
temperatura de cor convergida no modo manual) para as 38 fotos terem o mesmo aspecto; um
AWB solto aparece como costura de cor depois da costura. Aparelhos que não expõem esses
controles (iOS) mantêm os dois automáticos.

A nitidez de cada foto também é medida. O app calcula a acutância (energia do gradiente
normalizada pela variância) num downscale de 240 px, direto do canvas da captura, e uma
foto claramente mole é descartada: aparece um aviso vermelho no topo, o botão de desfazer
pisca e a vaga continua aberta para tirar de novo. Os números ficam no `metadata.json`:
`sharpness` em cada foto e uma lista `rejected` com as tentativas descartadas (sem a
imagem). Depois de três rejeições na mesma vaga a foto é mantida e marcada com
`blurry: true`, para uma superfície que a métrica não consegue julgar nunca travar a
captura. `MIN_ACUTANCE` e `MIN_EDGE` em `js/sharpness.js` são os botões de ajuste.

O FOV vem do EXIF do `takePhoto`. O canvas não tem EXIF, então o app tira um único
`takePhoto` descartável na inicialização (em qualquer plataforma que exponha
`ImageCapture`) só para ler a lente (`fov.source` = `exif-probe`); sem isso, ou se o
aparelho remove o EXIF, usa a lente assumida de ~53° no lado menor (`fov.source` =
`assumed`). A sobreposição dos alvos projeta com a lente medida assim que ela é
conhecida; até lá usa a suposição. O `metadata.json` registra a origem de cada foto em
`fov.source` e a da captura inteira em `fovSource`.

## Exportação

O `.zip` contém `360_photos/level_NN_shot_NN.jpg` e um `metadata.json` com, para cada foto:
a inclinação/direção alvo, a rotação da câmera no disparo (yaw, pitch, roll e a matriz 3x3
bruta do dispositivo para o mundo), o FOV horizontal/vertical/diagonal, `sharpness` e
`blurry`, além de um `pano.pto` para o Hugin.

O `metadata.json` também leva um bloco `device` no nível da captura (user agent bruto,
plataforma, modelo quando o navegador expõe e o tamanho da tela), para separar amostras de
celulares diferentes depois.

## Projeto Hugin

O `pano.pto` é montado a partir do `metadata.json` para o Hugin começar da pose medida em
vez de tentar recuperá-la: cada imagem recebe seu próprio yaw/pitch/roll e campo de visão,
e todas as fotos que compartilham a mesma lente ficam ligadas num único grupo.

Descompacte o arquivo e abra o `pano.pto`. Ainda não há pontos de controle: rode o
**Align** do Assistant (ou `cpfind` + **Optimize**) e depois **Stitch**. Como as imagens
já estão no lugar certo, a busca de pontos começa do layout real, e `cpfind --prealigned`
compara apenas imagens com sobreposição.

A correspondência com as convenções do Hugin (conferida contra o código de transformação
do libpano13) é:

| Hugin | Do metadata |
|---|---|
| `y` yaw | direção medida; os dois crescem no sentido horário, então não há flip |
| `p` pitch | elevação medida do eixo óptico |
| `r` roll | roll medido negado, mais a orientação EXIF do JPEG (6 -> +90°) |
| `v` | FOV horizontal ao longo da largura armazenada |

O roll e o `v` precisam desse cuidado em capturas antigas salvas como stills de Android
em paisagem com orientação EXIF: o Hugin aplicaria a orientação ao abrir o JPEG, mas o
`r` explícito do pto vence, então o projeto já a incorpora. Nas capturas novas, feitas
pelo canvas, a imagem já é vertical e a orientação é 1. O yaw absoluto é arbitrário num
panorama (só os ângulos relativos importam), então as direções da bússola ficam como estão.

Para reconstruir o projeto a partir de um zip existente, ou escolher outro tamanho de saída:

```bash
node tools/zip-to-pto.mjs 360_photos.zip
node tools/zip-to-pto.mjs 360_photos.zip -o pano.pto --width 12000
```

Ele lê o `metadata.json` do arquivo, grava `<nome do zip>.pto` ao lado e extrai as fotos
(as existentes são mantidas). `--no-extract` grava só o projeto. Node 16+ é necessário
para a CLI; o site não tem etapa de build.

## Video probe (experimental)

`tools/video-probe.html` é um spike de captura em vídeo. Ele roda a mesma orientação por
alvos da captura normal, mas grava **um clipe por nível** com `MediaRecorder` (timeslice
de 1 s, que evita o travamento do MP4 no iOS) em vez de tirar fotos, registra amostras de
`deviceorientation` e marca o instante em que cada alvo foi mirado. Ele baixa
`video_probe.zip` com os clipes e `video/metadata.json`; um passo com ffmpeg no servidor
deveria então escolher um quadro nítido perto de cada marker.

Ele não tira fotos, pode usar o stream da prévia ou um track `getUserMedia` opcional de
1080p/4K (`?bitrate=` troca os 8 Mbps padrão), e não tem FOV medido para o vídeo, então a
costura ainda depende desse passo no servidor. Sirva-o da mesma origem HTTPS do app.

Para transformar uma pasta do probe em quadros costuráveis:

```bash
node tools/video-to-frames.mjs ~/Downloads/video_probe
```

Ele decodifica os 0,8 s de espera antes de cada marker, mantém o quadro mais nítido
(`frames/level_XX_shot_YY.jpg`) e grava `frames/metadata.json`, `frames/report.json` e
`frames/pano.pto`. O FOV do vídeo não pode ser medido, então o pto começa da lente
assumida de 53°: rode `cpfind` + `optimize` com `v` livre (ou o Align do Hugin).
`ffmpeg` e `ffprobe` precisam estar no `PATH`.

## Memória

Cada foto é salva no IndexedDB assim que é tirada, em vez de ficar na memória até a
exportação. O ZIP é gravado sem compressão, porque comprimir 38 JPEGs de uma só vez já
bastava para estourar o limite do Safari no celular. Se a exportação falhar, reduza
`LONG_EDGE` em `camera.js`.

## Arquivos

```
index.html         marcação
style.css          estilos, incluindo o quadro de prévia 3:4
js/app.js          inicialização e fluxo da captura
js/session.js      distribuição das fotos, progresso, referência de direção
js/orientation.js  giroscópio e cálculos de rotação
js/camera.js       stream da prévia e captura das fotos
js/fov.js          leitura da distância focal no EXIF e cálculo do campo de visão
js/device.js       descrição do aparelho gravada no metadata.json
js/sharpness.js    checagem de foco (acutância) que libera a captura
js/autoshot.js     disparo automático
js/hud.js          alinhamento e textos na tela
js/dome.js         domo de cobertura
js/targets.js      pontos fixos na cena, seta para o próximo
js/storage.js      IndexedDB
js/zip.js          exportação ZIP
js/pto.js          metadata.json -> projeto Hugin
js/library.js      login, biblioteca e upload
js/viewer.js       visualizador 360
js/api.js          cliente da API do backend
js/voice.js        instruções por voz
audio/             falas das instruções
tools/zip-to-pto.mjs  zip -> .pto (Node)
tools/video-to-frames.mjs  pasta video_probe -> quadros + .pto (Node)
tools/video-probe.html  gravador experimental de vídeo por nível
```
