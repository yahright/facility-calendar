# 施設利用カレンダー

月の施設利用回数（例: 20日）をあらかじめ決めておき、カレンダーの日をタップして利用ON/OFFを切り替え、合計を目標に合わせるためのアプリです。
サーバー不要の静的サイト（PWA）で、スマホのブラウザから開いてホーム画面に追加できます。

- ログインなしでも、祝日付きの日付カレンダーとしてそのまま使えます（祝日は計算で表示）。
- 「Google の予定を取り込む」を押した人だけ、自分の Google カレンダーの予定（複数カレンダー対応）が各日に重なります。
- 選んだ日は端末のブラウザに保存されます。Google ログイン時は Google ドライブのアプリ専用領域にも保存され、スマホと PC で同じ状態になります。
- 予定を読むだけで、Google カレンダーの内容は変更しません。

## ファイル

| ファイル | 役割 |
|---|---|
| `index.html` / `styles.css` / `app.js` | アプリ本体 |
| `config.js` | 公開者が設定する値（Google の clientId など） |
| `manifest.webmanifest` / `sw.js` / `icons/` | PWA（ホーム画面追加）用 |
| `artifact/` | 旧版（claude.ai アーティファクト版）。参考用 |

## 公開手順

### 1. ホスティング（GitHub Pages の例）

```bash
git init && git add -A && git commit -m "施設利用カレンダー"
gh repo create facility-calendar --public --source=. --push
gh api -X POST repos/{owner}/facility-calendar/pages -f build_type=legacy -f 'source[branch]=main' -f 'source[path]=/'
```

数分後に `https://<GitHubユーザー名>.github.io/facility-calendar/` で開けます。
この時点で「日付だけのカレンダー」としては完成です。Google の予定取り込みを使わないなら、以下は不要です。

### 2. Google の予定取り込みを使う場合（公開者が一度だけ行う）

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作る。
2. 「API とサービス」→「ライブラリ」で次を有効にする。
   - **Google Calendar API**
   - **Google Drive API**（端末間同期を使う場合。`config.js` の `driveSync` を `false` にすれば不要）
3. 「OAuth 同意画面」を設定する。
   - ユーザーの種類: **外部**
   - アプリ名・サポートメール・デベロッパー連絡先を入力
   - スコープに `.../auth/calendar.readonly` と `.../auth/drive.appdata` を追加
4. 「認証情報」→「認証情報を作成」→「OAuth クライアント ID」→ 種類は **ウェブ アプリケーション**。
   - 「承認済みの JavaScript 生成元」に公開 URL のオリジンを追加（例: `https://<ユーザー名>.github.io`）。ローカル確認用に `http://localhost:8765` も追加。
   - リダイレクト URI は不要。
5. できたクライアント ID を `config.js` の `clientId` に貼り、コミットして push。

### 3. 「誰でも」使えるようにするときの注意（Google 側の制限）

- 同意画面が **テスト** 状態のままだと、「テストユーザー」に登録した Google アカウント（最大100人）しかログインできません。
- **本番** に切り替えると誰でもログインできますが、カレンダー読み取りは Google の「機密スコープ」なので、**Google の審査（アプリ確認）** を通すまでは「このアプリは Google で確認されていません」という警告画面が出ます。「詳細」→「（安全ではないページ）に移動」で進めますが、利用者は100人までに制限されます。
- 審査にはプライバシーポリシーのページ、アプリのホームページ、使い方の説明（動画）が必要で、数日〜数週間かかります。家族や知人など限られた人数なら、テストユーザー登録か「警告画面を進んでもらう」運用で十分です。

## ローカルで確認する

```bash
python3 -m http.server 8765
```

`http://localhost:8765/` を開きます。Google ログインは `https` か `localhost` でしか動きません。

## データの保存場所

- 端末: ブラウザの localStorage（`fc:data:<Googleアカウント or local>`）。ログイン前に選んだ分は、初回ログイン時にそのアカウントへ引き継がれます。
- Google ドライブ: アプリ専用領域（appDataFolder）の `facility-calendar.json`。ドライブ画面には表示されず、このアプリからしか読めません。端末ごとの変更は月単位で「新しい方が勝つ」でマージします。
