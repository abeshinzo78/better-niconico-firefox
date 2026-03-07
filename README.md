# Better Niconico Firefox

[Chrome版はこちら](https://github.com/kongyo2/better-niconico)

ニコニコ動画のレイアウトと細部を改善する firefox 拡張機能です。(開発中) 

現在は本家better-niconicoのWebGPUを使い高解像度化する機能以外実装しています。

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/abeshinzo78/better-niconico-firefox)

ユーザーが各機能を個別にオン/オフできるカスタマイズ可能な拡張機能として設計されています。

## インストール方法

[Release](https://github.com/abeshinzo78/better-niconico-firefox/releases/tag/v1.0.13)より最新版のxpiをダウンロードするだけです。

### 開発版のインストール
### 開発版のインストール
1. このリポジトリをクローン
   ``` bash
   git clone https://github.com/abeshinzo78/better-niconico-firefox.git
   cd better-niconico-firefox
   ```
2. 依存関係をインストール
   ```bash
   npm install
   ```
3. ビルド
   ```bash
   npm run build
   ```
4. ブラウザで拡張機能を読み込む
   
`about:debugging#/runtime/this-firefox` を開き、「一時的なアドオンを読み込む」から `dist/manifest.json` を選択。


## 使い方

1. 拡張機能アイコンをクリックして設定画面を開く
2. 各機能のトグルスイッチで好みの設定にカスタマイズ
3. 設定は自動的に保存され、即座に反映されます

## 主な機能

- **プレミアム会員セクションを非表示** - 広告セクションを非表示
- **TV放送中のアニメセクションを非表示** - TVアニメセクションを非表示
- **動画情報を上部に表示** - クラシックレイアウトを復元
- **サイドバーにニコランボタンを表示** - nico-rank.comへのリンクを追加
- **プロフィールアイコンを四角型に変更** - 丸型から角丸四角型に
- **サポーターボタンを非表示** - クリエイターサポートボタンを非表示
- **ニコニ広告セクションを非表示** - 動画下部の広告セクションを非表示
- **Picture-in-Picture機能** - 動画とコメントをPiP表示（別の小さい画面にした後にPIPができるボタンがあるのでそれを押すとできます）
- **動画スクリーンショット機能** - 現在のフレーム（コメント付き）を画像保存
- **通報フォーム入力補助** - 通報フォームへの定型文自動入力
- **シネマティックライティング** - 動画の色をプレイヤー周囲にグロー表示（アンビエントモード）
- **大百科リンクの復元** - タグの横にニコニコ大百科へのリンクを表示

## 謝辞

このFirefox版は [kongyo2/better-niconico](https://github.com/kongyo2/better-niconico) をベースに作成しました。オリジナルのChrome版を開発してくださった kongyo2 氏に感謝します。
