# Pi Dictation

[English](./README.md)

[![CI](https://github.com/yasuhito/pi-dictation/actions/workflows/ci.yml/badge.svg)](https://github.com/yasuhito/pi-dictation/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-dictation.svg)](https://www.npmjs.com/package/pi-dictation)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[Pi](https://github.com/badlogic/pi-mono) のためのプッシュ・ツー・トーク音声入力です。ショートカットを押して話し、もう一度押すと、文字起こしがPiのエディターに貼り付けられます。

![Pi Dictationのデモ](https://raw.githubusercontent.com/yasuhito/pi-dictation/main/assets/pi-dictation-demo.gif)

OpenAIまたは任意のローカル文字起こしコマンドを利用できます。SSH経由でリモートホスト上のPiを使う場合も、オプションのBridgeを使えば、手元のMacのマイクで録音し、音声を安全にPiへ送って文字起こしできます。

Pi Dictationは、録音時間を制限し、不要になったバックグラウンド処理を終了し、一時的な音声を非公開のまま自動で削除します。録音を止め忘れた場合やコマンドが失敗した場合も、処理やファイルが残ってリソースを消費したり、音声がほかの人に見えたりしないよう保護します。

## 必要条件

- `/bin/sh` とPOSIXプロセスグループに対応したLinuxまたはmacOS
- Pi
- Node.js 22.19以降
- 次のいずれかの録音コマンド
  - Linux：PipeWire環境の `pw-record`、またはALSA環境の `arecord`
  - macOS：AVFoundationに対応したFFmpeg（`brew install ffmpeg`）
- 次のいずれかの文字起こしバックエンド
  - OpenAI APIキー
  - `whisper-cli` などのローカルコマンド

macOSでは、システムのデフォルト音声入力から録音します。Piを実行しているターミナルに対するマイクの使用許可をmacOSから求められる場合があります。ネイティブWindows対応は、プロセスのライフサイクルを安全に管理する設計が検証されるまで、[ロードマップ](./TODO.md)に記載されています。

## インストールと初期設定

1. [必要条件](#必要条件)に記載された録音コマンドのいずれかをインストールします。
2. npmからPi Dictationをインストールします。

   ```bash
   pi install npm:pi-dictation
   ```

3. 文字起こしバックエンドを設定します。OpenAIを使う場合は、Piを起動する前にAPIキーを設定します。

   ```bash
   export OPENAI_API_KEY=...
   ```

   認証情報管理ツールからAPIキーを取得する場合は、[OpenAI文字起こしの設定](#openai文字起こしの設定)を参照してください。音声を自分のマシン内だけで処理する場合は、[ローカル文字起こしコマンドの設定](#ローカル文字起こしコマンドの設定)を参照してください。

4. Piを再起動するか `/reload` を実行します。
5. `/dictate-config` を実行し、Recorderと設定を確認します。MacのキーボードにはInsertキーがないことが多いため、macOSではショートカットを `f8` に変更し、もう一度 `/reload` を実行します。

## 使い方

設定したショートカット（デフォルトは `Insert`）を押すと録音を開始します。もう一度押すと録音を停止し、文字起こしを始めます。macOSでファンクションキー列がメディア操作に割り当てられている場合、`f8` のショートカットには `fn+F8` を使います。

録音中は、エディターの上に1行のDictationステータスが表示されます。点滅する録音マーカー、直近のマイク入力レベル、経過時間を確認できます。同じ領域に処理中、文字起こし中、完了、キャンセル、失敗の状態も表示され、その後自動的に消えます。入力レベルは、PCM16モノラルWAVを出力する録音コマンドで利用できます。この形式を出力するカスタム録音コマンドにも対応します。不完全な出力や未対応の出力では、実際にはない音声活動を表示せず、無音を示す平坦な線を表示します。

コマンド：

- `/dictate` — 録音を開始または停止
- `/dictate-cancel` — 録音または文字起こしをキャンセル
- `/dictate-config` — ローカル録音と設定済みのBridge録音を非破壊的に切り替え、安全な設定を編集し、機密情報を表示しない可用性・バックエンド状態を確認
- `/dictate-doctor` — 秘密情報やカスタムコマンドを表示せずに、設定、Recorderの可用性、文字起こしバックエンドを診断
- `/dictate-help` — 現在選択されているRecorderと文字起こしバックエンドを表示

## セットアップの診断

録音や文字起こしが動作しない場合は、Piで `/dictate-doctor` を実行してください。Node.js、Pi、LinuxまたはmacOSの対応状況、設定の妥当性、Recorderの可用性、文字起こしバックエンド、OpenAIの認証情報ソースが設定されているかを確認します。APIキー取得コマンドは実行せず、カスタムコマンドや秘密の値も表示しません。

## OpenAI文字起こしの設定

Pi Dictationの文字起こし用認証情報は、Piのモデルプロバイダー用ログインとは別です。`/login` を実行したことやOpenAIまたはChatGPTモデルを利用できることだけでは、音声文字起こしは設定されません。このバックエンドを使う前に、`OPENAI_API_KEY` または `openaiApiKeyCommand` を設定してください。

APIキーをより安全に保存するには、`openaiApiKeyCommand` を使って認証情報管理ツールから取得できます。標準出力にAPIキーだけを出力する、信頼できる非対話コマンドを使用してください。

`secret-tool` と、起動してロック解除されたSecret ServiceキーチェーンがあるLinuxデスクトップの場合：

```bash
secret-tool store --label="Pi Dictation OpenAI key" service openai account pi-dictation
```

```json
{
  "$schema": "https://raw.githubusercontent.com/yasuhito/pi-dictation/main/pi-dictation.schema.json",
  "language": "ja",
  "openaiModel": "gpt-4o-mini-transcribe",
  "openaiApiKeyCommand": "secret-tool lookup service openai account pi-dictation"
}
```

ヘッドレス環境やSSHだけで利用するLinuxホストでは、Secret Serviceを利用できないことがよくあります。その場合は、環境変数でAPIキーを渡すか、別の非対話型の認証情報管理コマンドを使用してください。

macOSのキーチェーンを使う場合（キーは対話的に入力するため、シェル履歴に残りません）：

```bash
security add-generic-password -a "$USER" -s pi-dictation-openai -U -w
```

```json
{
  "$schema": "https://raw.githubusercontent.com/yasuhito/pi-dictation/main/pi-dictation.schema.json",
  "shortcut": "f8",
  "language": "ja",
  "openaiModel": "gpt-4o-mini-transcribe",
  "openaiApiKeyCommand": "security find-generic-password -a \"$USER\" -s pi-dictation-openai -w"
}
```

このバックエンドを使うと、設定されたOpenAI互換エンドポイントへ音声が送信されます。

## ローカル文字起こしコマンドの設定

コマンドには、`{file}` を通してWAVファイルのパスが渡されます。

```json
{
  "$schema": "https://raw.githubusercontent.com/yasuhito/pi-dictation/main/pi-dictation.schema.json",
  "language": "ja",
  "transcribeCommand": "whisper-cli -m ~/models/ggml-small.bin -f {file} -l ja -otxt -of -"
}
```

コマンドは、標準出力に文字起こしだけを出力する必要があります。

## 設定

`/dictate-config` を実行すると、ローカル録音またはBridge録音を選択し、ショートカット、言語、OpenAIモデル、時間制限、スピナーを編集できます。ショートカットの変更には `/reload` または再起動が必要です。それ以外の変更は、次の録音から反映されます。

`/dictate-config` にない項目は、`~/.pi/agent/pi-dictation.json` を編集します。[`pi-dictation.example.json`](./pi-dictation.example.json) には、エディターの入力補完と検証に使えるJSON Schemaが含まれています。

| フィールド | デフォルト | 用途 |
| --- | --- | --- |
| `shortcut` | `insert` | 音声入力を切り替えるPiショートカット |
| `language` | 未設定 | OpenAIバックエンドに渡す言語 |
| `recorders` | `{ "selected": "local" }` | ローカル録音またはBridge録音を選択し、必要に応じてローカル録音コマンドを設定 |
| `transcribeCommand` | 未設定 | ローカル文字起こしコマンド |
| `openaiModel` | `gpt-4o-mini-transcribe` | OpenAI互換の文字起こしモデル |
| `openaiBaseUrl` | `https://api.openai.com/v1` | OpenAI互換APIのベースURL |
| `openaiApiKey` | 未設定 | 非公開の設定ファイルに平文で保存されるAPIキー。環境変数または認証情報管理コマンドを推奨 |
| `openaiApiKeyCommand` | 未設定 | APIキーを出力するコマンド |
| `timeoutMs` | `120000` | 文字起こしのタイムアウト。`1000`〜`3600000` ミリ秒 |
| `maxRecordingMs` | `600000` | 最大録音時間。`1000`〜`3600000` ミリ秒 |
| `spinner` | `arc` | `cli-spinners` のアニメーション名 |

`OPENAI_API_KEY` だけは環境変数で設定でき、`openaiApiKey` より優先されます。それ以外の設定には設定ファイルを使用します。

## SSH Bridgeを使う

SSH Bridgeを使うと、Piを実行しているホストとは別のMacに接続されたマイクを利用できます。たとえば、PiはリモートのLinuxホストで実行し、手元のMacから録音できます。

> **対応状況：** Pi Dictation `0.6.0` は、macOS `26.5.1 (25F80)` を搭載したApple M1 Pro MacBook Pro（`MacBookPro18,3`）で動作検証済みです。Intel Mac、ネイティブWindows、ループバック以外のリスナー、自動TCPフォールバック、パッケージとプロトコルのバージョン不一致、合格した検証記録がないmacOSバージョンはサポートされません。完全な対応範囲と現行リリースに適用される例外については、[Bridge録音の対応範囲と検証](./docs/bridge-recording-support.md)を参照してください。

Bridge CLIは、MacとPiホストの両方でシェルから実行できる必要があります。両方のホストに同じバージョンのパッケージをグローバルインストールしてください。

```bash
npm install --global pi-dictation@0.6.0
```

マイクを接続したMacで、ネイティブコンパニオンをインストールし、事前確認を行います。続いて、Piホストへの接続に普段使っているSSHエイリアスにBridgeをインストールします。

```bash
pi-dictation bridge install
pi-dictation bridge preflight
pi-dictation bridge install my-pi
pi-dictation bridge status my-pi
```

Bridgeのインストールには、非対話のSSH `BatchMode` 認証と、両方のホストで一致するPi Dictationパッケージおよびプロトコルのバージョンが必要です。インストールによってBridge Recorderプロファイルは追加されますが、自動的には選択されません。リモートホストのPiで `/dictate-config` を実行し、Bridge録音を選択してください。

主なメンテナンスコマンド：

```bash
pi-dictation bridge list
pi-dictation bridge doctor
pi-dictation bridge logs my-pi
pi-dictation bridge repair my-pi          # preview
pi-dictation bridge repair my-pi --confirm
pi-dictation bridge rotate my-pi
pi-dictation bridge revoke my-pi           # preview
pi-dictation bridge uninstall my-pi        # preview
```

`repair`、`revoke`、`uninstall` は、`--confirm` を要求する前に影響をプレビューします。安定したJSONインターフェースとして保証されるのは `list` と `doctor` だけです。認証情報の扱い、復旧、TCPフォールバック、アップグレード、アンインストール、保持期間、型付きエラー、リリース検証については、[Bridge録音の対応範囲と検証](./docs/bridge-recording-support.md)を参照してください。

### Bridgeのスモークテスト

1. Macで `pi-dictation bridge status my-pi` を実行し、トンネル、リスナー、認証済みヘルスがreadyと表示されることを確認します。
2. `my-pi` 上のPiで `/dictate-config` を実行し、Bridge録音を選択して保存します。
3. `/dictate` を実行し、Macのマイクに向かって判別できるフレーズを話してから、もう一度 `/dictate` を実行します。
4. 話したフレーズがPiに挿入されることを確認します。

## 開発

```bash
npm install
npm run check
npm run pack:check
```

## ライセンス

MIT
