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

## Exportação

O `.zip` contém `360_photos/level_NN_shot_NN.jpg` e um `metadata.json` com, para cada foto:
a inclinação/direção alvo, a rotação da câmera no disparo (yaw, pitch, roll e a matriz 3x3
bruta do dispositivo para o mundo) e o FOV horizontal/vertical/diagonal.

O FOV vem do `FocalLengthIn35mmFilm` do EXIF. O canvas não tem EXIF, então o app tira um
único `takePhoto` descartável na inicialização só para ler a lente (`fov.source` =
`exif-probe`; no iOS, a partir do Safari 18.4); um navegador sem `takePhoto`, ou um
aparelho que remove o EXIF, usa a lente assumida de ~53 graus na horizontal (a mesma
constante que a sobreposição dos alvos usa, `fov.source` = `assumed`). O `metadata.json`
registra a origem de cada foto em `fov.source` e a da captura inteira em `fovSource`.

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
js/autoshot.js     disparo automático
js/hud.js          alinhamento e textos na tela
js/dome.js         domo de cobertura
js/targets.js      pontos fixos na cena, seta para o próximo
js/storage.js      IndexedDB
js/zip.js          exportação ZIP
```
